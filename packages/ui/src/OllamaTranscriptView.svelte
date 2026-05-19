<script lang="ts">
  /**
   * Read-only column for a stopped (or still-running) Ollama session.
   *
   * Ollama doesn't write its own conversation transcript to disk, so
   * the daemon captures the PTY output for us — periodic flushes of
   * raw output land in `<workspace>/ollama/<termId>.jsonl` as
   * `kind: "output"` entries alongside the header. This view fetches
   * the joined transcript via `/api/ollama/sessions/:termId/transcript`,
   * strips ANSI control sequences for readability, and renders the
   * conversation as plain text. A Resume button spawns a fresh
   * `ollama run <model>` PTY in the same worktree (the model from
   * the original session's header).
   *
   * Mirrors ShellView's role for past shell columns.
   */
  import { createEventDispatcher, onMount, onDestroy } from "svelte";
  import SessionHeader from "./SessionHeader.svelte";

  export let termId: string;
  export let wt: string;
  export let manualTitle: string | undefined = undefined;
  /** Model tag the session ran. Parent resolves it from `/api/agents`
   *  and passes it through; the read view uses it for the pill label
   *  and the Resume command. */
  export let model: string;
  export let lastActive: string | undefined = undefined;

  const dispatch = createEventDispatcher<{
    close: void;
    /** `priorText` carries the captured (ANSI-stripped) transcript
     *  wrapped in a continuation primer. When undefined, Resume opens
     *  a fresh `ollama run <model>` with no context — the original
     *  behavior. When supplied, the daemon feeds the primer as
     *  initial input so the model can pick up from where it left off
     *  (best-effort: Ollama has no real session state, the model
     *  sees the transcript and treats it as user text). */
    resume: { model: string; priorText?: string };
  }>();

  let text: string = "";
  let loading: boolean = true;
  let error: string | null = null;
  let alive: boolean = false;
  /** Refresh the transcript while the PTY is still alive — the daemon
   *  appends `kind: "output"` chunks every ~3s. Cleared on destroy
   *  and once `alive` flips false. */
  let pollTimer: ReturnType<typeof setInterval> | null = null;

  async function load(): Promise<void> {
    try {
      const res = await fetch(`/api/ollama/sessions/${encodeURIComponent(termId)}/transcript`);
      if (!res.ok) {
        error = `daemon returned ${res.status}`;
        return;
      }
      const body = (await res.json()) as {
        text?: string;
        alive?: boolean;
        header?: { createdAt?: string };
      };
      text = body.text ?? "";
      alive = !!body.alive;
      error = null;
    } catch (e) {
      error = e instanceof Error ? e.message : String(e);
    } finally {
      loading = false;
    }
  }

  onMount(() => {
    void load().then(() => {
      if (alive) {
        pollTimer = setInterval(() => {
          void load().then(() => {
            if (!alive && pollTimer) {
              clearInterval(pollTimer);
              pollTimer = null;
            }
          });
        }, 3500);
      }
    });
  });
  onDestroy(() => {
    if (pollTimer) clearInterval(pollTimer);
  });

  /** Strip the most common ANSI control sequences so the captured PTY
   *  bytes read as plain text. This isn't a full terminal emulator —
   *  we just want the conversation legible. Cursor moves and line
   *  clears are dropped; carriage returns inside a line are collapsed
   *  to a single newline so streaming output doesn't pile up. */
  function decode(raw: string): string {
    if (!raw) return "";
    // CSI / OSC escape sequences.
    let s = raw.replace(/\x1B\[[0-?]*[ -/]*[@-~]/g, "");
    s = s.replace(/\x1B\][^\x07\x1B]*(?:\x07|\x1B\\)/g, "");
    // Other single-char ESC sequences (ESC + letter).
    s = s.replace(/\x1B[@-Z\\-_]/g, "");
    // Carriage returns without a following newline: treat as "rewrite
    // the line" — drop the CR so the latest text wins.
    s = s.replace(/\r(?!\n)/g, "");
    return s;
  }

  $: rendered = decode(text);

  /** Build the continuation primer sent to a fresh `ollama run <model>`
   *  when the user picks "Resume with context". The captured transcript
   *  has been ANSI-stripped already; we wrap it in a brief instruction
   *  so the model treats it as context rather than something to repeat.
   *  Ends with two newlines + an empty prompt line so `ollama run`'s
   *  readline submits the primer immediately (an Enter is implied) and
   *  the model's response is the first visible turn — the user can
   *  then type their next message as usual.
   *
   *  Trimmed at 16 KB. Models with smaller context windows will still
   *  truncate; a hard cap here keeps the WS write cheap and avoids
   *  pasting megabytes of prior spinner output (which we already strip
   *  on the daemon side but defense in depth doesn't hurt). */
  function buildPrimer(): string | undefined {
    const body = rendered.trim();
    if (body.length === 0) return undefined;
    const MAX = 16 * 1024;
    const clipped = body.length > MAX ? body.slice(-MAX) : body;
    return (
      "Below is our previous conversation. Please continue from where it left off; do not repeat it back.\n\n" +
      clipped +
      "\n\n"
    );
  }

  function onResumeFresh(): void {
    dispatch("resume", { model });
  }
  function onResumeWithContext(): void {
    dispatch("resume", { model, priorText: buildPrimer() });
  }
</script>

<div class="session ollama-transcript-col">
  <SessionHeader
    agent="ollama"
    agentLabel={model}
    source={`__transcript__:ollama:${termId}`}
    mode="read"
    manualTitle={manualTitle ?? ""}
    canResume={true}
    canEnd={false}
    onResume={onResumeFresh}
    onClose={() => dispatch("close")}
    lastActivityIso={lastActive}
    lastActivityFallback={alive ? "live" : "ended"}
    resumeTitle={`Spawn a fresh \`ollama run ${model}\` PTY at the same cwd`}
  />
  <div class="ollama-transcript-body">
    {#if !alive && rendered.length > 0}
      <!-- Secondary Resume that pipes the prior transcript into the
           fresh PTY as initial input, so the model has at least the
           captured context to continue from. The plain Resume button
           in the header still spawns a clean session. -->
      <div class="ollama-transcript-actions">
        <button
          class="resume-with-context-btn"
          on:click={onResumeWithContext}
          title={`Spawn \`ollama run ${model}\` and replay the captured transcript as initial input so the model can continue the conversation`}
        >Resume with context</button>
        <span class="muted small">replays the captured transcript as initial input — best-effort, not perfect memory</span>
      </div>
    {/if}
    {#if loading}
      <p class="muted">loading transcript…</p>
    {:else if error}
      <p class="muted">couldn't load transcript ({error}).</p>
    {:else if rendered.length === 0}
      <p class="muted">
        no output captured yet. The daemon flushes PTY output every few seconds —
        check back in a moment, or start chatting in a live session.
      </p>
    {:else}
      <pre class="ollama-transcript-text">{rendered}</pre>
    {/if}
    {#if alive}
      <p class="ollama-transcript-live muted small">● live — auto-refreshing</p>
    {/if}
  </div>
</div>

<style>
  /* Same height anchoring as SessionView: fill the column the parent
     strip stretches us into, clip overflow at the column edge, and
     let the body's `flex: 1; min-height: 0` consume the leftover
     space so the inner <pre> becomes the scroll container instead of
     pushing the column taller than its siblings. Without `min-height:
     0` the flex child would grow to its content's natural height and
     `overflow: auto` would never engage. */
  .ollama-transcript-col {
    border: 1px solid var(--surface-2);
    border-radius: var(--radius-md);
    background: var(--surface-1);
    overflow: hidden;
    height: 100%;
    box-sizing: border-box;
    display: flex;
    flex-direction: column;
    min-width: 0;
  }
  .ollama-transcript-body {
    flex: 1;
    min-height: 0;
    overflow: auto;
    padding: 0.75rem 1rem;
    font-size: 0.85rem;
    line-height: 1.4;
    color: var(--text-2);
  }
  .ollama-transcript-actions {
    display: flex;
    align-items: center;
    gap: 0.6rem;
    margin-bottom: 0.6rem;
    padding-bottom: 0.6rem;
    border-bottom: 1px dotted color-mix(in srgb, var(--surface-2) 60%, transparent);
  }
  .resume-with-context-btn {
    background: transparent;
    color: var(--chip-ollama-text);
    border: 1px solid var(--chip-ollama-bg);
    padding: 0.25rem 0.6rem;
    border-radius: var(--radius-sm);
    font-size: 0.75rem;
    cursor: pointer;
  }
  .resume-with-context-btn:hover {
    background: var(--chip-ollama-bg);
  }
  .small {
    font-size: 0.7rem;
  }
  .ollama-transcript-text {
    white-space: pre-wrap;
    word-break: break-word;
    font-family: ui-monospace, monospace;
    font-size: 0.8rem;
    color: var(--text-1);
    margin: 0;
  }
  .ollama-transcript-live {
    margin-top: 0.5rem;
    color: var(--chip-ollama-text);
  }
  .muted {
    color: var(--text-3);
  }
</style>
