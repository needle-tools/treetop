<script lang="ts">
  interface AsyncQuestionOption {
    label: string;
    description?: string;
  }

  export let questionId: string | undefined = undefined;
  export let text: string | undefined = undefined;
  export let options: readonly AsyncQuestionOption[] = [];
  export let answered = false;
  export let onAnswer:
    | ((questionId: string, answer: string) => void | Promise<void>)
    | undefined = undefined;
</script>

<div class="async-question" data-answered={answered || undefined}>
  <div class="async-question-heading">
    <span class="async-question-symbol" aria-hidden="true">?</span>
    <span>Question</span>
  </div>
  {#if text}
    <div class="async-question-prompt">{text}</div>
  {/if}
  {#if options.length}
    <div class="async-question-options">
      {#each options as option (option.label)}
        {#if onAnswer}
          <button
            type="button"
            disabled={answered || !questionId}
            title={option.description}
            on:click={() => questionId && onAnswer?.(questionId, option.label)}
          >
            <span>{option.label}</span>
            {#if option.description}<small>{option.description}</small>{/if}
          </button>
        {:else}
          <div class="async-question-option">
            <span>{option.label}</span>
            {#if option.description}<small>{option.description}</small>{/if}
          </div>
        {/if}
      {/each}
    </div>
  {/if}
  {#if answered}<div class="async-question-answered">Answer sent</div>{/if}
</div>

<style>
  .async-question {
    display: grid;
    gap: 0.55rem;
    margin: 0.35rem 0;
    padding: 0.8rem 0.9rem;
    border: 1px solid
      color-mix(in srgb, var(--warning, #e0a34b) 42%, var(--surface-3));
    border-radius: 0.75rem;
    background: color-mix(
      in srgb,
      var(--warning, #e0a34b) 9%,
      var(--surface-2)
    );
  }
  .async-question[data-answered] {
    border-color: var(--surface-3);
    background: var(--surface-2);
  }
  .async-question-heading {
    display: flex;
    align-items: center;
    gap: 0.35rem;
    color: var(--warning, #e0a34b);
    font-size: 0.72rem;
    font-weight: 700;
    letter-spacing: 0.04em;
    text-transform: uppercase;
  }
  .async-question-symbol {
    display: inline-flex;
    align-items: center;
    justify-content: center;
    width: 1.2rem;
    height: 1.2rem;
    border: 1px solid currentColor;
    border-radius: 999px;
    font-size: 0.72rem;
    font-weight: 800;
    line-height: 1;
  }
  .async-question-prompt {
    color: var(--text-1);
    font-weight: 600;
    line-height: 1.4;
  }
  .async-question-options {
    display: flex;
    flex-wrap: wrap;
    gap: 0.45rem;
  }
  .async-question-options button,
  .async-question-option {
    display: grid;
    gap: 0.15rem;
    padding: 0.45rem 0.65rem;
    border: 1px solid var(--surface-3);
    border-radius: 0.55rem;
    color: var(--text-1);
    background: var(--surface-1);
    text-align: left;
    font: inherit;
  }
  .async-question-options button:not(:disabled) {
    cursor: pointer;
  }
  .async-question-options button:not(:disabled):hover {
    border-color: var(--warning, #e0a34b);
    background: color-mix(
      in srgb,
      var(--warning, #e0a34b) 15%,
      var(--surface-1)
    );
  }
  .async-question-options small,
  .async-question-answered {
    color: var(--text-muted);
    font-size: 0.72rem;
  }
</style>
