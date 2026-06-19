<script lang="ts">
  /** Renders the diff for a single file inside the per-row hover popup
   *  of the worktree-row "changed files" tooltip. Fetches from
   *  /api/file-diff with `context=0` so only changed lines come back —
   *  the body parses the hunk headers to recover the original/new line
   *  numbers and lays them out in a 3-col grid (old# · new# · text).
   *
   *  Diff output is a plain text stream: headers, hunks, then lines
   *  prefixed `+`, `-`, or ` ` (context). With context=0 there are no
   *  ` ` lines, so we render only `+`/`−` rows + hunk separators.
   *
   *  Failure modes: empty body when the file produced no diff (e.g.
   *  mode-only change) or when the daemon couldn't run git. We render
   *  a muted placeholder rather than a blank popup so the user knows
   *  the fetch finished. */

  import { apiUrl } from "./api";

  export let worktreePath: string;
  export let file: string;
  export let kind: "workdir" | "staged" | "untracked";
  /** Owning daemon for this worktree. Undefined ⇒ local daemon
   *  (byte-identical behaviour). Set for remote daemon folder rows. */
  export let daemonId: string | undefined = undefined;

  type Row =
    | {
        kind: "add" | "del";
        oldLn: number | null;
        newLn: number | null;
        text: string;
      }
    | { kind: "hunk"; text: string }
    | { kind: "binary"; text: string };

  let state: "loading" | "ready" | "error" = "loading";
  let rows: Row[] = [];
  let binary = false;

  /** Reactive fetch. Re-runs when any of {worktreePath, file, kind} change
   *  so the popup re-renders when the user moves between rows without
   *  the parent having to tear down the component. */
  $: void load(worktreePath, file, kind);

  async function load(wt: string, f: string, k: typeof kind): Promise<void> {
    state = "loading";
    rows = [];
    binary = false;
    try {
      const params = new URLSearchParams({
        path: wt,
        file: f,
        kind: k,
        context: "0",
      });
      const r = await fetch(apiUrl(`/api/file-diff?${params.toString()}`, daemonId));
      if (!r.ok) {
        state = "error";
        return;
      }
      const text = await r.text();
      // Capture the values we were called with so a late-arriving
      // response can't overwrite the UI when the user has already
      // moved to a different file (avoids stale flicker).
      if (wt !== worktreePath || f !== file || k !== kind) return;
      rows = parseDiff(text);
      binary = /^Binary files /m.test(text);
      state = "ready";
    } catch {
      state = "error";
    }
  }

  /** Walk the diff text and emit Row[]. Only the parts we need:
   *  hunk headers (to seed line numbers) and +/- lines. Headers (`diff
   *  --git`, `index`, `---`, `+++`, mode lines) are skipped — the
   *  filename is already shown in the parent row. */
  function parseDiff(text: string): Row[] {
    const out: Row[] = [];
    let oldLn = 0;
    let newLn = 0;
    let inHunk = false;
    let first = true;
    for (const line of text.split("\n")) {
      if (line.startsWith("@@")) {
        // `@@ -OLDSTART[,OLDCOUNT] +NEWSTART[,NEWCOUNT] @@ ...`
        const m = line.match(/^@@ -(\d+)(?:,\d+)? \+(\d+)(?:,\d+)? @@/);
        if (m) {
          oldLn = Number(m[1]);
          newLn = Number(m[2]);
          inHunk = true;
          if (!first) out.push({ kind: "hunk", text: "…" });
          first = false;
        }
        continue;
      }
      if (!inHunk) continue;
      if (line.startsWith("+++") || line.startsWith("---")) continue;
      if (line.startsWith("+")) {
        out.push({ kind: "add", oldLn: null, newLn, text: line.slice(1) });
        newLn += 1;
      } else if (line.startsWith("-")) {
        out.push({ kind: "del", oldLn, newLn: null, text: line.slice(1) });
        oldLn += 1;
      } else if (line.startsWith(" ")) {
        // context line — context=0 means we shouldn't see these, but
        // be tolerant if the caller bumps context up.
        oldLn += 1;
        newLn += 1;
      }
    }
    return out;
  }
</script>

{#if state === "loading"}
  <span class="fd-muted">Loading diff…</span>
{:else if state === "error"}
  <span class="fd-muted">Couldn't load diff.</span>
{:else if binary && rows.length === 0}
  <span class="fd-muted">Binary file — no text diff.</span>
{:else if rows.length === 0}
  <span class="fd-muted">No textual changes.</span>
{:else}
  <div class="fd-grid">
    {#each rows as r}
      {#if r.kind === "hunk"}
        <span class="fd-hunk"></span>
        <span class="fd-hunk"></span>
        <span class="fd-hunk">{r.text}</span>
      {:else if r.kind === "add" || r.kind === "del"}
        <!-- Use `class:` directives instead of a dynamic `fd-{kind}`
             interpolation so Svelte's scoped-CSS pass keeps the
             color rules on these elements (it can't always prove
             a dynamic class string matches a static selector). -->
        <span
          class="fd-ln fd-ln-old"
          class:fd-add={r.kind === "add"}
          class:fd-del={r.kind === "del"}>{r.oldLn ?? ""}</span
        >
        <span
          class="fd-ln fd-ln-new"
          class:fd-add={r.kind === "add"}
          class:fd-del={r.kind === "del"}>{r.newLn ?? ""}</span
        >
        <span
          class="fd-line"
          class:fd-add={r.kind === "add"}
          class:fd-del={r.kind === "del"}
          >{r.kind === "add" ? "+" : "−"}{r.text}</span
        >
      {:else}
        <span class="fd-muted"></span>
        <span class="fd-muted"></span>
        <span class="fd-muted">{r.text}</span>
      {/if}
    {/each}
  </div>
{/if}

<style>
  .fd-grid {
    display: grid;
    grid-template-columns: auto auto 1fr;
    column-gap: 0.45rem;
    row-gap: 0.05rem;
    font-family: ui-monospace, monospace;
    font-size: 0.62rem;
    line-height: 1.35;
    /* Cap the diff popup so a long file doesn't blow out the layout.
       The popup is portal'd to <body>, so the surrounding tooltip
       won't expand to fit it. */
    max-height: 22rem;
    overflow: auto;
  }
  .fd-ln {
    color: var(--text-muted, #8a8a8a);
    text-align: right;
    font-variant-numeric: tabular-nums;
    user-select: none;
    padding-right: 0.1rem;
  }
  .fd-line {
    white-space: pre-wrap;
    word-break: break-word;
  }
  /* Brighter than the worktree-row chips so +/- text still pops on
     top of the lifted, lighter popup background. The row tint is
     deliberately subtle (~7%) so two adjacent rows of opposite
     polarity don't visually fight. */
  .fd-add {
    color: #7ee493;
    background: color-mix(in srgb, #7ee493 7%, transparent);
  }
  .fd-del {
    color: #ff8a8a;
    background: color-mix(in srgb, #ff8a8a 7%, transparent);
  }
  .fd-hunk {
    color: var(--text-muted, #8a8a8a);
    font-style: italic;
    border-top: 1px dashed
      color-mix(in srgb, var(--text-muted, #8a8a8a) 30%, transparent);
    padding-top: 0.15rem;
    margin-top: 0.15rem;
  }
  .fd-muted {
    color: var(--text-muted, #8a8a8a);
    font-style: italic;
    font-size: 0.65rem;
  }
</style>
