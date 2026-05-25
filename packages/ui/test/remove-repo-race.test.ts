/**
 * Regression test for the "removed repo reappears" bug.
 *
 * Scenario: an fs_change triggers load() → NDJSON stream starts with
 * repos [A, B]. Before that stream finishes, the user removes repo B.
 * removeRepo() calls load() but singleFlight coalesces it with the
 * in-flight load. The stale stream delivers onManifest([A, B]) and
 * onRepo(B) — without a guard, B reappears in a broken state because
 * the workspace no longer tracks it.
 *
 * Fix: a `pendingRemoval` Set (same pattern as `pendingRepoColor`)
 * that onManifest / onRepo check before touching `repos`.
 */

import { test, expect, describe } from "bun:test";
import { singleFlight } from "../src/single-flight";

interface FakeRepo {
  id: string;
  name: string;
  enriched?: boolean;
}

describe("removeRepo race with stale in-flight NDJSON stream", () => {
  test("pendingRemoval guard prevents stale stream from re-adding a removed repo", async () => {
    const pendingRemoval = new Set<string>();
    let repos: FakeRepo[] = [
      { id: "a", name: "A", enriched: true },
      { id: "b", name: "B", enriched: true },
    ];

    function onManifest(skel: FakeRepo[]) {
      const filtered = pendingRemoval.size > 0
        ? skel.filter((s) => !pendingRemoval.has(s.id))
        : skel;
      const existingById = new Map(repos.map((r) => [r.id, r]));
      repos = filtered.map((s) => existingById.get(s.id) ?? s);
    }

    function onRepo(full: FakeRepo) {
      if (pendingRemoval.has(full.id)) return;
      const idx = repos.findIndex((x) => x.id === full.id);
      if (idx >= 0) {
        const next = repos.slice();
        next[idx] = full;
        repos = next;
      }
    }

    // --- Simulate the race ---

    // Stale manifest arrives (from a load started before deletion)
    // — includes B because workspace.listRepos() was called pre-delete
    const staleManifest: FakeRepo[] = [
      { id: "a", name: "A" },
      { id: "b", name: "B" },
    ];

    // User deletes B: optimistic removal + guard
    pendingRemoval.add("b");
    repos = repos.filter((r) => r.id !== "b");
    expect(repos.map((r) => r.id)).toEqual(["a"]);

    // Stale manifest delivers [A, B] — B must be filtered
    onManifest(staleManifest);
    expect(repos.map((r) => r.id)).toEqual(["a"]);

    // Stale enriched B arrives — must be skipped
    onRepo({ id: "b", name: "B", enriched: true });
    expect(repos.map((r) => r.id)).toEqual(["a"]);

    // Stale enriched A arrives — should update normally
    onRepo({ id: "a", name: "A", enriched: true });
    expect(repos).toEqual([{ id: "a", name: "A", enriched: true }]);

    // Guard cleared after DELETE + load round-trip
    pendingRemoval.delete("b");
    expect(repos.map((r) => r.id)).toEqual(["a"]);
  });

  test("singleFlight coalescing is the root cause: without guard, stale load re-adds repo", async () => {
    let repos: FakeRepo[] = [
      { id: "a", name: "A", enriched: true },
      { id: "b", name: "B", enriched: true },
    ];

    // Model the OLD behavior (no pendingRemoval, onRepo has else branch)
    function onManifestOld(skel: FakeRepo[]) {
      const existingById = new Map(repos.map((r) => [r.id, r]));
      repos = skel.map((s) => existingById.get(s.id) ?? s);
    }

    function onRepoOld(full: FakeRepo) {
      const idx = repos.findIndex((x) => x.id === full.id);
      if (idx >= 0) {
        const next = repos.slice();
        next[idx] = full;
        repos = next;
      } else {
        repos = [...repos, full]; // old behavior: re-adds deleted repo!
      }
    }

    let resolveStaleLoad!: () => void;
    const staleLoadDone = new Promise<void>((res) => { resolveStaleLoad = res; });

    const load = singleFlight(async () => {
      await staleLoadDone;
      // Simulate stale NDJSON stream that includes B
      onManifestOld([{ id: "a", name: "A" }, { id: "b", name: "B" }]);
      onRepoOld({ id: "a", name: "A", enriched: true });
      onRepoOld({ id: "b", name: "B", enriched: true });
    });

    // 1. fs_change triggers a load (slow, still enriching)
    const flight1 = load();

    // 2. User removes B, calls load() — singleFlight coalesces
    repos = repos.filter((r) => r.id !== "b");
    const flight2 = load();
    expect(flight1).toBe(flight2); // same promise — coalesced

    // 3. Stale load finishes: delivers [A, B]
    resolveStaleLoad();
    await flight2;

    // BUG: B is back because the stale stream re-added it
    expect(repos.map((r) => r.id)).toContain("b");
  });

  test("with guard, singleFlight coalescing is harmless", async () => {
    const pendingRemoval = new Set<string>();
    let repos: FakeRepo[] = [
      { id: "a", name: "A", enriched: true },
      { id: "b", name: "B", enriched: true },
    ];

    function onManifest(skel: FakeRepo[]) {
      const filtered = pendingRemoval.size > 0
        ? skel.filter((s) => !pendingRemoval.has(s.id))
        : skel;
      const existingById = new Map(repos.map((r) => [r.id, r]));
      repos = filtered.map((s) => existingById.get(s.id) ?? s);
    }

    function onRepo(full: FakeRepo) {
      if (pendingRemoval.has(full.id)) return;
      const idx = repos.findIndex((x) => x.id === full.id);
      if (idx >= 0) {
        const next = repos.slice();
        next[idx] = full;
        repos = next;
      }
    }

    let resolveStaleLoad!: () => void;
    const staleLoadDone = new Promise<void>((res) => { resolveStaleLoad = res; });

    const load = singleFlight(async () => {
      await staleLoadDone;
      onManifest([{ id: "a", name: "A" }, { id: "b", name: "B" }]);
      onRepo({ id: "a", name: "A", enriched: true });
      onRepo({ id: "b", name: "B", enriched: true });
    });

    // 1. fs_change triggers load (slow)
    const flight1 = load();

    // 2. User removes B — guard + optimistic removal
    pendingRemoval.add("b");
    repos = repos.filter((r) => r.id !== "b");
    const flight2 = load();
    expect(flight1).toBe(flight2); // coalesced

    // 3. Stale load finishes
    resolveStaleLoad();
    await flight2;

    // B stays gone thanks to the guard
    expect(repos.map((r) => r.id)).toEqual(["a"]);
    expect(repos).toEqual([{ id: "a", name: "A", enriched: true }]);

    // 4. Guard cleared
    pendingRemoval.delete("b");

    // 5. Fresh load (post-deletion, correct manifest)
    const staleLoadDone2 = Promise.resolve();
    // singleFlight cleared after flight1 resolved, so next call starts fresh
    // No need for another staleLoadDone — just verify state is clean
    expect(repos.map((r) => r.id)).toEqual(["a"]);
  });
});
