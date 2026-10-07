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
  <div class="async-question-heading">Question</div>
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
    gap: 0.35rem;
    min-width: 0;
    padding: 0.45rem 0.5rem;
    border: 1px solid
      color-mix(in srgb, var(--warning, #e0a34b) 42%, var(--surface-3));
    border-radius: var(--radius-sm);
    background: color-mix(
      in srgb,
      var(--warning, #e0a34b) 9%,
      var(--surface-1)
    );
  }
  .async-question[data-answered] {
    border-color: var(--surface-3);
    background: var(--surface-1);
  }
  .async-question-heading {
    color: var(--warning, #e0a34b);
    font-size: 0.75rem;
    font-weight: 650;
  }
  .async-question-prompt {
    color: var(--text-1);
    font-size: 0.74rem;
    line-height: 1.35;
    white-space: pre-wrap;
    overflow-wrap: anywhere;
  }
  .async-question-options {
    display: flex;
    flex-wrap: wrap;
    gap: 0.35rem;
  }
  .async-question-options button,
  .async-question-option {
    display: grid;
    gap: 0.15rem;
    min-height: 1.5rem;
    padding: 0.25rem 0.55rem;
    border: 1px solid color-mix(in srgb, var(--surface-3) 86%, transparent);
    border-radius: var(--radius-sm);
    color: var(--text-2);
    background: color-mix(in srgb, var(--surface-1) 80%, transparent);
    text-align: left;
    font: inherit;
    font-size: 0.68rem;
    font-weight: 700;
    line-height: 1;
  }
  .async-question-options button:not(:disabled) {
    cursor: pointer;
  }
  .async-question-options button:not(:disabled):hover,
  .async-question-options button:focus-visible {
    color: var(--text-1);
    border-color: var(--warning, #e0a34b);
    outline: none;
  }
  .async-question-options button:disabled {
    opacity: 0.45;
    cursor: default;
  }
  .async-question-options small,
  .async-question-answered {
    color: var(--text-muted);
    font-size: 0.68rem;
    font-weight: 400;
    line-height: 1.35;
  }
</style>
