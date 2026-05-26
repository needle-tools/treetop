<script lang="ts">
  /**
   * Click-to-edit session/terminal title. Single source of truth for the
   * three places that used to roll their own copy of the rename widget
   * (SessionView, NewSessionCol, ShellView).
   *
   * The component owns: edit state, the input/button DOM, the POST to
   * /api/session/title, key handling. Consumers pass the storage `source`
   * key + the current `value`, and react to the `saved` event to update
   * their local snapshot (since the daemon's title flows back via
   * /api/repos / /api/shells / /api/session on the next refresh).
   */
  import { createEventDispatcher, onDestroy } from "svelte";

  /** Storage key for /api/session/title. Whatever string the daemon uses
   *  to index this entity's title (a JSONL path, `__new__:agent:id`,
   *  `__attached__:shell:id`, `shell:<termId>`, ...). */
  export let source: string;
  /** Current saved value. Empty/undefined renders the placeholder. */
  export let value: string | undefined = "";
  /** Placeholder text + click-to-name tooltip. */
  export let placeholder: string = "Name this session…";
  /** Compact = ShellView's smaller, lighter variant; default = the bold
   *  inline-title variant SessionView / NewSessionCol use. */
  export let compact: boolean = false;
  /** Optional extra line appended to the rest-state hover tooltip after
   *  "Click to rename · <name>". Used by SessionView to surface the
   *  cached Ollama summary, so the user can glance the session's gist
   *  from the title without opening the column. Plain text — newlines
   *  in `title` render as actual line breaks in native tooltips. */
  export let extraTooltip: string | undefined = undefined;

  export let onEditingChange: (editing: boolean) => void = () => {};

  const dispatch = createEventDispatcher<{ saved: { title: string } }>();

  let editing = false;
  let draft = "";
  let saving = false;
  let inputEl: HTMLInputElement | null = null;

  $: current = value ?? "";

  function startEdit() {
    draft = current;
    editing = true;
    onEditingChange(true);
    requestAnimationFrame(() => {
      inputEl?.focus();
      inputEl?.select();
    });
  }

  async function save() {
    const next = draft;
    if (next === current) {
      editing = false;
      onEditingChange(false);
      return;
    }
    saving = true;
    try {
      const res = await fetch("/api/session/title", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ source, title: next }),
      });
      if (!res.ok) return;
      dispatch("saved", { title: next.trim() });
    } catch {
      // best-effort — leave the UI to fall back; user can retry
    } finally {
      saving = false;
      editing = false;
      onEditingChange(false);
    }
  }

  function cancel() {
    editing = false;
    onEditingChange(false);
    draft = "";
  }

  function onKey(e: KeyboardEvent) {
    if (e.key === "Enter") {
      e.preventDefault();
      void save();
    } else if (e.key === "Escape") {
      e.preventDefault();
      cancel();
    }
  }

  onDestroy(() => {
    if (editing && draft && draft !== current) {
      fetch("/api/session/title", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ source, title: draft }),
      }).catch(() => {});
    }
  });
</script>

{#if editing}
  <input
    class="manual-title-input"
    class:compact
    bind:this={inputEl}
    bind:value={draft}
    on:keydown={onKey}
    on:blur={() => void save()}
    disabled={saving}
    {placeholder}
    maxlength="120"
  />
{:else}
  <button
    type="button"
    class="manual-title"
    class:compact
    class:placeholder={!current}
    title={(current ? `Click to rename · ${current}` : placeholder) + (extraTooltip ? `\n${extraTooltip}` : "")}
    on:click={startEdit}
  >
    {current || placeholder}
  </button>
{/if}

<style>
  .manual-title {
    background: transparent;
    border: 0;
    color: var(--text-1);
    font: inherit;
    font-weight: 600;
    font-size: 0.85rem;
    padding: 0;
    border-radius: var(--radius-sm);
    cursor: text;
    text-align: left;
    /* Fill whatever width col-name allots us; ellipsize when the
       title would otherwise push into the metadata column. The
       parent's min-width: 0 is what unlocks this shrinking — without
       it the flexbox would honor the button's intrinsic content
       width and squeeze col-meta off-screen instead. */
    max-width: 100%;
    min-width: 0;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }
  .manual-title:hover {
    background: var(--surface-3);
  }
  .manual-title.placeholder {
    color: var(--text-faint);
    font-weight: 400;
    font-style: italic;
  }
  .manual-title.compact {
    font-size: 0.7rem;
    font-weight: 500;
  }
  .manual-title-input {
    background: var(--surface-1);
    color: var(--text-1);
    border: 1px solid var(--text-faint);
    border-radius: var(--radius-sm);
    padding: 0.05rem 0.3rem;
    font: inherit;
    font-weight: 600;
    font-size: 0.85rem;
    min-width: 8ch;
    width: 24ch;
    max-width: 100%;
  }
  .manual-title-input.compact {
    font-size: 0.7rem;
    font-weight: 500;
    width: 18ch;
  }
  .manual-title-input:focus {
    outline: none;
    border-color: var(--brand);
  }
</style>
