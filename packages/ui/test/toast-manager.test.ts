/**
 * Unit tests for toast-manager.ts (domless, no timers fire for real).
 *
 * The factory is injected with fake deps:
 *   onChange  – captures the latest toast list after each mutation
 *   play      – records sound names played
 *   schedule  – records (fn, ms) calls WITHOUT running fn; returns a fake handle
 *   clear     – records which handles were cleared
 */
import { describe, it, expect, beforeEach } from "bun:test";
import { createToastManager } from "../src/toast-manager";
import type { Toast } from "../src/toast-manager";

// ---------------------------------------------------------------------------
// Fake dependency factories
// ---------------------------------------------------------------------------

function makeDeps() {
  let latestToasts: Toast[] = [];
  const sounds: string[] = [];
  let nextHandle = 1000;
  const scheduled: Array<{ fn: () => void; ms: number; handle: number }> = [];
  const cleared: number[] = [];

  const onChange = (t: Toast[]) => {
    latestToasts = t;
  };
  const play = (name: string) => {
    sounds.push(name);
  };
  const schedule = (fn: () => void, ms: number): number => {
    const handle = nextHandle++;
    scheduled.push({ fn, ms, handle });
    return handle;
  };
  const clear = (h: number) => {
    cleared.push(h);
  };

  return {
    onChange,
    play,
    schedule,
    clear,
    get toasts() {
      return latestToasts;
    },
    sounds,
    scheduled,
    cleared,
  };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("createToastManager", () => {
  describe("addToast — basic", () => {
    it("returns -1 and does not change the list when message is empty", () => {
      const deps = makeDeps();
      const { addToast } = createToastManager(deps);

      const id = addToast({ kind: "info", message: "" });

      expect(id).toBe(-1);
      expect(deps.toasts).toHaveLength(0);
    });

    it("returns -1 for a falsy message (undefined cast as empty string)", () => {
      const deps = makeDeps();
      const { addToast } = createToastManager(deps);

      // The original guard is `if (!opts.message) return -1`
      const id = addToast({ kind: "info", message: "" });
      expect(id).toBe(-1);
    });

    it("adds the toast to the list and calls onChange", () => {
      const deps = makeDeps();
      const { addToast } = createToastManager(deps);

      addToast({ kind: "info", message: "hello" });

      expect(deps.toasts).toHaveLength(1);
      expect(deps.toasts[0].message).toBe("hello");
      expect(deps.toasts[0].kind).toBe("info");
    });

    it("returns a positive numeric id for a valid toast", () => {
      const deps = makeDeps();
      const { addToast } = createToastManager(deps);

      const id = addToast({ kind: "info", message: "hi" });
      expect(typeof id).toBe("number");
      expect(id).toBeGreaterThan(0);
    });

    it("ids increment monotonically", () => {
      const deps = makeDeps();
      const { addToast } = createToastManager(deps);

      const id1 = addToast({ kind: "info", message: "first" });
      const id2 = addToast({ kind: "info", message: "second" });
      const id3 = addToast({ kind: "error", message: "third" });

      expect(id2).toBeGreaterThan(id1);
      expect(id3).toBeGreaterThan(id2);
    });

    it("toast carries optional fields when provided", () => {
      const deps = makeDeps();
      const clickFn = () => {};
      const { addToast } = createToastManager(deps);

      addToast({
        kind: "invite",
        message: "msg",
        title: "my title",
        agent: "claude",
        messageItalic: true,
        onClick: clickFn,
        persist: true,
        silent: true,
      });

      const t = deps.toasts[0];
      expect(t.title).toBe("my title");
      expect(t.agent).toBe("claude");
      expect(t.messageItalic).toBe(true);
      expect(t.onClick).toBe(clickFn);
      expect(t.persist).toBe(true);
    });

    it("accumulates multiple toasts in order", () => {
      const deps = makeDeps();
      const { addToast } = createToastManager(deps);

      addToast({ kind: "info", message: "a" });
      addToast({ kind: "info", message: "b" });
      addToast({ kind: "info", message: "c" });

      expect(deps.toasts).toHaveLength(3);
      expect(deps.toasts.map((t) => t.message)).toEqual(["a", "b", "c"]);
    });
  });

  // ---------------------------------------------------------------------------
  // Sound behaviour
  // ---------------------------------------------------------------------------

  describe("addToast — sounds", () => {
    it("plays 'error' sound for kind=error", () => {
      const deps = makeDeps();
      const { addToast } = createToastManager(deps);
      addToast({ kind: "error", message: "boom" });
      expect(deps.sounds).toContain("error");
    });

    it("plays 'peer-session' sound for kind=invite", () => {
      const deps = makeDeps();
      const { addToast } = createToastManager(deps);
      addToast({ kind: "invite", message: "invited!" });
      expect(deps.sounds).toContain("peer-session");
    });

    it("plays 'toast-warning' sound for kind=warning", () => {
      const deps = makeDeps();
      const { addToast } = createToastManager(deps);
      addToast({ kind: "warning", message: "heads up" });
      expect(deps.sounds).toContain("toast-warning");
    });

    it("plays no sound for kind=info", () => {
      const deps = makeDeps();
      const { addToast } = createToastManager(deps);
      addToast({ kind: "info", message: "fyi" });
      expect(deps.sounds).toHaveLength(0);
    });

    it("plays no sound for kind=success", () => {
      const deps = makeDeps();
      const { addToast } = createToastManager(deps);
      addToast({ kind: "success", message: "done" });
      expect(deps.sounds).toHaveLength(0);
    });

    it("does NOT play any sound when silent:true (even for error)", () => {
      const deps = makeDeps();
      const { addToast } = createToastManager(deps);
      addToast({ kind: "error", message: "silent boom", silent: true });
      expect(deps.sounds).toHaveLength(0);
    });

    it("does NOT play any sound when silent:true (invite)", () => {
      const deps = makeDeps();
      const { addToast } = createToastManager(deps);
      addToast({ kind: "invite", message: "silent invite", silent: true });
      expect(deps.sounds).toHaveLength(0);
    });
  });

  // ---------------------------------------------------------------------------
  // Auto-dismiss (schedule / persist)
  // ---------------------------------------------------------------------------

  describe("addToast — auto-dismiss scheduling", () => {
    it("schedules a timer with ms=12000 for kind=error", () => {
      const deps = makeDeps();
      const { addToast } = createToastManager(deps);
      addToast({ kind: "error", message: "err" });
      expect(deps.scheduled).toHaveLength(1);
      expect(deps.scheduled[0].ms).toBe(12_000);
    });

    it("schedules a timer with ms=10000 for kind=warning", () => {
      const deps = makeDeps();
      const { addToast } = createToastManager(deps);
      addToast({ kind: "warning", message: "warn" });
      expect(deps.scheduled).toHaveLength(1);
      expect(deps.scheduled[0].ms).toBe(10_000);
    });

    it("schedules a timer with ms=7000 for kind=info", () => {
      const deps = makeDeps();
      const { addToast } = createToastManager(deps);
      addToast({ kind: "info", message: "info" });
      expect(deps.scheduled).toHaveLength(1);
      expect(deps.scheduled[0].ms).toBe(7_000);
    });

    it("schedules a timer with ms=7000 for kind=success", () => {
      const deps = makeDeps();
      const { addToast } = createToastManager(deps);
      addToast({ kind: "success", message: "ok" });
      expect(deps.scheduled).toHaveLength(1);
      expect(deps.scheduled[0].ms).toBe(7_000);
    });

    it("schedules a timer with ms=7000 for kind=invite (not persist by default)", () => {
      const deps = makeDeps();
      const { addToast } = createToastManager(deps);
      addToast({ kind: "invite", message: "invite" });
      expect(deps.scheduled).toHaveLength(1);
      expect(deps.scheduled[0].ms).toBe(7_000);
    });

    it("explicit ttlMs overrides the kind default", () => {
      const deps = makeDeps();
      const { addToast } = createToastManager(deps);
      addToast({ kind: "error", message: "err", ttlMs: 3_000 });
      expect(deps.scheduled[0].ms).toBe(3_000);
    });

    it("explicit ttlMs overrides warning default too", () => {
      const deps = makeDeps();
      const { addToast } = createToastManager(deps);
      addToast({ kind: "warning", message: "w", ttlMs: 5_000 });
      expect(deps.scheduled[0].ms).toBe(5_000);
    });

    it("does NOT schedule when persist:true", () => {
      const deps = makeDeps();
      const { addToast } = createToastManager(deps);
      addToast({ kind: "invite", message: "persist me", persist: true });
      expect(deps.scheduled).toHaveLength(0);
    });

    it("persist:true still adds the toast to the list", () => {
      const deps = makeDeps();
      const { addToast } = createToastManager(deps);
      addToast({ kind: "invite", message: "persist me", persist: true });
      expect(deps.toasts).toHaveLength(1);
    });
  });

  // ---------------------------------------------------------------------------
  // dismissToast
  // ---------------------------------------------------------------------------

  describe("dismissToast", () => {
    it("removes the toast from the list", () => {
      const deps = makeDeps();
      const { addToast, dismissToast } = createToastManager(deps);

      const id = addToast({ kind: "info", message: "bye" });
      expect(deps.toasts).toHaveLength(1);

      dismissToast(id);
      expect(deps.toasts).toHaveLength(0);
    });

    it("calls clear with the timer handle returned by schedule", () => {
      const deps = makeDeps();
      const { addToast, dismissToast } = createToastManager(deps);

      const id = addToast({ kind: "info", message: "bye" });
      const handle = deps.scheduled[0].handle;

      dismissToast(id);

      expect(deps.cleared).toContain(handle);
    });

    it("calls onChange after dismissal", () => {
      const deps = makeDeps();
      const { addToast, dismissToast } = createToastManager(deps);

      const id = addToast({ kind: "success", message: "done" });
      dismissToast(id);

      expect(deps.toasts).toHaveLength(0);
    });

    it("dismissing a non-existent id is a no-op (no crash)", () => {
      const deps = makeDeps();
      const { dismissToast } = createToastManager(deps);
      expect(() => dismissToast(9999)).not.toThrow();
    });

    it("dismisses only the targeted toast when multiple exist", () => {
      const deps = makeDeps();
      const { addToast, dismissToast } = createToastManager(deps);

      addToast({ kind: "info", message: "keep" });
      const id2 = addToast({ kind: "error", message: "remove" });
      addToast({ kind: "success", message: "also keep" });

      dismissToast(id2);

      expect(deps.toasts).toHaveLength(2);
      expect(deps.toasts.map((t) => t.message)).toEqual(["keep", "also keep"]);
    });

    it("does not call clear for a persist toast (no timer was set)", () => {
      const deps = makeDeps();
      const { addToast, dismissToast } = createToastManager(deps);

      const id = addToast({ kind: "invite", message: "persist", persist: true });
      dismissToast(id);

      // schedule was never called, so clear should not have been called either
      expect(deps.cleared).toHaveLength(0);
      expect(deps.toasts).toHaveLength(0);
    });
  });

  // ---------------------------------------------------------------------------
  // toasts() getter
  // ---------------------------------------------------------------------------

  describe("toasts() getter", () => {
    it("returns the current list (same as what onChange receives)", () => {
      const deps = makeDeps();
      const { addToast, toasts } = createToastManager(deps);

      addToast({ kind: "info", message: "x" });

      expect(toasts()).toHaveLength(1);
      expect(toasts()[0].message).toBe("x");
    });

    it("reflects dismissals", () => {
      const deps = makeDeps();
      const { addToast, dismissToast, toasts } = createToastManager(deps);

      const id = addToast({ kind: "info", message: "x" });
      dismissToast(id);
      expect(toasts()).toHaveLength(0);
    });
  });
});
