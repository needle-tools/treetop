<script lang="ts">
  /**
   * Ollama session column. Thin wrapper around SessionView so the
   * view looks the same as Claude / Codex (header, bubbles, pinned-
   * message strip), driven by `<workspace>/ollama/<termId>.jsonl`
   * (parsed by `parseOllamaJsonl`).
   *
   * No Resume action: Ollama is API-driven now (see plans/ollama.md
   * "Plan: API-driven chat mode"). The in-bubble chat composer at
   * the bottom of SessionView is the only way to continue an Ollama
   * conversation — `ollama run` would have no way to pick up the
   * messages array. Header Resume + the prior "Resume with context"
   * menu item were both routes to the legacy PTY-mode column and
   * are gone.
   *
   * The wrapper still owns one thing SessionView's defaults don't:
   *  - Pill labelling: the SessionHeader pill reads the model tag
   *    (e.g. `qwen3-coder:30b`) instead of the generic "ollama".
   *    The `agentLabel` override is exposed by SessionHeader; we
   *    pass `model` through via SessionView's `model` prop and
   *    SessionView wires the override internally.
   */
  import { createEventDispatcher } from "svelte";
  import SessionView from "./SessionView.svelte";

  export let termId: string;
  export let wt: string;
  /** Model tag the session ran. Parent resolves it from `/api/agents`
   *  (or the openNewOllamaChat response for fresh sessions) and
   *  passes it through; the read view uses it for the pill label. */
  export let model: string;
  /** Absolute path to the on-disk Ollama JSONL. Parent gets this from
   *  the matching AgentSession in `wt.agents` (or the override map
   *  for freshly-created sessions). SessionView fetches it via
   *  `/api/session?source=<path>`. */
  export let sourcePath: string;
  export let onContinueWith: ((targetAgent: "claude" | "codex" | "ollama", ollamaModel?: string) => void) | undefined = undefined;
  export let starred: boolean = false;
  export let onToggleStar: () => void = () => {};

  // termId is currently unused inside this shim; SessionView keys
  // off `source` (the JSONL path). Kept as a prop so callers don't
  // have to re-thread it if a future feature (e.g. an "End session"
  // action that DELETEs server-side state) needs it.
  void termId;

  const dispatch = createEventDispatcher<{
    close: void;
  }>();
</script>

<SessionView
  agent="ollama"
  source={sourcePath}
  wtPath={wt}
  initialMode="read"
  model={model}
  {starred}
  {onToggleStar}
  {onContinueWith}
  onClose={() => dispatch("close")}
/>
