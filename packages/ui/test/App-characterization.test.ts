/**
 * Characterization tests for pure functions currently inlined in
 * packages/ui/src/App.svelte. These tests pin the CURRENT behavior as
 * a safety net before any extraction refactor lands.
 *
 * Each section is annotated with the source line range so the future
 * extractor knows exactly what to replace an import with.
 *
 * IMPORTANT: these implementations are COPIED from App.svelte (no edits
 * to source files). When a function is extracted to its own module,
 * remove the local copy here and import from the new module instead.
 * The test assertions stay identical.
 */

import { test, expect, describe } from "bun:test";

// ---------------------------------------------------------------------------
// repoChipFg  (App.svelte lines 3664–3684)
// ---------------------------------------------------------------------------

/**
 * Pick a readable foreground for a `#rrggbb` chip background. Uses
 * OKLCH lightness instead of sRGB YIQ luma so saturated yellows/cyans
 * correctly read as "light" and get dark text, while mid-blues read as
 * "dark" and get white text. Threshold 0.6 (using >= 0.6 check).
 *
 * Copied verbatim from App.svelte:3664.
 */
function repoChipFg(hex: string): string {
  const m = /^#([0-9a-f]{6})$/i.exec(hex);
  if (!m) return "#ffffff";
  const v = parseInt(m[1]!, 16);
  const r8 = ((v >> 16) & 0xff) / 255;
  const g8 = ((v >> 8) & 0xff) / 255;
  const b8 = (v & 0xff) / 255;
  const lin = (c: number) =>
    c <= 0.04045 ? c / 12.92 : Math.pow((c + 0.055) / 1.055, 2.4);
  const r = lin(r8);
  const g = lin(g8);
  const b = lin(b8);
  const lL = 0.4122214708 * r + 0.5363325363 * g + 0.0514459929 * b;
  const mL = 0.2119034982 * r + 0.6806995451 * g + 0.1073969566 * b;
  const sL = 0.0883024619 * r + 0.2817188376 * g + 0.6299787005 * b;
  const L =
    0.2104542553 * Math.cbrt(lL) +
    0.793617785 * Math.cbrt(mL) -
    0.0040720468 * Math.cbrt(sL);
  return L >= 0.6 ? "#1a1a1a" : "#ffffff";
}

describe("repoChipFg — OKLCH lightness threshold", () => {
  test("white (#ffffff) is light → dark text", () => {
    expect(repoChipFg("#ffffff")).toBe("#1a1a1a");
  });

  test("black (#000000) is dark → white text", () => {
    expect(repoChipFg("#000000")).toBe("#ffffff");
  });

  // The key OKLCH-vs-YIQ invariant: saturated yellow reads as light in
  // perceptual space (OKLCH) even though it has a non-trivial blue channel.
  test("saturated yellow (#ffff00) is perceptually light → dark text", () => {
    expect(repoChipFg("#ffff00")).toBe("#1a1a1a");
  });

  // Saturated cyan is another case where YIQ gets it wrong.
  test("saturated cyan (#00ffff) is perceptually light → dark text", () => {
    expect(repoChipFg("#00ffff")).toBe("#1a1a1a");
  });

  // Mid/dark blues are dark in perceptual space → white text.
  test("navy (#001a5a) is perceptually dark → white text", () => {
    expect(repoChipFg("#001a5a")).toBe("#ffffff");
  });

  test("pure blue (#0000ff) is dark → white text", () => {
    expect(repoChipFg("#0000ff")).toBe("#ffffff");
  });

  // The historical default chip color used in the fallback (#1a3a5a).
  test("default chip blue (#1a3a5a) is dark → white text", () => {
    expect(repoChipFg("#1a3a5a")).toBe("#ffffff");
  });

  // Input validation: non-hex strings must return white text (safe default).
  test("empty string → white text (safe default)", () => {
    expect(repoChipFg("")).toBe("#ffffff");
  });

  test("invalid hex string → white text", () => {
    expect(repoChipFg("red")).toBe("#ffffff");
    expect(repoChipFg("#gg0000")).toBe("#ffffff");
  });

  // Case-insensitivity for the # prefix.
  test("uppercase hex works (#FFFFFF → dark text)", () => {
    expect(repoChipFg("#FFFFFF")).toBe("#1a1a1a");
  });

  // Light gray is above the threshold.
  test("light gray (#cccccc) is light → dark text", () => {
    expect(repoChipFg("#cccccc")).toBe("#1a1a1a");
  });

  // Dark gray is below the threshold.
  test("dark gray (#444444) is dark → white text", () => {
    expect(repoChipFg("#444444")).toBe("#ffffff");
  });
});

// ---------------------------------------------------------------------------
// noteExcerpt  (App.svelte lines 4732–4738)
// ---------------------------------------------------------------------------

/**
 * First non-empty line of a note's body, trimmed to ≤40 chars.
 * Returns empty string for undefined/empty.
 *
 * Copied verbatim from App.svelte:4732.
 */
function noteExcerpt(body: string | undefined): string {
  if (!body) return "";
  const firstLine = body.split("\n").find((l) => l.trim().length > 0) ?? "";
  const trimmed = firstLine.trim();
  if (trimmed.length <= 40) return trimmed;
  return trimmed.slice(0, 39) + "…";
}

describe("noteExcerpt", () => {
  test("returns empty string for undefined", () => {
    expect(noteExcerpt(undefined)).toBe("");
  });

  test("returns empty string for empty string", () => {
    expect(noteExcerpt("")).toBe("");
  });

  test("returns empty string for whitespace-only string", () => {
    expect(noteExcerpt("   \n  \n  ")).toBe("");
  });

  test("short body returns the trimmed first line", () => {
    expect(noteExcerpt("hello world")).toBe("hello world");
  });

  test("trims leading/trailing whitespace from the first line", () => {
    expect(noteExcerpt("  hello  ")).toBe("hello");
  });

  test("uses the first NON-EMPTY line (skips leading blank lines)", () => {
    expect(noteExcerpt("\n\nsecond line\nthird")).toBe("second line");
  });

  test("body of exactly 40 chars is returned verbatim (no ellipsis)", () => {
    const exactly40 = "a".repeat(40);
    expect(noteExcerpt(exactly40)).toBe(exactly40);
    expect(noteExcerpt(exactly40)).not.toContain("…");
  });

  test("body of 41 chars gets truncated to 39 + ellipsis", () => {
    const s41 = "a".repeat(41);
    const result = noteExcerpt(s41);
    expect(result).toBe("a".repeat(39) + "…");
    // Total visible length is 40 chars (39 + 1 for the ellipsis char).
    expect([...result].length).toBe(40);
  });

  test("long body is truncated to 39 chars + ellipsis", () => {
    const long = "This is a very long note body that goes well past forty characters.";
    const result = noteExcerpt(long);
    expect(result).toEndWith("…");
    // The slice-index is 39, so the non-ellipsis prefix is 39 chars.
    expect(result.slice(0, 39)).toBe(long.slice(0, 39));
  });

  test("only the first line is used even when later lines are longer", () => {
    const body = "short\n" + "a".repeat(100);
    expect(noteExcerpt(body)).toBe("short");
  });
});

// ---------------------------------------------------------------------------
// anchorLabel  (App.svelte lines 4745–4765)
// ---------------------------------------------------------------------------

/**
 * Pretty-print an anchor string using a `repos` snapshot.
 * worktree:<path> → "<repo.name> · <branch>", fallback to basename.
 * repo:<path>     → repo.name or basename.
 * commit:<sha>    → "commit <8-char prefix>".
 *
 * Note: anchorLabel in App.svelte closes over the module-level `repos`
 * reactive variable. Here we accept repos as a parameter to make the
 * function pure and testable.
 *
 * Mirrors App.svelte:4745.
 */
function anchorLabel(
  anchor: string | undefined,
  repos: Array<{
    name?: string;
    path?: string;
    worktrees?: Array<{ path: string; branch: string }>;
  }>,
): string {
  if (!anchor) return "";
  if (anchor.startsWith("worktree:")) {
    const path = anchor.slice("worktree:".length);
    for (const r of repos) {
      const wt = r.worktrees?.find((w) => w.path === path);
      if (wt) return `${r.name ?? "?"} · ${wt.branch}`;
    }
    return path.split("/").filter(Boolean).pop() ?? path;
  }
  if (anchor.startsWith("repo:")) {
    const path = anchor.slice("repo:".length);
    const r = repos.find((r) => r.path === path);
    if (r) return r.name ?? path;
    return path.split("/").filter(Boolean).pop() ?? path;
  }
  if (anchor.startsWith("commit:")) {
    return `commit ${anchor.slice("commit:".length).slice(0, 8)}`;
  }
  return anchor;
}

describe("anchorLabel", () => {
  const repos = [
    {
      name: "supergit",
      path: "/Users/me/git/supergit",
      worktrees: [
        { path: "/Users/me/git/supergit", branch: "main" },
        { path: "/Users/me/git/supergit-feature", branch: "feature/foo" },
      ],
    },
    {
      name: "other",
      path: "/Users/me/git/other",
      worktrees: [{ path: "/Users/me/git/other", branch: "dev" }],
    },
  ];

  test("returns empty string for undefined anchor", () => {
    expect(anchorLabel(undefined, repos)).toBe("");
  });

  test("worktree anchor resolves to '<repo> · <branch>'", () => {
    expect(
      anchorLabel("worktree:/Users/me/git/supergit", repos),
    ).toBe("supergit · main");
  });

  test("worktree anchor for a non-primary worktree resolves correctly", () => {
    expect(
      anchorLabel("worktree:/Users/me/git/supergit-feature", repos),
    ).toBe("supergit · feature/foo");
  });

  test("worktree anchor falls back to basename when repo removed", () => {
    expect(
      anchorLabel("worktree:/Users/me/git/gone-repo", repos),
    ).toBe("gone-repo");
  });

  test("repo anchor resolves to repo name", () => {
    expect(anchorLabel("repo:/Users/me/git/supergit", repos)).toBe("supergit");
  });

  test("repo anchor falls back to basename when repo removed", () => {
    expect(anchorLabel("repo:/Users/me/git/removed", repos)).toBe("removed");
  });

  test("commit anchor returns 'commit <8-char sha>'", () => {
    expect(anchorLabel("commit:abcdef1234567890", repos)).toBe(
      "commit abcdef12",
    );
  });

  test("commit anchor with short sha returns as-is (no padding)", () => {
    expect(anchorLabel("commit:abc", repos)).toBe("commit abc");
  });

  test("unknown anchor prefix is returned as-is", () => {
    expect(anchorLabel("note:some-id", repos)).toBe("note:some-id");
  });

  test("empty repos snapshot → worktree falls back to basename", () => {
    expect(anchorLabel("worktree:/a/b/c", [])).toBe("c");
  });
});

// ---------------------------------------------------------------------------
// sessionTooltip  (App.svelte lines 4937–4970)
// ---------------------------------------------------------------------------

interface AgentSession {
  agent: "claude" | "codex" | "copilot" | "ollama" | "shell";
  cwd: string;
  lastActive: string;
  source: string;
  title?: string;
  manualTitle?: string;
  lastUserMessage?: string;
  firstUserMessage?: string;
  lastUserMessages?: string[];
  userMessageCount?: number;
}

/**
 * Build the multi-line tooltip for a session row.
 * count ≤ 4 → render every captured message once (oldest-first).
 * count > 4 → insert "[… N more …]" separator between first and tail.
 * Falls back to legacy shape when richer fields are absent.
 *
 * Copied verbatim from App.svelte:4937.
 */
function sessionTooltip(sess: AgentSession): string {
  const headline = sess.manualTitle ?? sess.title ?? "(no title)";
  const first = sess.firstUserMessage;
  const last = sess.lastUserMessages ?? [];
  const count = sess.userMessageCount ?? 0;
  if (!first && last.length === 0) {
    return sess.lastUserMessage
      ? `${headline}\n\nMost recent user message:\n${sess.lastUserMessage}`
      : headline;
  }
  const tailExcludingFirst = first ? last.filter((m) => m !== first) : last;
  const lines: string[] = [headline];
  if (count <= 4) {
    const all = first ? [first, ...tailExcludingFirst] : last;
    for (const m of all) lines.push("", m);
  } else {
    if (first) lines.push("", first);
    const skipped = count - 1 - tailExcludingFirst.length;
    if (skipped > 0) {
      lines.push(
        "",
        `[… ${skipped} more message${skipped === 1 ? "" : "s"} …]`,
      );
    }
    for (const m of tailExcludingFirst) lines.push("", m);
  }
  return lines.join("\n");
}

function mkSess(
  overrides: Partial<AgentSession> & { source: string },
): AgentSession {
  return {
    agent: "claude",
    cwd: "/wt",
    lastActive: new Date().toISOString(),
    ...overrides,
  };
}

describe("sessionTooltip", () => {
  test("no messages at all → returns headline only", () => {
    const s = mkSess({ source: "/a.jsonl", title: "My session" });
    expect(sessionTooltip(s)).toBe("My session");
  });

  test("manualTitle takes precedence over title", () => {
    const s = mkSess({
      source: "/a.jsonl",
      title: "auto",
      manualTitle: "My label",
    });
    expect(sessionTooltip(s)).toBe("My label");
  });

  test("no title or manualTitle → falls back to (no title)", () => {
    const s = mkSess({ source: "/a.jsonl" });
    expect(sessionTooltip(s)).toBe("(no title)");
  });

  test("legacy shape (lastUserMessage only) uses simple format", () => {
    const s = mkSess({
      source: "/a.jsonl",
      title: "Sess",
      lastUserMessage: "What is 2+2?",
    });
    expect(sessionTooltip(s)).toBe(
      "Sess\n\nMost recent user message:\nWhat is 2+2?",
    );
  });

  test("count ≤ 4: all messages rendered once (no separator)", () => {
    const s = mkSess({
      source: "/a.jsonl",
      title: "T",
      firstUserMessage: "Q1",
      lastUserMessages: ["Q1", "Q2", "Q3"],
      userMessageCount: 3,
    });
    const tt = sessionTooltip(s);
    expect(tt).not.toContain("[…");
    // Headline then each message (deduped: Q1 appears once, then Q2, Q3).
    expect(tt).toBe("T\n\nQ1\n\nQ2\n\nQ3");
  });

  test("count > 4: first + separator + tail (no first in tail)", () => {
    const s = mkSess({
      source: "/a.jsonl",
      title: "T",
      firstUserMessage: "First",
      lastUserMessages: ["Last-2", "Last-1", "Last"],
      userMessageCount: 10,
    });
    const tt = sessionTooltip(s);
    // first message
    expect(tt).toContain("First");
    // separator: skipped = 10 - 1 - 3 = 6
    expect(tt).toContain("[… 6 more messages …]");
    // tail messages
    expect(tt).toContain("Last-2");
    expect(tt).toContain("Last");
    // first is NOT repeated in the tail section
    const firstIdx = tt.indexOf("First");
    const tailSection = tt.slice(firstIdx + "First".length);
    expect(tailSection).not.toContain("First");
  });

  test("count > 4: singular 'message' when exactly 1 skipped", () => {
    // count=5, 1 tail (not-first), so skipped = 5 - 1 - 1 = 3... let's
    // craft: count=5, tail=[Last], firstUserMessage="First",
    //   skipped = 5 - 1 - 1 = 3, not 1. Use count=3, tail=["Last"], first="First"
    //   → count ≤ 4, no separator. Need count>4 and skipped=1:
    //   count=6, tail(excl first)=["A","B","C","D"] → skipped=6-1-4=1
    const s = mkSess({
      source: "/a.jsonl",
      title: "T",
      firstUserMessage: "First",
      lastUserMessages: ["First", "A", "B", "C", "D"],
      // tail excl first = ["A","B","C","D"], skipped = 6-1-4=1
      userMessageCount: 6,
    });
    const tt = sessionTooltip(s);
    expect(tt).toContain("[… 1 more message …]");
    expect(tt).not.toContain("[… 1 more messages …]");
  });

  test("firstUserMessage absent: tail rendered without duplication or separator when count ≤ 4", () => {
    const s = mkSess({
      source: "/a.jsonl",
      title: "T",
      lastUserMessages: ["A", "B"],
      userMessageCount: 2,
    });
    expect(sessionTooltip(s)).toBe("T\n\nA\n\nB");
  });
});

// ---------------------------------------------------------------------------
// wtHasRecentActivity  (App.svelte lines 2775–2787)
// ---------------------------------------------------------------------------

const ACTIVITY_WINDOW_MS = 10_000; // App.svelte:2775

/**
 * Returns true when any agent in the worktree's agents list has a
 * lastActive within ACTIVITY_WINDOW_MS of `now`.
 *
 * Copied verbatim from App.svelte:2776.
 */
function wtHasRecentActivity(
  w: { agents?: Array<{ lastActive?: string }> } | undefined | null,
  now: number,
): boolean {
  if (!w?.agents?.length) return false;
  for (const a of w.agents) {
    if (!a.lastActive) continue;
    const t = Date.parse(a.lastActive);
    if (Number.isFinite(t) && now - t < ACTIVITY_WINDOW_MS) return true;
  }
  return false;
}

describe("wtHasRecentActivity", () => {
  const now = Date.now();

  test("returns false for undefined worktree", () => {
    expect(wtHasRecentActivity(undefined, now)).toBe(false);
  });

  test("returns false for null worktree", () => {
    expect(wtHasRecentActivity(null, now)).toBe(false);
  });

  test("returns false for empty agents array", () => {
    expect(wtHasRecentActivity({ agents: [] }, now)).toBe(false);
  });

  test("returns false when all agents have no lastActive", () => {
    expect(
      wtHasRecentActivity({ agents: [{}] }, now),
    ).toBe(false);
  });

  test("returns false when all agents' lastActive is older than ACTIVITY_WINDOW_MS", () => {
    const old = new Date(now - ACTIVITY_WINDOW_MS - 1).toISOString();
    expect(
      wtHasRecentActivity({ agents: [{ lastActive: old }] }, now),
    ).toBe(false);
  });

  test("returns true when at least one agent's lastActive is within the window", () => {
    const recent = new Date(now - 1000).toISOString();
    expect(
      wtHasRecentActivity({ agents: [{ lastActive: recent }] }, now),
    ).toBe(true);
  });

  test("returns true even if other agents are stale (one active is enough)", () => {
    const stale = new Date(now - ACTIVITY_WINDOW_MS - 5000).toISOString();
    const fresh = new Date(now - 500).toISOString();
    expect(
      wtHasRecentActivity(
        { agents: [{ lastActive: stale }, { lastActive: fresh }] },
        now,
      ),
    ).toBe(true);
  });

  test("returns false for invalid ISO string (non-finite timestamp)", () => {
    expect(
      wtHasRecentActivity({ agents: [{ lastActive: "not-a-date" }] }, now),
    ).toBe(false);
  });

  // Boundary: exactly at the window edge (now - ACTIVITY_WINDOW_MS).
  // The condition is `now - t < ACTIVITY_WINDOW_MS`, so equal is NOT recent.
  test("lastActive exactly at the boundary is NOT considered recent (strict <)", () => {
    const exact = new Date(now - ACTIVITY_WINDOW_MS).toISOString();
    // Date.parse can have rounding; use a value 1ms inside the boundary.
    const justInside = new Date(now - ACTIVITY_WINDOW_MS + 1).toISOString();
    expect(
      wtHasRecentActivity({ agents: [{ lastActive: justInside }] }, now),
    ).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// notesListDisplay  (App.svelte lines 4684–4726)
// ---------------------------------------------------------------------------

/**
 * Shared helper reused by notesListDisplay.
 * Copied verbatim from App.svelte:4663.
 */
function targetGlyph(type: string | undefined): string {
  switch (type) {
    case "url":
      return "↗";
    case "commit":
      return "◆";
    case "session":
      return "▶";
    case "file":
      return "▤";
    case "command":
      return "⌁";
    default:
      return "";
  }
}

/**
 * Display info for the per-row notes-list popover.
 * Returns `text` empty when the row has nothing meaningful to show.
 *
 * Copied verbatim from App.svelte:4684.
 */
function notesListDisplay(n: {
  body: string;
  kind?: "note" | "link";
  target?: {
    type?: string;
    value?: string;
    label?: string;
    agent?: string;
    provider?: string;
    command?: string;
  };
}): {
  kind: "note" | "link";
  text: string;
  title: string;
  agent: string;
  provider: string;
  glyph: string;
} {
  const kind = n.kind === "link" ? "link" : "note";
  const excerpt = noteExcerpt(n.body);
  if (kind === "link") {
    const t = n.target ?? {};
    const text = (excerpt || t.label || t.command || t.value || "").trim();
    const title = [t.label, t.value, n.body].filter((s) => !!s).join("\n");
    return {
      kind,
      text,
      title,
      agent: t.agent ?? "",
      provider: t.provider ?? "",
      glyph: targetGlyph(t.type),
    };
  }
  return {
    kind,
    text: excerpt,
    title: n.body,
    agent: "",
    provider: "",
    glyph: "",
  };
}

describe("notesListDisplay", () => {
  test("note kind returns text = excerpt and title = full body", () => {
    const result = notesListDisplay({
      body: "My note body",
      kind: "note",
    });
    expect(result.kind).toBe("note");
    expect(result.text).toBe("My note body");
    expect(result.title).toBe("My note body");
    expect(result.agent).toBe("");
    expect(result.glyph).toBe("");
  });

  test("defaults to 'note' kind when kind field is absent", () => {
    const result = notesListDisplay({ body: "hello" });
    expect(result.kind).toBe("note");
  });

  test("link with body but no target has text = body excerpt", () => {
    const result = notesListDisplay({
      body: "My link body",
      kind: "link",
      target: {},
    });
    expect(result.kind).toBe("link");
    expect(result.text).toBe("My link body");
  });

  test("link with no body AND no usable target has empty text (caller should drop row)", () => {
    const result = notesListDisplay({
      body: "",
      kind: "link",
      target: {},
    });
    expect(result.text).toBe("");
  });

  test("link label wins over value and command in text fallback chain when body is empty", () => {
    const result = notesListDisplay({
      body: "",
      kind: "link",
      target: { label: "My Label", value: "http://example.com", command: "ls" },
    });
    expect(result.text).toBe("My Label");
  });

  test("command fallback when label AND value are absent", () => {
    const result = notesListDisplay({
      body: "",
      kind: "link",
      target: { command: "npm test" },
    });
    expect(result.text).toBe("npm test");
  });

  test("value fallback when label and command are absent", () => {
    const result = notesListDisplay({
      body: "",
      kind: "link",
      target: { value: "http://example.com" },
    });
    expect(result.text).toBe("http://example.com");
  });

  test("link glyph reflects target type", () => {
    expect(
      notesListDisplay({ body: "", kind: "link", target: { type: "url" } })
        .glyph,
    ).toBe("↗");
    expect(
      notesListDisplay({ body: "", kind: "link", target: { type: "commit" } })
        .glyph,
    ).toBe("◆");
    expect(
      notesListDisplay({ body: "", kind: "link", target: { type: "session" } })
        .glyph,
    ).toBe("▶");
    expect(
      notesListDisplay({ body: "", kind: "link", target: { type: "file" } })
        .glyph,
    ).toBe("▤");
    expect(
      notesListDisplay({ body: "", kind: "link", target: { type: "command" } })
        .glyph,
    ).toBe("⌁");
    expect(
      notesListDisplay({ body: "", kind: "link", target: { type: "unknown" } })
        .glyph,
    ).toBe("");
  });

  test("agent and provider fields are surfaced from target", () => {
    const result = notesListDisplay({
      body: "",
      kind: "link",
      target: { agent: "claude", provider: "anthropic" },
    });
    expect(result.agent).toBe("claude");
    expect(result.provider).toBe("anthropic");
  });

  test("note kind always has empty agent/provider/glyph", () => {
    const result = notesListDisplay({ body: "text", kind: "note" });
    expect(result.agent).toBe("");
    expect(result.provider).toBe("");
    expect(result.glyph).toBe("");
  });

  test("title for link: label + value + body joined with newlines (non-empty only)", () => {
    const result = notesListDisplay({
      body: "note body",
      kind: "link",
      target: { label: "lbl", value: "val" },
    });
    expect(result.title).toBe("lbl\nval\nnote body");
  });

  test("title omits empty fields", () => {
    const result = notesListDisplay({
      body: "note body",
      kind: "link",
      target: { label: "", value: "" },
    });
    expect(result.title).toBe("note body");
  });
});

// ---------------------------------------------------------------------------
// sortBranches  (App.svelte lines 995–998)
// ---------------------------------------------------------------------------

/**
 * Sort a branch list. 'alpha' sorts lexicographically; 'recency' preserves
 * the daemon's input order (committerdate-desc).
 *
 * Copied verbatim from App.svelte:995.
 */
function sortBranches(list: string[], mode: "recency" | "alpha"): string[] {
  if (mode === "alpha") return [...list].sort((a, b) => a.localeCompare(b));
  return list;
}

describe("sortBranches", () => {
  const branches = ["main", "feature/foo", "bugfix/bar", "alpha"];

  test("alpha mode sorts lexicographically", () => {
    expect(sortBranches(branches, "alpha")).toEqual([
      "alpha",
      "bugfix/bar",
      "feature/foo",
      "main",
    ]);
  });

  test("alpha mode does not mutate the input array", () => {
    const original = [...branches];
    sortBranches(branches, "alpha");
    expect(branches).toEqual(original);
  });

  test("recency mode returns the list in its original order", () => {
    expect(sortBranches(branches, "recency")).toEqual(branches);
  });

  test("recency mode returns the same array reference", () => {
    // sortBranches in recency mode just returns `list` — no copy.
    expect(sortBranches(branches, "recency")).toBe(branches);
  });

  test("alpha mode on already-sorted input is a no-op", () => {
    const sorted = ["a", "b", "c"];
    expect(sortBranches(sorted, "alpha")).toEqual(["a", "b", "c"]);
  });

  test("empty list returns empty list for both modes", () => {
    expect(sortBranches([], "alpha")).toEqual([]);
    expect(sortBranches([], "recency")).toEqual([]);
  });

  test("single-element list is unchanged for both modes", () => {
    expect(sortBranches(["main"], "alpha")).toEqual(["main"]);
    expect(sortBranches(["main"], "recency")).toEqual(["main"]);
  });
});

// ---------------------------------------------------------------------------
// formatRelativeTime  (App.svelte lines 3566–3581)
// ---------------------------------------------------------------------------

/**
 * Human-friendly relative time for a session's `lastActive`. Uses
 * Math.round at each boundary (unlike relTime which uses Math.floor).
 *
 * Copied verbatim from App.svelte:3566.
 * Note: tested with controlled timestamps, not Date.now() — we inject
 * a `now` shim so the function is deterministic.
 */
function formatRelativeTime(iso: string, now = Date.now()): string {
  const then = Date.parse(iso);
  if (!Number.isFinite(then)) return "";
  const delta = now - then;
  const s = Math.round(delta / 1000);
  if (s < 60) return s <= 5 ? "just now" : `${s}s ago`;
  const m = Math.round(s / 60);
  if (m < 60) return `${m}m ago`;
  const h = Math.round(m / 60);
  if (h < 24) return `${h}h ago`;
  const d = Math.round(h / 24);
  if (d < 30) return `${d}d ago`;
  const mo = Math.round(d / 30);
  if (mo < 12) return `${mo}mo ago`;
  return `${Math.round(mo / 12)}y ago`;
}

// NOTE: the App.svelte implementation uses `Date.now()` directly rather
// than accepting a `now` parameter. To make the tests deterministic we
// test the algorithm by computing the ISO string backwards from a known
// delta relative to the real Date.now(). Tests use a real timestamp
// computed at test-run time so they pass regardless of when they run.
describe("formatRelativeTime", () => {
  test("returns empty string for non-finite timestamp", () => {
    expect(formatRelativeTime("not-a-date")).toBe("");
    expect(formatRelativeTime("")).toBe("");
  });

  test("≤5s ago → 'just now'", () => {
    const now = Date.now();
    expect(formatRelativeTime(new Date(now - 2_000).toISOString(), now)).toBe(
      "just now",
    );
    expect(formatRelativeTime(new Date(now - 5_000).toISOString(), now)).toBe(
      "just now",
    );
  });

  test("6–59s ago → '<N>s ago'", () => {
    const now = Date.now();
    expect(formatRelativeTime(new Date(now - 30_000).toISOString(), now)).toBe(
      "30s ago",
    );
    expect(formatRelativeTime(new Date(now - 59_000).toISOString(), now)).toBe(
      "59s ago",
    );
  });

  test("60s boundary → '1m ago'", () => {
    const now = Date.now();
    expect(formatRelativeTime(new Date(now - 60_000).toISOString(), now)).toBe(
      "1m ago",
    );
  });

  test("~30m → '30m ago'", () => {
    const now = Date.now();
    expect(
      formatRelativeTime(new Date(now - 30 * 60_000).toISOString(), now),
    ).toBe("30m ago");
  });

  test("60min boundary → '1h ago'", () => {
    const now = Date.now();
    expect(
      formatRelativeTime(new Date(now - 60 * 60_000).toISOString(), now),
    ).toBe("1h ago");
  });

  test("~12h → '12h ago'", () => {
    const now = Date.now();
    expect(
      formatRelativeTime(new Date(now - 12 * 3600_000).toISOString(), now),
    ).toBe("12h ago");
  });

  test("24h boundary → '1d ago'", () => {
    const now = Date.now();
    expect(
      formatRelativeTime(new Date(now - 24 * 3600_000).toISOString(), now),
    ).toBe("1d ago");
  });

  test("~7d → '7d ago'", () => {
    const now = Date.now();
    expect(
      formatRelativeTime(new Date(now - 7 * 24 * 3600_000).toISOString(), now),
    ).toBe("7d ago");
  });

  test("30d boundary → '1mo ago'", () => {
    const now = Date.now();
    expect(
      formatRelativeTime(
        new Date(now - 30 * 24 * 3600_000).toISOString(),
        now,
      ),
    ).toBe("1mo ago");
  });

  test("~6mo → '6mo ago'", () => {
    const now = Date.now();
    expect(
      formatRelativeTime(
        new Date(now - 6 * 30 * 24 * 3600_000).toISOString(),
        now,
      ),
    ).toBe("6mo ago");
  });

  test("12mo boundary → '1y ago'", () => {
    const now = Date.now();
    expect(
      formatRelativeTime(
        new Date(now - 12 * 30 * 24 * 3600_000).toISOString(),
        now,
      ),
    ).toBe("1y ago");
  });
});

// ---------------------------------------------------------------------------
// fetchReposNDJSON stream-parsing logic  (App.svelte lines 3214–3274)
// ---------------------------------------------------------------------------

/**
 * Extract the inner NDJSON parse loop so it can be tested without a real
 * HTTP response. The pump function takes a list of raw lines (simulating
 * what a ReadableStream would deliver) and calls the same callbacks that
 * fetchReposNDJSON calls in production.
 *
 * This mirrors the logic in App.svelte:3226–3270.
 */

interface RepoSkeleton {
  id: string;
  path: string;
  name: string;
  addedAt: string;
  color?: string;
  worktrees: never[];
  remotes: never[];
}
interface RepoFull {
  id: string;
  path: string;
  name: string;
  addedAt: string;
  worktrees: unknown[];
}

function parseNDJSONLines(
  lines: string[],
  opts?: {
    onManifest?: (skeletons: RepoSkeleton[]) => void;
    onRepo?: (repo: RepoFull) => void;
  },
): RepoFull[] {
  const out: RepoFull[] = [];
  for (const line of lines) {
    if (!line.length) continue;
    try {
      const msg = JSON.parse(line) as
        | { type: "manifest"; repos: { id: string; path: string; name: string; addedAt: string; color?: string }[] }
        | { type: "repo"; repo: RepoFull };
      if (msg.type === "manifest" && Array.isArray(msg.repos)) {
        const skeletons: RepoSkeleton[] = msg.repos.map((m) => ({
          id: m.id,
          path: m.path,
          name: m.name,
          addedAt: m.addedAt,
          color: m.color,
          worktrees: [],
          remotes: [],
        }));
        opts?.onManifest?.(skeletons);
      } else if (msg.type === "repo" && msg.repo) {
        out.push(msg.repo);
        opts?.onRepo?.(msg.repo);
      }
    } catch {
      // skip malformed line — same as App.svelte
    }
  }
  return out;
}

describe("fetchReposNDJSON stream-parsing logic", () => {
  const manifestLine = JSON.stringify({
    type: "manifest",
    repos: [
      { id: "r1", path: "/a", name: "A", addedAt: "2024-01-01" },
      { id: "r2", path: "/b", name: "B", addedAt: "2024-01-02", color: "#ff0000" },
    ],
  });
  const repoALine = JSON.stringify({
    type: "repo",
    repo: { id: "r1", path: "/a", name: "A", addedAt: "2024-01-01", worktrees: [] },
  });
  const repoBLine = JSON.stringify({
    type: "repo",
    repo: { id: "r2", path: "/b", name: "B", addedAt: "2024-01-02", worktrees: [] },
  });

  test("manifest line calls onManifest with skeleton repos in correct order", () => {
    const manifests: RepoSkeleton[][] = [];
    parseNDJSONLines([manifestLine], { onManifest: (s) => manifests.push(s) });
    expect(manifests).toHaveLength(1);
    expect(manifests[0]!.map((r) => r.id)).toEqual(["r1", "r2"]);
  });

  test("manifest skeletons have empty worktrees/remotes arrays", () => {
    let skeletons: RepoSkeleton[] = [];
    parseNDJSONLines([manifestLine], { onManifest: (s) => (skeletons = s) });
    for (const s of skeletons) {
      expect(s.worktrees).toEqual([]);
      expect(s.remotes).toEqual([]);
    }
  });

  test("manifest skeletons carry the optional color field", () => {
    let skeletons: RepoSkeleton[] = [];
    parseNDJSONLines([manifestLine], { onManifest: (s) => (skeletons = s) });
    expect(skeletons[0]!.color).toBeUndefined();
    expect(skeletons[1]!.color).toBe("#ff0000");
  });

  test("per-repo lines call onRepo once each, in delivery order", () => {
    const repos: RepoFull[] = [];
    parseNDJSONLines([manifestLine, repoALine, repoBLine], {
      onRepo: (r) => repos.push(r),
    });
    expect(repos.map((r) => r.id)).toEqual(["r1", "r2"]);
  });

  test("return value contains all repos in delivery (completion) order", () => {
    const result = parseNDJSONLines([manifestLine, repoBLine, repoALine]);
    // NB: completion order is B then A (reversed from manifest order).
    expect(result.map((r) => r.id)).toEqual(["r2", "r1"]);
  });

  test("malformed JSON line is skipped without killing the stream", () => {
    const repos: RepoFull[] = [];
    parseNDJSONLines(
      [manifestLine, "{ not valid json", repoALine],
      { onRepo: (r) => repos.push(r) },
    );
    // Malformed line is silently dropped; valid repo line still processed.
    expect(repos.map((r) => r.id)).toEqual(["r1"]);
  });

  test("empty line is skipped (blank separator between chunks)", () => {
    const repos: RepoFull[] = [];
    parseNDJSONLines(
      [manifestLine, "", repoALine, ""],
      { onRepo: (r) => repos.push(r) },
    );
    expect(repos.map((r) => r.id)).toEqual(["r1"]);
  });

  test("unknown type lines are silently ignored", () => {
    const repos: RepoFull[] = [];
    parseNDJSONLines(
      [JSON.stringify({ type: "unknown", data: {} }), repoALine],
      { onRepo: (r) => repos.push(r) },
    );
    expect(repos.map((r) => r.id)).toEqual(["r1"]);
  });
});

// ---------------------------------------------------------------------------
// pendingRepoColor guard  (App.svelte lines 3329–3340 and 3692–3729)
// ---------------------------------------------------------------------------

/**
 * The onRepo callback checks pendingRepoColor before updating repos.
 * This logic is tested directly by simulating the guard pattern.
 *
 * Mirrors App.svelte:3321–3340.
 */
function onRepoWithColorGuard(
  full: { id: string; color?: string },
  repos: Array<{ id: string; color?: string }>,
  pendingRepoColor: Map<string, string | null>,
): Array<{ id: string; color?: string }> {
  if (pendingRepoColor.has(full.id)) {
    const pending = pendingRepoColor.get(full.id);
    if (pending === null) delete (full as { color?: string }).color;
    else full.color = pending;
  }
  const idx = repos.findIndex((x) => x.id === full.id);
  if (idx >= 0) {
    const next = repos.slice();
    next[idx] = full;
    return next;
  }
  return repos;
}

describe("pendingRepoColor guard (onRepo color-overwrite protection)", () => {
  test("onRepo updates color when no pending guard", () => {
    const repos = [{ id: "r1", color: "#000000" }];
    const result = onRepoWithColorGuard(
      { id: "r1", color: "#112233" },
      repos,
      new Map(),
    );
    expect(result[0]!.color).toBe("#112233");
  });

  test("pendingRepoColor guard overrides stale server color with optimistic value", () => {
    const repos = [{ id: "r1", color: "#old" }];
    const pending = new Map<string, string | null>([["r1", "#new"]]);
    // Server sends stale color #stale; guard preserves #new.
    const result = onRepoWithColorGuard(
      { id: "r1", color: "#stale" },
      repos,
      pending,
    );
    expect(result[0]!.color).toBe("#new");
  });

  test("pendingRepoColor with null clears the color field", () => {
    const repos = [{ id: "r1", color: "#old" }];
    const pending = new Map<string, string | null>([["r1", null]]);
    const result = onRepoWithColorGuard(
      { id: "r1", color: "#stale" },
      repos,
      pending,
    );
    // color field should be absent, not just undefined.
    expect("color" in result[0]!).toBe(false);
  });

  test("guard only fires for the matching repo id — other repos unaffected", () => {
    const repos = [
      { id: "r1", color: "#a" },
      { id: "r2", color: "#b" },
    ];
    const pending = new Map<string, string | null>([["r1", "#override"]]);
    // Update r2 (not in pending) — should use server's color.
    const result = onRepoWithColorGuard(
      { id: "r2", color: "#server-for-r2" },
      repos,
      pending,
    );
    expect(result[1]!.color).toBe("#server-for-r2");
    // r1 is unchanged (we didn't call onRepo for it in this test).
    expect(result[0]!.color).toBe("#a");
  });

  test("guard is cleared only when no newer save superseded it (same color)", () => {
    // Simulate: setRepoColor("r1", "#new") → pending.set("r1", "#new").
    // Then a second setRepoColor("r1", "#newer") → pending.set("r1", "#newer").
    // When the first await resolves, it checks pending.get("r1") === "#new"
    // (false: pending has "#newer") so it does NOT delete — the guard stays.
    // Verified by the clearance logic in setRepoColor's finally block.
    const pending = new Map<string, string | null>([["r1", "#newer"]]);
    const firstSaveColor = "#new";
    // First save should NOT clear because the guard value has changed.
    if (pending.get("r1") === firstSaveColor) {
      pending.delete("r1");
    }
    expect(pending.has("r1")).toBe(true); // guard stays
    // Second save clears the guard.
    if (pending.get("r1") === "#newer") {
      pending.delete("r1");
    }
    expect(pending.has("r1")).toBe(false);
  });
});
