<script lang="ts">
  /**
   * "What happened recently" strip rendered above the first row of
   * each repository. Probes /api/repos/:id/summary on mount: if a
   * cached body exists we paint it instantly; if it's stale (or
   * missing entirely) we fire a generate in the background and let
   * the result fade in.
   *
   * Collapsed-by-default: one-line preview + relative timestamp +
   * a ↻ icon. Click the preview to expand to the full paragraph.
   *
   * Trigger logic lives server-side (`shouldGenerate` in
   * repo-summary.ts) — this component just respects whatever
   * `stale` flag the GET response surfaces.
   */
  import { onMount, onDestroy } from "svelte";
  import LoadingSpinner from "./LoadingSpinner.svelte";
  import Tooltip from "./Tooltip.svelte";

  export let repoId: string;
  export let repoName: string;

  interface Frontmatter {
    model: string;
    lastSha: string;
    generatedAt: string;
    sinceHours: number;
    commitCount: number;
    dirtyWorktreeCount: number;
    elapsedMs: number;
  }
  type StaleReason = "missing" | "new-commits" | "stale-age";
  interface GetResponse {
    summary: { frontmatter: Frontmatter; body: string } | null;
    stale: boolean;
    reason?: StaleReason;
    currentSha?: string;
  }

  let body: string = "";
  let frontmatter: Frontmatter | null = null;
  let stale: boolean = false;
  let reason: StaleReason | null = null;
  let generating: boolean = false;
  let errorMsg: string = "";
  /** True once we've heard back from the GET, so we don't flash
   *  "no summary yet" while the probe is still in flight. */
  let probed: boolean = false;
  let aborter: AbortController | null = null;

  async function fetchCached(): Promise<GetResponse | null> {
    try {
      const res = await fetch(`/api/repos/${encodeURIComponent(repoId)}/summary`);
      if (!res.ok) return null;
      return (await res.json()) as GetResponse;
    } catch {
      return null;
    }
  }

  async function probe(): Promise<void> {
    const data = await fetchCached();
    probed = true;
    if (!data) return;
    if (data.summary) {
      body = data.summary.body;
      frontmatter = data.summary.frontmatter;
    } else {
      body = "";
      frontmatter = null;
    }
    stale = data.stale;
    reason = data.reason ?? null;
    if (data.stale && !generating) {
      void generate();
    }
  }

  /** Pick a model that's actually installed locally. Same logic the
   *  session chip uses: last-used → llama3.2:3b → smallest non-embed.
   *  Returns null when nothing is installed so the caller can surface
   *  a "install a model first" notice instead of firing a 404. */
  async function pickInstalledModel(): Promise<string | null> {
    let list: { name: string; size?: number }[] = [];
    try {
      const res = await fetch(`/api/ollama/models`);
      if (!res.ok) return null;
      const body = (await res.json()) as { models?: typeof list };
      list = body.models ?? [];
    } catch {
      return null;
    }
    if (list.length === 0) return null;
    const remembered = localStorage.getItem("supergit:summarize:lastModel");
    if (remembered && list.some((m) => m.name === remembered)) return remembered;
    if (list.some((m) => m.name === "llama3.2:3b")) return "llama3.2:3b";
    const usable = list.filter((m) => {
      const n = m.name.toLowerCase();
      return !n.endsWith("-embed") && !n.endsWith(":embed");
    });
    usable.sort(
      (a, b) =>
        (a.size ?? Number.MAX_SAFE_INTEGER) -
        (b.size ?? Number.MAX_SAFE_INTEGER),
    );
    return usable[0]?.name ?? list[0]?.name ?? null;
  }

  async function generate(): Promise<void> {
    if (generating) return;
    generating = true;
    errorMsg = "";
    aborter = new AbortController();
    const pick = await pickInstalledModel();
    if (!pick) {
      errorMsg = "No Ollama model installed";
      generating = false;
      return;
    }
    try {
      const res = await fetch(`/api/repos/${encodeURIComponent(repoId)}/summarize`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ model: pick }),
        signal: aborter.signal,
      });
      if (!res.ok || !res.body) {
        errorMsg = `HTTP ${res.status}`;
        return;
      }
      // We don't render streamed chunks live for repo summaries —
      // the strip is a "morning glance" surface, not an
      // entertainment piece. Consume + ignore the SSE body, then
      // pull the canonical cache once we see `done`.
      const reader = res.body.getReader();
      const dec = new TextDecoder();
      let buf = "";
      let finished = false;
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        buf += dec.decode(value, { stream: true });
        let sep: number;
        while ((sep = buf.indexOf("\n\n")) !== -1) {
          const frame = buf.slice(0, sep);
          buf = buf.slice(sep + 2);
          let event = "message";
          let data = "";
          for (const line of frame.split("\n")) {
            if (line.startsWith("event:")) event = line.slice(6).trim();
            else if (line.startsWith("data:")) data += line.slice(5).trim();
          }
          if (event === "error") {
            try {
              errorMsg =
                (JSON.parse(data) as { message?: string }).message ?? "error";
            } catch {
              errorMsg = "error";
            }
          } else if (event === "done") {
            finished = true;
          }
        }
      }
      if (finished || !errorMsg) {
        // Pull the freshly-written cache.
        const data = await fetchCached();
        if (data?.summary) {
          body = data.summary.body;
          frontmatter = data.summary.frontmatter;
          stale = data.stale;
          reason = data.reason ?? null;
        }
      }
    } catch (e) {
      if ((e as Error).name === "AbortError") return;
      errorMsg = e instanceof Error ? e.message : String(e);
    } finally {
      generating = false;
    }
  }

  function relTimeFromIso(iso: string): string {
    const ts = Date.parse(iso);
    if (!Number.isFinite(ts)) return "";
    const s = Math.floor((Date.now() - ts) / 1000);
    if (s < 60) return "just now";
    const m = Math.floor(s / 60);
    if (m < 60) return `${m}m ago`;
    const h = Math.floor(m / 60);
    if (h < 24) return `${h}h ago`;
    const d = Math.floor(h / 24);
    return `${d}d ago`;
  }

  onMount(() => {
    void probe();
  });
  onDestroy(() => {
    aborter?.abort();
  });

  $: void repoId; // re-fetch if the bound repoId ever swaps
</script>

{#if probed && (body || generating || errorMsg)}
  <div class="strip">
    {#if !generating}
      <button
        type="button"
        class="refresh"
        title={`Re-summarise ${repoName} now`}
        on:click={() => void generate()}
      >↻</button>
    {/if}
    {#if generating}
      <span class="status">
        <LoadingSpinner size="0.7rem" thickness="2px" label="Summarising recent activity" />
        <span class="dim">summarising…</span>
      </span>
    {:else if errorMsg}
      <span class="err">{errorMsg}</span>
    {:else}
      <Tooltip variant="wide" escapeClip>
        <span slot="trigger" class="body">{body}</span>
        <div slot="content" class="tooltip-body">{body}</div>
      </Tooltip>
    {/if}
    {#if frontmatter && !generating}
      <span class="meta">{relTimeFromIso(frontmatter.generatedAt)}</span>
    {/if}
  </div>
{/if}

<style>
  /* Visually mirrors `.row-activity` (worktree-row.css line ~805)
     so the repo summary reads as a sibling strip in the row's
     metadata zone — same surface-2 chip, same gap. Unlike the
     activity row we do NOT cap the height: the summary is prose
     and should use the full available width across as many lines
     as it needs. The parent row owns vertical layout; any clipping
     happens at that level, not here. */
  .strip {
    display: flex;
    align-items: baseline;
    flex-wrap: nowrap;
    gap: 0.5rem;
    margin-top: 0.4rem;
    padding: 0.3rem 0.55rem;
    background: var(--surface-2);
    border-radius: var(--radius-sm);
    font-size: 0.74rem;
    color: var(--text-3);
    min-width: 0;
    box-sizing: border-box;
    white-space: nowrap;
  }
  .status {
    display: inline-flex;
    align-items: center;
    gap: 0.35rem;
  }
  /* The Tooltip component wraps the trigger in its own `.tt-wrap`
     inline-flex element, so the strip's flex sizing has to land on
     THAT wrapper, not the inner .body span. `:global()` reaches
     through the Svelte scoped-CSS boundary to do it. */
  .strip :global(.tt-wrap) {
    flex: 1 1 0;
    min-width: 0;
    overflow: hidden;
  }
  .body {
    display: block;
    width: 100%;
    color: var(--text-1);
    line-height: 1.5;
    /* Single-line: extend to the available row width, then
       ellipsis. No JS truncation — the Tooltip shows the full
       text on hover. */
    white-space: nowrap;
    overflow: hidden;
    text-overflow: ellipsis;
    cursor: default;
  }
  .tooltip-body {
    max-width: 60ch;
    line-height: 1.5;
    white-space: normal;
    overflow-wrap: anywhere;
    color: var(--text-1);
  }
  .meta {
    color: var(--text-muted);
    flex: 0 0 auto;
    font-size: 0.7rem;
  }
  .dim { color: var(--text-muted); }
  .err { color: #e74c3c; }
  .refresh {
    flex: 0 0 auto;
    background: transparent;
    border: 0;
    color: var(--text-muted);
    font-size: 0.85rem;
    line-height: 1;
    padding: 0.1rem 0.35rem;
    border-radius: var(--radius-sm, 4px);
    cursor: pointer;
  }
  .refresh:hover {
    background: var(--surface-3, var(--surface-2));
    color: var(--text-1);
  }
</style>
