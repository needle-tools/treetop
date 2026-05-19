<script lang="ts">
  /**
   * Read-only column for a stopped (or still-running) Ollama session.
   *
   * Thin wrapper around SessionView so the read view looks the same
   * as Claude / Codex: same header, same message bubbles, same
   * pinned-message strip — just driven by the daemon's own
   * `<workspace>/ollama/<termId>.jsonl` (header + periodic `output`
   * chunks + exit), parsed by `parseOllamaJsonl`.
   *
   * The wrapper adds two things SessionView's defaults don't cover:
   *  - A custom Resume action: Ollama has no CLI `resume` (there is
   *    no on-disk conversation state), so the Resume button in the
   *    header dispatches up to the parent which replaces the
   *    transcript column with a fresh `__new__:ollama:` column. The
   *    plain Resume spawns clean; the burger menu adds "Resume with
   *    context" which feeds the prior transcript back as initial
   *    PTY input.
   *  - Pill labelling: the SessionHeader pill reads the model tag
   *    (e.g. `qwen3-coder:30b`) instead of the generic "ollama". The
   *    `agentLabel` override is exposed by SessionHeader for this.
   */
  import { createEventDispatcher, onMount, onDestroy } from "svelte";
  import SessionView from "./SessionView.svelte";
  import type { SessionMenuItem } from "./SessionMenu.svelte";

  export let termId: string;
  export let wt: string;
  /** Model tag the session ran. Parent resolves it from `/api/agents`
   *  and passes it through; the read view uses it for the pill label
   *  and the Resume command. */
  export let model: string;
  /** Absolute path to the on-disk Ollama JSONL. Parent gets this from
   *  the matching AgentSession in `wt.agents`. SessionView fetches it
   *  via `/api/session?source=<path>`. */
  export let sourcePath: string;

  const dispatch = createEventDispatcher<{
    close: void;
    /** Plain Resume: spawn a fresh `ollama run <model>` with no
     *  context. `priorText` undefined ⇒ default. */
    /** Resume with context: the parent feeds the captured transcript
     *  back as initial PTY input. `priorText` carries the primer
     *  built from the rendered chat. */
    resume: { model: string; priorText?: string };
  }>();

  /** When the user picks "Resume with context", we need the captured
   *  conversation. We have it server-side (the JSONL); we re-fetch
   *  the same /api/session response (already parsed into messages)
   *  and serialize the user+assistant turns into a plain text primer.
   *  Kept inline (rather than passed in) so the parent doesn't have
   *  to know the on-disk shape. */
  let messagesText: string = "";
  let pollTimer: ReturnType<typeof setInterval> | null = null;
  let alive = true;
  /** Poll lightly while the session is live so the primer reflects
   *  the latest turns if the user later picks Resume with context.
   *  Stops once we observe an exit. */
  async function refreshMessages(): Promise<void> {
    try {
      const qs = new URLSearchParams({ source: sourcePath });
      const res = await fetch(`/api/session?${qs.toString()}`);
      if (!res.ok) return;
      const body = (await res.json()) as {
        messages?: { role?: string; blocks?: { text?: string }[] }[];
        endedAt?: string;
      };
      messagesText = (body.messages ?? [])
        .map((m) => {
          const text = (m.blocks ?? [])
            .map((b) => (typeof b.text === "string" ? b.text : ""))
            .join("\n")
            .trim();
          if (!text) return "";
          const role = m.role === "assistant" ? "Assistant" : "User";
          return `${role}: ${text}`;
        })
        .filter((s) => s.length > 0)
        .join("\n\n");
      if (body.endedAt) alive = false;
    } catch {
      // best-effort
    }
  }
  onMount(() => {
    void refreshMessages();
    pollTimer = setInterval(() => {
      if (!alive) {
        if (pollTimer) {
          clearInterval(pollTimer);
          pollTimer = null;
        }
        return;
      }
      void refreshMessages();
    }, 4000);
  });
  onDestroy(() => {
    if (pollTimer) clearInterval(pollTimer);
  });

  function buildPrimer(): string | undefined {
    if (!messagesText) return undefined;
    const MAX = 16 * 1024;
    const body = messagesText.length > MAX ? messagesText.slice(-MAX) : messagesText;
    return (
      "Below is our previous conversation. Please continue from where it left off; do not repeat it back.\n\n" +
      body +
      "\n\n"
    );
  }

  function onResumeFresh(): void {
    dispatch("resume", { model });
  }
  function onResumeWithContext(): void {
    dispatch("resume", { model, priorText: buildPrimer() });
  }

  /** Inject a "Resume with context" item into SessionView's burger
   *  menu. Disabled when there's nothing captured yet. */
  $: extraMenuItems = [
    {
      kind: "action",
      label: "Resume with context",
      icon: "↻",
      disabled: !messagesText,
      title: messagesText
        ? `Spawn a fresh \`ollama run ${model}\` and replay the captured transcript as initial input`
        : "Nothing captured yet — start a new chat first",
      onSelect: (_triggerRect: DOMRect) => onResumeWithContext(),
    },
  ] satisfies SessionMenuItem[];
</script>

<SessionView
  agent="ollama"
  source={sourcePath}
  wtPath={wt}
  initialMode="read"
  model={model}
  onCustomResume={onResumeFresh}
  {extraMenuItems}
  onClose={() => dispatch("close")}
/>
