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
  import { enqueueSummary } from "./summary-queue";

  export let repoId: string;
  export let repoName: string;

  interface Frontmatter {
    model: string;
    lastSha: string;
    generatedAt: string;
    sinceHours: number;
    commitCount: number;
    dirtyWorktreeCount: number;
    estimatedTokens?: number;
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
  let queued: boolean = false;
  let errorMsg: string = "";
  /** The model the picker chose for the in-flight (or just-finished)
   *  generation. Surfaced in the "summarising with …" status so the
   *  user can see at a glance which local model is doing the work. */
  let currentModel: string = "";
  /** Live metadata from the server's SSE `meta` + `prompt` events.
   *  Lets us show "last 24h · 12 commits · context ~5.2k" while the
   *  generation is in flight, so the user can see *what* is being
   *  summarised, not just *that* something is. Reset on each run. */
  let liveSinceHours: number | null = null;
  let liveCommitCount: number | null = null;
  let liveDirtyCount: number | null = null;
  let liveEstimatedTokens: number | null = null;
  /** True once we've heard back from the GET, so we don't flash
   *  "no summary yet" while the probe is still in flight. */
  let probed: boolean = false;
  /** Becomes true the first time the strip intersects the viewport.
   *  Generation is deferred until then so off-screen repos don't
   *  burn an Ollama slot on the user's first paint. */
  let visible: boolean = false;
  /** Cancel handle returned by `enqueueSummary`. Lets us drop a
   *  job from the queue if the component unmounts before it runs. */
  let cancelQueued: (() => void) | null = null;
  let stripEl: HTMLDivElement | undefined;
  let io: IntersectionObserver | null = null;

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
    maybeEnqueue();
  }

  /** Enqueue a generate run iff the cache is stale AND the strip is
   *  on-screen AND we don't already have one in flight or queued.
   *  Called from probe completion and from the IntersectionObserver
   *  the first time the strip becomes visible. */
  function maybeEnqueue(): void {
    if (!stale) return;
    if (!visible) return;
    if (generating || queued) return;
    queued = true;
    cancelQueued = enqueueSummary(async (signal) => {
      try {
        await generate(signal);
      } finally {
        queued = false;
        cancelQueued = null;
      }
    });
  }

  /** A repo summary fires automatically every few hours per repo on
   *  dashboard load. It MUST stay local — cloud models would silently
   *  ship the user's commit messages and dirty-worktree paths to a
   *  third party. The picker therefore rejects anything that looks
   *  like a cloud model. Ollama tags cloud models with a `:cloud`
   *  tag or a `-cloud` model-name suffix (e.g. `glm-4.6:cloud`,
   *  `qwen3-coder:480b-cloud`, `gpt-oss:120b-cloud`). */
  function isCloudModel(name: string): boolean {
    const n = name.toLowerCase();
    return /(^|[-:/])[a-z0-9.]*cloud(\b|$|:)/.test(n);
  }

  /** Pick a LOCAL model: last-used → llama3.2:3b → smallest non-embed.
   *  Cloud models are filtered out before any preference check, so a
   *  remembered cloud pick from elsewhere in the app never leaks in.
   *  Returns null when nothing local is installed so the caller can
   *  surface a "install a local model first" notice. */
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
    const local = list.filter((m) => !isCloudModel(m.name));
    if (local.length === 0) return null;
    const remembered = localStorage.getItem("supergit:summarize:lastModel");
    if (
      remembered &&
      !isCloudModel(remembered) &&
      local.some((m) => m.name === remembered)
    ) {
      return remembered;
    }
    if (local.some((m) => m.name === "llama3.2:3b")) return "llama3.2:3b";
    const usable = local.filter((m) => {
      const n = m.name.toLowerCase();
      return !n.endsWith("-embed") && !n.endsWith(":embed");
    });
    usable.sort(
      (a, b) =>
        (a.size ?? Number.MAX_SAFE_INTEGER) -
        (b.size ?? Number.MAX_SAFE_INTEGER),
    );
    return usable[0]?.name ?? local[0]?.name ?? null;
  }

  /** Local aborter so onDestroy can cancel an in-flight fetch. The
   *  queue passes its own AbortSignal (60s timeout); we listen to it
   *  and forward into the local aborter so both teardown paths work. */
  let aborter: AbortController | null = null;

  async function generate(queueSignal?: AbortSignal): Promise<void> {
    if (generating) return;
    generating = true;
    errorMsg = "";
    liveSinceHours = null;
    liveCommitCount = null;
    liveDirtyCount = null;
    liveEstimatedTokens = null;
    aborter = new AbortController();
    const onQueueAbort = () => aborter?.abort();
    queueSignal?.addEventListener("abort", onQueueAbort);
    const pick = await pickInstalledModel();
    if (!pick) {
      errorMsg = "No local Ollama model installed";
      generating = false;
      queueSignal?.removeEventListener("abort", onQueueAbort);
      return;
    }
    currentModel = pick;
    // Track which stage we're in so a thrown TypeError surfaces as
    // something useful ("daemon unreachable" vs "stream interrupted")
    // instead of the browser's opaque "network error".
    let stage: "connect" | "stream" = "connect";
    try {
      let res: Response;
      try {
        res = await fetch(`/api/repos/${encodeURIComponent(repoId)}/summarize`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ model: pick }),
          signal: aborter.signal,
        });
      } catch (e) {
        // Connect-time failure: the daemon refused the connection or
        // the SPA's tab is older than the current daemon. Either way
        // the request never made it past the initial handshake.
        if ((e as Error).name === "AbortError") throw e;
        const detail = e instanceof Error ? e.message : String(e);
        errorMsg = `Can't reach the daemon — ${detail}`;
        return;
      }
      if (!res.ok || !res.body) {
        let detail = "";
        try {
          detail = (await res.text()).slice(0, 200);
        } catch {
          // body unreadable
        }
        errorMsg = `HTTP ${res.status} ${res.statusText}${detail ? ` — ${detail}` : ""}`;
        return;
      }
      stage = "stream";
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
              const payload = JSON.parse(data) as {
                kind?: string;
                message?: string;
              };
              const label = errorLabelFor(payload.kind);
              errorMsg = payload.message
                ? `${label}: ${payload.message}`
                : label;
            } catch {
              errorMsg = "error";
            }
          } else if (event === "meta") {
            try {
              const m = JSON.parse(data) as {
                sinceHours?: number;
                commitCount?: number;
                dirtyWorktreeCount?: number;
              };
              if (typeof m.sinceHours === "number") liveSinceHours = m.sinceHours;
              if (typeof m.commitCount === "number") liveCommitCount = m.commitCount;
              if (typeof m.dirtyWorktreeCount === "number") liveDirtyCount = m.dirtyWorktreeCount;
            } catch {
              // ignore malformed meta
            }
          } else if (event === "prompt") {
            try {
              const p = JSON.parse(data) as { estimatedTokens?: number };
              if (typeof p.estimatedTokens === "number") liveEstimatedTokens = p.estimatedTokens;
            } catch {
              // ignore malformed prompt event
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
      // Some browsers throw TypeError instead of AbortError when a
      // stream reader is aborted mid-read. Check the signal itself
      // rather than relying solely on the error name so we always
      // route abort-caused errors to the right message.
      const wasAborted =
        (e as Error).name === "AbortError" ||
        aborter?.signal.aborted ||
        queueSignal?.aborted;

      if (wasAborted) {
        if (queueSignal?.aborted) {
          errorMsg = "timed out (3m)";
        }
        return;
      }
      const detail = e instanceof Error ? e.message : String(e);
      // A TypeError caught here only happens AFTER the stream opened
      // (we already handled the connect-time TypeError above). So this
      // is "stream interrupted" — daemon died or restarted mid-stream.
      if (stage === "stream" && (e as Error).name === "TypeError") {
        errorMsg = `Stream interrupted — ${detail}`;
      } else {
        errorMsg = detail;
      }
    } finally {
      queueSignal?.removeEventListener("abort", onQueueAbort);
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

  /** Human label for the SSE error `kind` tag the server attaches.
   *  Lets us say "Ollama unreachable" instead of letting the message
   *  do all the work — the kind+message pair is much easier to scan
   *  than a raw "fetch failed" string. */
  function errorLabelFor(kind: string | undefined): string {
    switch (kind) {
      case "ollama_unreachable":
        return "Ollama unreachable";
      case "ollama_model_missing":
        return "Model not installed";
      case "ollama_http":
        return "Ollama error";
      case "ollama_payload":
        return "Ollama returned an error";
      default:
        return "error";
    }
  }

  /** Compact "5.2k" / "880" style for the prompt's estimated token
   *  count. Same shape Ollama users see in their own UIs so the
   *  number reads at a glance without unit explanation. */
  function fmtTokens(n: number | null): string {
    if (n == null || !Number.isFinite(n) || n <= 0) return "";
    if (n < 1000) return `${n}`;
    const k = n / 1000;
    return `${k >= 10 ? k.toFixed(0) : k.toFixed(1)}k`;
  }

  /** Split the LLM body on whatever separator it picked (we ask for
   *  en-dash, but small models also produce middle-dot, bullet, or
   *  bar). Returned parts are trimmed so the rendered separator is
   *  the only spacing between themes. */
  function splitBody(s: string): string[] {
    return s
      .split(/\s+[–·•|-]\s+/)
      .map((p) => p.trim())
      .filter(Boolean);
  }

  /** Human label for the window of activity the summary covers, e.g.
   *  "last 24h" or "last 7d". Reads `sinceHours` from the frontmatter
   *  so it tracks whatever window the daemon actually summarised. */
  function rangeLabel(hours: number): string {
    if (!Number.isFinite(hours) || hours <= 0) return "";
    if (hours < 24) return `last ${Math.round(hours)}h`;
    const days = hours / 24;
    if (days < 7) return `last ${Math.round(days)}d`;
    const weeks = days / 7;
    if (weeks < 5) return `last ${Math.round(weeks)}w`;
    return `last ${Math.round(days / 30)}mo`;
  }

  let startupTimer: ReturnType<typeof setTimeout> | undefined;
  onMount(() => {
    startupTimer = setTimeout(() => void probe(), 3000);
  });
  onDestroy(() => {
    clearTimeout(startupTimer);
    io?.disconnect();
    cancelQueued?.();
    aborter?.abort();
  });

  /** Svelte action: attach an IntersectionObserver to the strip and
   *  flip `visible` true on the first intersection. Once visible
   *  fires, we trigger maybeEnqueue (in case the probe already
   *  finished and was waiting on us). No need to keep observing
   *  past the first hit — generation is one-shot per mount. */
  function observeVisible(node: HTMLElement): { destroy: () => void } {
    io = new IntersectionObserver(
      (entries) => {
        for (const e of entries) {
          if (e.isIntersecting) {
            visible = true;
            maybeEnqueue();
            io?.disconnect();
            io = null;
            break;
          }
        }
      },
      { rootMargin: "200px 0px" }, // start early so it's ready by scroll
    );
    io.observe(node);
    return {
      destroy() {
        io?.disconnect();
        io = null;
      },
    };
  }

  $: void repoId; // re-fetch if the bound repoId ever swaps
</script>

{#if probed}
  <div
    class="strip repo-summary"
    class:empty={!body && !generating && !errorMsg && !queued}
    bind:this={stripEl}
    use:observeVisible
  >
    {#if generating || queued}
      <span class="status">
        <LoadingSpinner size="0.7rem" thickness="2px" label="Summarising recent activity" />
        <span class="dim">
          {#if queued && !generating}
            queued…
          {:else if currentModel}
            summarising with <span class="model">{currentModel}</span>…
          {:else}
            summarising…
          {/if}
        </span>
        {#if generating && (liveSinceHours != null || liveCommitCount != null || liveEstimatedTokens != null)}
          <span class="live-meta">
            {#if liveSinceHours != null}
              <span class="sep">–</span>{rangeLabel(liveSinceHours)}
            {/if}
            {#if liveCommitCount != null}
              <span class="sep">–</span>{liveCommitCount} commit{liveCommitCount === 1 ? "" : "s"}
            {/if}
            {#if liveDirtyCount != null && liveDirtyCount > 0}
              <span class="sep">–</span>{liveDirtyCount} dirty
            {/if}
            {#if liveEstimatedTokens != null}
              <span class="sep">–</span>context ~{fmtTokens(liveEstimatedTokens)} tok
            {/if}
          </span>
        {/if}
      </span>
    {:else if errorMsg}
      <span class="err" title={errorMsg}>{errorMsg}</span>
    {:else if body}
      {#if frontmatter}
        <span
          class="meta"
          title={[
            `Generated ${relTimeFromIso(frontmatter.generatedAt)} with ${frontmatter.model}`,
            `${rangeLabel(frontmatter.sinceHours)} – ${frontmatter.commitCount} commits, ${frontmatter.dirtyWorktreeCount} dirty worktrees`,
            frontmatter.estimatedTokens
              ? `context ~${fmtTokens(frontmatter.estimatedTokens)} tokens, took ${(frontmatter.elapsedMs / 1000).toFixed(1)}s`
              : `took ${(frontmatter.elapsedMs / 1000).toFixed(1)}s`,
          ].join(" · ")}
        >{rangeLabel(frontmatter.sinceHours)}:</span>
      {/if}
      <Tooltip variant="wide" escapeClip>
        <span slot="trigger" class="body"
          >{#each splitBody(body) as part, i}{#if i > 0}<span class="sep">–</span>{/if}{part}{/each}</span>
        <div slot="content" class="tooltip-body"
          >{#each splitBody(body) as part, i}{#if i > 0}<span class="sep">–</span>{/if}{part}{/each}</div>
      </Tooltip>
    {/if}
    {#if !generating && !queued && (body || errorMsg)}
      <button
        type="button"
        class="refresh"
        title={`Re-summarise ${repoName} now`}
        on:click={() => {
          // Manual refresh: mark stale + visible so maybeEnqueue
          // picks it up regardless of cache freshness. Routes through
          // the same shared queue so we never run two at once.
          stale = true;
          visible = true;
          maybeEnqueue();
        }}
        aria-label="Re-summarise"
      >
        <svg
          viewBox="0 0 24 24"
          width="10"
          height="10"
          fill="none"
          stroke="currentColor"
          stroke-width="2"
          stroke-linecap="round"
          stroke-linejoin="round"
          aria-hidden="true"
        >
          <polyline points="23 4 23 10 17 10" />
          <polyline points="1 20 1 14 7 14" />
          <path d="M3.51 9a9 9 0 0 1 14.85-3.36L23 10" />
          <path d="M20.49 15A9 9 0 0 1 5.64 18.36L1 14" />
        </svg>
      </button>
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
    /* Leading inset matches `.sessions-strip` (same `--row-strip-pad`
       token) so the summary text aligns with the first session column
       below. Right side keeps the original chip padding. */
    padding: 0.3rem 0.55rem 0.3rem var(--row-strip-pad);
    border-radius: var(--radius-sm);
    font-size: 0.74rem;
    color: var(--text-muted);
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
     through the Svelte scoped-CSS boundary to do it.

     `flex: 0 1 auto` lets the body sit at its natural width when the
     summary is short (so the refresh button hugs the text instead of
     being pushed to the far right) AND still shrink with ellipsis
     when the summary overflows the row. */
  .strip :global(.tt-wrap) {
    flex: 0 1 auto;
    min-width: 0;
    overflow: hidden;
  }
  .body {
    display: block;
    width: 100%;
    color: var(--text-muted);
    line-height: 1.5;
    /* Single-line: extend to the available row width, then
       ellipsis. No JS truncation — the Tooltip shows the full
       text on hover. */
    white-space: nowrap;
    overflow: hidden;
    text-overflow: ellipsis;
    cursor: default;
  }
  /* Separator between themes. We render an en-dash (asked for by the
     prompt; the splitter also catches middle-dot/bullet/bar in case
     the model picked a different glyph) and bump weight + colour so
     the visual rhythm of the line reads as a sequence of items, not
     a stretched-out sentence. */
  .sep {
    display: inline-block;
    margin: 0 0.4rem;
    color: var(--text-3);
    font-weight: 700;
  }
  /* Empty post-probe state: collapse the chip so an empty row doesn't
     add visual weight. The element still occupies layout space so the
     IntersectionObserver has something to watch. */
  .strip.empty {
    padding-block: 0;
    margin-top: 0;
    min-height: 1px;
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
  /* Model name inside "summarising with …" — slightly brighter than
     the surrounding muted text so the eye picks it up, but still
     in the muted family so the status stays peripheral. */
  .model {
    color: var(--text-3);
    font-family: ui-monospace, monospace;
    font-size: 0.7rem;
  }
  /* Live metadata strip shown while generating ("– last 24h – 12
     commits – context ~5.2k"). Same muted tier as the rest of the
     status so it reads as one peripheral line, but the .sep dashes
     keep their slightly bolder weight from the body separator. */
  .live-meta {
    color: var(--text-muted);
    font-size: 0.7rem;
    white-space: nowrap;
  }
  .err {
    color: #e74c3c;
    flex: 0 1 auto;
    min-width: 0;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
    cursor: help;
  }
  .refresh {
    flex: 0 0 auto;
    display: inline-flex;
    align-items: center;
    justify-content: center;
    background: transparent;
    border: 0;
    color: var(--text-muted);
    line-height: 1;
    padding: 0.1rem 0.2rem;
    border-radius: var(--radius-sm, 4px);
    cursor: pointer;
  }
  .refresh:hover {
    background: var(--surface-3, var(--surface-2));
    color: var(--text-1);
  }
</style>
