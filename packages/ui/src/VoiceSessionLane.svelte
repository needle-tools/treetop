<script lang="ts">
  import type { GlobalVoiceState } from "./voice-controller";

  export let state: GlobalVoiceState;

  function statusText(): string {
    if (state.phase === "connecting") return "Connecting";
    if (state.phase === "listening") return "Listening";
    if (state.phase === "speaking") return "Speaking";
    if (state.phase === "stopping") return "Stopping";
    if (state.phase === "error") return "Voice unavailable";
    return "Voice off";
  }
</script>

{#if state.phase !== "off"}
  <section
    class="voice-session-lane"
    class:error={state.phase === "error"}
    aria-label="Voice session"
  >
    <div class="voice-session-head">
      <span class="voice-session-dot" aria-hidden="true"></span>
      <strong>Voice</strong>
      <span>{statusText()}</span>
    </div>
    {#if state.error}
      <p class="voice-session-error">{state.error}</p>
    {:else if state.messages?.length}
      <ol class="voice-session-messages">
        {#each state.messages.slice(-6) as message (message.id)}
          <li class:assistant={message.role === "assistant"}>
            <span>{message.role === "assistant" ? "Treetop" : "You"}</span>
            <p>{message.text}</p>
          </li>
        {/each}
      </ol>
    {:else}
      <p class="voice-session-empty">
        Ready for voice orchestration in this Treetop window.
      </p>
    {/if}
  </section>
{/if}

<style>
  .voice-session-lane {
    margin: 0.4rem auto 0.9rem;
    width: min(58rem, calc(100vw - 7rem));
    display: grid;
    gap: 0.45rem;
    padding: 0.65rem 0.75rem;
    border: 1px solid var(--border-muted);
    border-radius: 1rem;
    background: color-mix(in srgb, var(--surface-2) 86%, transparent);
    box-shadow: 0 10px 28px var(--shadow-sm);
    color: var(--text-2);
  }

  .voice-session-head {
    display: flex;
    align-items: center;
    gap: 0.4rem;
    font-size: 0.72rem;
    line-height: 1;
  }

  .voice-session-head strong {
    color: var(--text-1);
  }

  .voice-session-dot {
    width: 0.48rem;
    height: 0.48rem;
    border-radius: 50%;
    background: var(--needle-green);
    box-shadow: 0 0 0 0 color-mix(in srgb, var(--needle-green) 42%, transparent);
    animation: voice-session-pulse 1.6s ease-out infinite;
  }

  .voice-session-lane.error .voice-session-dot {
    background: var(--status-danger, #ef4444);
    box-shadow: none;
    animation: none;
  }

  .voice-session-error,
  .voice-session-empty {
    margin: 0;
    font-size: 0.76rem;
    line-height: 1.35;
  }

  .voice-session-error {
    color: var(--status-danger, #ef4444);
  }

  .voice-session-messages {
    margin: 0;
    padding: 0;
    list-style: none;
    display: grid;
    gap: 0.36rem;
    max-height: 10rem;
    overflow: auto;
  }

  .voice-session-messages li {
    justify-self: end;
    max-width: min(42rem, 86%);
    display: grid;
    gap: 0.16rem;
  }

  .voice-session-messages li.assistant {
    justify-self: start;
  }

  .voice-session-messages span {
    font-size: 0.62rem;
    line-height: 1;
    color: var(--text-3);
    text-transform: uppercase;
    letter-spacing: 0;
  }

  .voice-session-messages p {
    margin: 0;
    padding: 0.42rem 0.56rem;
    border-radius: 0.75rem;
    background: var(--surface-3);
    color: var(--text-1);
    font-size: 0.76rem;
    line-height: 1.32;
  }

  .voice-session-messages li.assistant p {
    background: transparent;
    padding-left: 0;
  }

  @keyframes voice-session-pulse {
    70%,
    100% {
      box-shadow: 0 0 0 0.34rem transparent;
    }
  }
</style>
