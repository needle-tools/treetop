/**
 * WebGL terminal renderer pool (plans/performance.md "Layerize storm
 * during typing", lever 2).
 *
 * xterm's DOM renderer adds/removes row <span>/#text nodes on every
 * keystroke — that structural churn is THE per-keystroke Layerize
 * trigger (54%→22% after `contain`, the rest goes away only by not
 * mutating the DOM at all). The WebGL renderer re-rasters inside one
 * composited canvas: zero DOM churn, no Layerize trigger.
 *
 * Why a pool: browsers cap live WebGL contexts at ~16 per page and
 * supergit mounts dozens of terminal columns. So contexts are a
 * managed resource: visible terminals acquire a slot (up to MAX),
 * hidden/destroyed ones release it, and anything that can't get one —
 * cap reached, WebGL unavailable, context evicted by the browser —
 * falls back to the DOM renderer (which keeps `contain: layout paint`).
 *
 * The pool is pure (addon factory injected) so it's testable without
 * DOM/GL; the wiring tests below pin TerminalView's integration at the
 * source level, same approach as terminal-view-mount.test.ts.
 */
import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { createWebglPool } from "../src/terminal-webgl";

interface FakeAddon {
  dispose(): void;
  onContextLoss(listener: () => void): void;
  disposed: boolean;
  loseContext(): void;
}

function makeFakeAddon(): FakeAddon {
  let listener: (() => void) | null = null;
  const addon: FakeAddon = {
    disposed: false,
    dispose() {
      addon.disposed = true;
    },
    onContextLoss(l: () => void) {
      listener = l;
    },
    loseContext() {
      listener?.();
    },
  };
  return addon;
}

function makeTerm(opts: { loadThrows?: boolean } = {}) {
  const loaded: unknown[] = [];
  return {
    loaded,
    loadAddon(addon: unknown) {
      if (opts.loadThrows) throw new Error("WebGL2 not supported");
      loaded.push(addon);
    },
  };
}

describe("createWebglPool", () => {
  test("attaches the addon and reports the slot as used", () => {
    const created: FakeAddon[] = [];
    const pool = createWebglPool(2, () => {
      const a = makeFakeAddon();
      created.push(a);
      return a;
    });
    const term = makeTerm();
    const handle = pool.tryAttach(term);
    expect(handle).not.toBeNull();
    expect(handle!.active).toBe(true);
    expect(pool.inUse()).toBe(1);
    expect(term.loaded).toEqual([created[0]]);
  });

  test("returns null once the cap is reached; a release frees the slot", () => {
    const pool = createWebglPool(2, makeFakeAddon);
    const h1 = pool.tryAttach(makeTerm());
    const h2 = pool.tryAttach(makeTerm());
    expect(h1).not.toBeNull();
    expect(h2).not.toBeNull();
    expect(pool.tryAttach(makeTerm())).toBeNull();
    h1!.dispose();
    expect(pool.inUse()).toBe(1);
    expect(pool.tryAttach(makeTerm())).not.toBeNull();
  });

  test("dispose is idempotent — the slot is released exactly once", () => {
    const pool = createWebglPool(1, makeFakeAddon);
    const h = pool.tryAttach(makeTerm())!;
    h.dispose();
    h.dispose();
    expect(pool.inUse()).toBe(0);
    expect(h.active).toBe(false);
  });

  test("dispose disposes the underlying addon", () => {
    let addon: FakeAddon | null = null;
    const pool = createWebglPool(1, () => (addon = makeFakeAddon()));
    pool.tryAttach(makeTerm())!.dispose();
    expect(addon!.disposed).toBe(true);
  });

  test("loadAddon throwing (no WebGL2) → null, no slot leak, addon cleaned up", () => {
    let addon: FakeAddon | null = null;
    const pool = createWebglPool(1, () => (addon = makeFakeAddon()));
    expect(pool.tryAttach(makeTerm({ loadThrows: true }))).toBeNull();
    expect(pool.inUse()).toBe(0);
    expect(addon!.disposed).toBe(true);
    // The slot must still be usable by the next terminal.
    expect(pool.tryAttach(makeTerm())).not.toBeNull();
  });

  test("browser context loss self-disposes: slot freed, handle inactive", () => {
    let addon: FakeAddon | null = null;
    const pool = createWebglPool(1, () => (addon = makeFakeAddon()));
    const h = pool.tryAttach(makeTerm())!;
    addon!.loseContext();
    expect(h.active).toBe(false);
    expect(pool.inUse()).toBe(0);
    expect(addon!.disposed).toBe(true);
  });
});

describe("TerminalView wires the pool to visibility", () => {
  const SOURCE = readFileSync(
    join(import.meta.dir, "../src/TerminalView.svelte"),
    "utf-8",
  );

  test("imports the shared pool", () => {
    expect(SOURCE).toContain('from "./terminal-webgl"');
  });

  /** The IntersectionObserver follows visibility, but the renderer SWITCH is
   *  deferred to a scroll-gated reconcile so a scroll that drags columns across
   *  the viewport (a dock click scrolls the strip) doesn't thrash
   *  attach→detach→attach, each a renderRows storm. Slice from the observer
   *  construction to its observe() call. */
  function observerBlock(): string {
    const start = SOURCE.indexOf("visibilityObs = new IntersectionObserver");
    expect(start, "visibility observer not found").toBeGreaterThan(-1);
    const end = SOURCE.indexOf("visibilityObs.observe", start);
    expect(end, "observe() call not found").toBeGreaterThan(start);
    return SOURCE.slice(start, end);
  }

  test("observer defers the renderer switch to scheduleWebglReconcile (not inline)", () => {
    const block = observerBlock();
    expect(block).toContain("scheduleWebglReconcile(visible)");
    // The expensive switch must NOT happen inline in the observer anymore —
    // that's what regressed scrolling (200ms+ renderRows per column-crossing).
    expect(block).not.toContain("attachWebgl()");
    expect(block).not.toContain("detachWebgl()");
  });

  test("the reconcile owns attach/detach, gated on scroll-quiescence", () => {
    const start = SOURCE.indexOf("function scheduleWebglReconcile");
    expect(start, "scheduleWebglReconcile not found").toBeGreaterThan(-1);
    const next = SOURCE.indexOf("\n  function ", start + 1);
    const body = SOURCE.slice(start, next > start ? next : start + 1400);
    expect(body).toContain("attachWebgl()");
    expect(body).toContain("detachWebgl()");
    // Deferral is keyed off the shared scroll signal, not a blind timer.
    expect(body).toContain("msSinceScroll()");
    expect(body).toContain("SCROLL_QUIET_MS");
  });

  test("onDestroy releases the WebGL slot", () => {
    const start = SOURCE.indexOf("onDestroy(");
    expect(start, "onDestroy not found").toBeGreaterThan(-1);
    const end = SOURCE.indexOf("function focusTerminal", start);
    expect(end, "focusTerminal after onDestroy not found").toBeGreaterThan(
      start,
    );
    expect(SOURCE.slice(start, end)).toContain("detachWebgl()");
  });
});
