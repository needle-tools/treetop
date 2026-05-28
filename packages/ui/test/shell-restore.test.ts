import { test, expect, describe } from "bun:test";
import {
  attachedShellTermId,
  mergeLiveShells,
  mergePersistedTerminals,
  restoreTermId,
  type LiveShell,
  type OpenSessionRef,
  type PersistedTerminalEntry,
} from "../src/shell-restore";

const WT = "C:\\git\\supergit";
const OTHER_WT = "C:\\git\\other";

describe("attachedShellTermId / restoreTermId", () => {
  test("attachedShellTermId extracts termId from __attached__:shell:<id>", () => {
    expect(attachedShellTermId("__attached__:shell:t_abc")).toBe("t_abc");
  });
  test("attachedShellTermId returns null for non-attached sources", () => {
    expect(attachedShellTermId("__restore__:t_abc")).toBeNull();
    expect(attachedShellTermId("__new__:shell:t_abc")).toBeNull();
    expect(attachedShellTermId("__transcript__:shell:t_abc")).toBeNull();
    expect(attachedShellTermId("plain")).toBeNull();
  });
  test("restoreTermId extracts termId from __restore__:<id>", () => {
    expect(restoreTermId("__restore__:t_abc")).toBe("t_abc");
    expect(restoreTermId("__attached__:shell:t_abc")).toBeNull();
  });
});

describe("mergeLiveShells", () => {
  test("adds an attached column for a newly-alive shell", () => {
    const result = mergeLiveShells(
      { [WT]: [] },
      [{ termId: "t1", wt: WT, alive: true }],
      new Set(),
    );
    expect(result[WT]).toEqual([
      { agent: "shell", source: "__attached__:shell:t1" },
    ]);
  });

  test("drops a stale attached column whose termId is no longer alive", () => {
    const start: Record<string, OpenSessionRef[]> = {
      [WT]: [{ agent: "shell", source: "__attached__:shell:t_dead" }],
    };
    const result = mergeLiveShells(start, [], new Set());
    expect(result[WT]).toEqual([]);
  });

  test("skips a shell whose source the user has dismissed", () => {
    const result = mergeLiveShells(
      { [WT]: [] },
      [{ termId: "t1", wt: WT, alive: true }],
      new Set(["__attached__:shell:t1"]),
    );
    expect(result[WT] ?? []).toEqual([]);
  });

  test("does not double-add an already-present attached column", () => {
    const start: Record<string, OpenSessionRef[]> = {
      [WT]: [{ agent: "shell", source: "__attached__:shell:t1" }],
    };
    const result = mergeLiveShells(
      start,
      [{ termId: "t1", wt: WT, alive: true }],
      new Set(),
    );
    expect(result[WT]).toHaveLength(1);
  });

  test("leaves non-shell columns alone", () => {
    const start: Record<string, OpenSessionRef[]> = {
      [WT]: [
        { agent: "claude", source: "__new__:claude:t_xyz" },
        { agent: "shell", source: "__attached__:shell:t_dead" },
      ],
    };
    const result = mergeLiveShells(start, [], new Set());
    expect(result[WT]).toEqual([
      { agent: "claude", source: "__new__:claude:t_xyz" },
    ]);
  });
});

describe("mergePersistedTerminals", () => {
  test("adds a __restore__ card for each persisted entry", () => {
    const persisted: PersistedTerminalEntry[] = [
      {
        termId: "t1",
        cmd: ["cmd.exe"],
        cwd: WT,
        wtPath: WT,
      },
    ];
    const result = mergePersistedTerminals({ [WT]: [] }, persisted);
    expect(result[WT]).toEqual([
      { agent: "shell", source: "__restore__:t1" },
    ]);
  });

  test("two distinct persisted PTYs produce two restore cards (matches user's screenshot)", () => {
    const persisted: PersistedTerminalEntry[] = [
      {
        termId: "t_npm",
        cmd: ["cmd.exe", "/c", "npm run dev"],
        cwd: WT,
        wtPath: WT,
        title: "npm run dev",
        firstCmd: "npm run dev",
        lastCmd: "npm run dev",
      },
      {
        termId: "t_cmd",
        cmd: ["C:\\WINDOWS\\system32\\cmd.exe"],
        cwd: WT,
        wtPath: WT,
      },
    ];
    const result = mergePersistedTerminals({ [WT]: [] }, persisted);
    expect(result[WT]).toHaveLength(2);
    expect(result[WT]!.map((s) => s.source)).toEqual([
      "__restore__:t_cmd",
      "__restore__:t_npm",
    ]);
  });

  test("BUG REPRO: live shell + persisted entry for SAME termId must yield only one column", () => {
    // Scenario: user reloads the UI but the daemon kept running. The
    // alive PTY T1 is still in /api/shells AND still in
    // active-terminals.json (it's only removed on PTY exit). Before
    // the dedup fix, the user saw both a live attached column AND a
    // "disconnected — Resume" card for the same termId.
    const liveShells: LiveShell[] = [{ termId: "t1", wt: WT, alive: true }];
    const persisted: PersistedTerminalEntry[] = [
      {
        termId: "t1",
        cmd: ["cmd.exe"],
        cwd: WT,
        wtPath: WT,
        title: "Terminal",
      },
    ];

    const afterLive = mergeLiveShells({ [WT]: [] }, liveShells, new Set());
    const final = mergePersistedTerminals(afterLive, persisted);

    expect(final[WT]).toHaveLength(1);
    expect(final[WT]![0]!.source).toBe("__attached__:shell:t1");
  });

  test("alive PTY in one worktree + dead persisted in another → 1 attached + 1 restore", () => {
    // Mixed case: T1 is alive in WT, T2 is a leftover persisted entry
    // from a previous daemon lifetime in OTHER_WT.
    const liveShells: LiveShell[] = [{ termId: "t1", wt: WT, alive: true }];
    const persisted: PersistedTerminalEntry[] = [
      { termId: "t1", cmd: ["cmd.exe"], cwd: WT, wtPath: WT },
      { termId: "t2", cmd: ["bash"], cwd: OTHER_WT, wtPath: OTHER_WT },
    ];

    const afterLive = mergeLiveShells({}, liveShells, new Set());
    const final = mergePersistedTerminals(afterLive, persisted);

    expect(final[WT]).toEqual([
      { agent: "shell", source: "__attached__:shell:t1" },
    ]);
    expect(final[OTHER_WT]).toEqual([
      { agent: "shell", source: "__restore__:t2" },
    ]);
  });

  test("idempotent: re-running over an already-merged map is a no-op", () => {
    const persisted: PersistedTerminalEntry[] = [
      { termId: "t1", cmd: ["cmd.exe"], cwd: WT, wtPath: WT },
    ];
    const once = mergePersistedTerminals({ [WT]: [] }, persisted);
    const twice = mergePersistedTerminals(once, persisted);
    expect(twice[WT]).toHaveLength(1);
  });

  test("empty persisted list is a no-op (preserves input identity)", () => {
    const input = { [WT]: [{ agent: "shell" as const, source: "__attached__:shell:t1" }] };
    const result = mergePersistedTerminals(input, []);
    expect(result).toBe(input);
  });
});
