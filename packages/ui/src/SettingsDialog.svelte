<script lang="ts">
  /**
   * Generic settings dialog — renders every section contributed via
   * registerSettings() in settings-registry.ts. VS Code model: a
   * search box filters across all settings, controls are generated
   * from each setting's declared type, modified values get an accent
   * bar + a reset affordance. Mount once at the App root and open it
   * from the menubar gear button. Adding a setting anywhere in the
   * codebase requires zero changes here.
   */
  import {
    settingsSections,
    filterSections,
    getSetting,
    setSetting,
    resetSetting,
    isModified,
    type SettingDef,
  } from "./settings-registry";

  export let open = false;

  let query = "";
  // Bumped on every write so the {#key} below re-reads values — keeps
  // the template on plain getSetting()/isModified() calls instead of
  // one derived store per setting.
  let version = 0;

  $: visible = filterSections($settingsSections, query);

  function close() {
    open = false;
    query = "";
  }

  function onKeydown(ev: KeyboardEvent) {
    if (!open) return;
    if (ev.key === "Escape") {
      ev.preventDefault();
      close();
    }
  }

  function write(def: SettingDef, value: boolean | string | number) {
    setSetting(def.key, value);
    version += 1;
  }

  function reset(def: SettingDef) {
    resetSetting(def.key);
    version += 1;
  }

  function onNumberChange(def: SettingDef, ev: Event) {
    const input = ev.currentTarget as HTMLInputElement;
    let n = input.valueAsNumber;
    if (Number.isNaN(n)) n = def.default as number;
    if (def.min !== undefined) n = Math.max(def.min, n);
    if (def.max !== undefined) n = Math.min(def.max, n);
    input.valueAsNumber = n;
    write(def, n);
  }
</script>

<svelte:window on:keydown={onKeydown} />

{#if open}
  <div
    class="settings-overlay"
    on:click={close}
    on:keydown|stopPropagation
    role="presentation"
  >
    <div
      class="settings-dialog"
      role="dialog"
      aria-modal="true"
      aria-label="Settings"
      on:click|stopPropagation
    >
      <div class="settings-head">
        <h2>Settings</h2>
        <!-- svelte-ignore a11y-autofocus -->
        <input
          class="settings-search"
          type="search"
          placeholder="Search settings"
          autofocus
          bind:value={query}
        />
        <button class="settings-close" title="Close" on:click={close}
          >✕</button
        >
      </div>

      <div class="settings-body">
        {#key version}
          {#if visible.length === 0}
            <p class="settings-empty">
              {#if $settingsSections.length === 0}
                No settings registered yet. Contribute some with
                <code>registerSettings()</code> from
                <code>settings-registry.ts</code>.
              {:else}
                No settings match “{query}”.
              {/if}
            </p>
          {/if}
          {#each visible as section (section.id)}
            <section class="settings-section">
              <h3>{section.title}</h3>
              {#each section.settings as def (def.key)}
                <div class="setting-row" class:modified={isModified(def.key)}>
                  <div class="setting-text">
                    <span class="setting-label">{def.label}</span>
                    {#if def.description}
                      <span class="setting-desc">{def.description}</span>
                    {/if}
                  </div>
                  <div class="setting-control">
                    {#if isModified(def.key)}
                      <button
                        class="setting-reset"
                        title="Reset to default"
                        on:click={() => reset(def)}>↺</button
                      >
                    {/if}
                    {#if def.type === "boolean"}
                      <input
                        type="checkbox"
                        checked={getSetting(def.key) === true}
                        on:change={(ev) =>
                          write(def, ev.currentTarget.checked)}
                      />
                    {:else if def.type === "enum"}
                      <select
                        value={getSetting(def.key)}
                        on:change={(ev) => write(def, ev.currentTarget.value)}
                      >
                        {#each def.options ?? [] as opt (opt.value)}
                          <option value={opt.value}
                            >{opt.label ?? opt.value}</option
                          >
                        {/each}
                      </select>
                    {:else if def.type === "number"}
                      <input
                        type="number"
                        value={getSetting(def.key)}
                        min={def.min}
                        max={def.max}
                        step={def.step}
                        on:change={(ev) => onNumberChange(def, ev)}
                      />
                    {:else}
                      <input
                        type="text"
                        value={getSetting(def.key) ?? ""}
                        placeholder={def.placeholder}
                        on:change={(ev) => write(def, ev.currentTarget.value)}
                      />
                    {/if}
                  </div>
                </div>
              {/each}
            </section>
          {/each}
        {/key}
      </div>
    </div>
  </div>
{/if}

<style>
  .settings-overlay {
    position: fixed;
    inset: 0;
    background: rgba(0, 0, 0, 0.5);
    display: flex;
    align-items: flex-start;
    justify-content: center;
    padding-top: 9vh;
    z-index: 2000;
    backdrop-filter: blur(2px);
  }
  .settings-dialog {
    width: min(640px, 92vw);
    max-height: 76vh;
    display: flex;
    flex-direction: column;
    background: var(--surface-1);
    color: var(--text, inherit);
    border: 1px solid var(--surface-2);
    border-radius: var(--radius-md, 8px);
    box-shadow: 0 12px 32px rgba(0, 0, 0, 0.5);
  }
  .settings-head {
    display: flex;
    align-items: center;
    gap: 0.7rem;
    padding: 0.8rem 1rem 0.6rem;
    border-bottom: 1px solid var(--surface-2);
  }
  .settings-head h2 {
    margin: 0;
    font-size: 0.95rem;
    font-weight: 600;
  }
  .settings-search {
    flex: 1;
    font: inherit;
    font-size: 0.82rem;
    padding: 0.3rem 0.55rem;
    background: var(--surface-2);
    color: inherit;
    border: 1px solid transparent;
    border-radius: 4px;
    outline: none;
  }
  .settings-search:focus {
    border-color: color-mix(in srgb, var(--text-muted) 50%, transparent);
  }
  .settings-close {
    font: inherit;
    background: transparent;
    border: none;
    color: var(--text-muted);
    cursor: pointer;
    padding: 0.2rem 0.35rem;
    border-radius: 4px;
  }
  .settings-close:hover {
    color: inherit;
    background: var(--surface-2);
  }
  .settings-body {
    overflow-y: auto;
    padding: 0.4rem 1rem 0.9rem;
  }
  .settings-empty {
    margin: 0.8rem 0;
    font-size: 0.82rem;
    color: var(--text-muted);
  }
  .settings-section h3 {
    margin: 0.9rem 0 0.3rem;
    font-size: 0.72rem;
    font-weight: 600;
    text-transform: uppercase;
    letter-spacing: 0.04em;
    color: var(--text-muted);
  }
  .setting-row {
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: 1rem;
    padding: 0.45rem 0.6rem;
    border-left: 2px solid transparent;
    border-radius: 4px;
  }
  .setting-row:hover {
    background: color-mix(in srgb, var(--surface-2) 50%, transparent);
  }
  .setting-row.modified {
    /* VS Code's "this differs from the default" gutter bar. */
    border-left-color: #4a87c5;
  }
  .setting-text {
    display: flex;
    flex-direction: column;
    gap: 0.1rem;
    min-width: 0;
  }
  .setting-label {
    font-size: 0.82rem;
  }
  .setting-desc {
    font-size: 0.74rem;
    color: var(--text-muted);
    line-height: 1.35;
  }
  .setting-control {
    display: flex;
    align-items: center;
    gap: 0.45rem;
    flex-shrink: 0;
  }
  .setting-control select,
  .setting-control input[type="number"],
  .setting-control input[type="text"] {
    font: inherit;
    font-size: 0.78rem;
    padding: 0.25rem 0.45rem;
    background: var(--surface-2);
    color: inherit;
    border: 1px solid color-mix(in srgb, var(--text-muted) 30%, transparent);
    border-radius: 4px;
  }
  .setting-control input[type="number"] {
    width: 5.5rem;
  }
  .setting-control input[type="text"] {
    width: 12rem;
  }
  .setting-reset {
    font: inherit;
    background: transparent;
    border: none;
    color: var(--text-muted);
    cursor: pointer;
    padding: 0 0.2rem;
    border-radius: 4px;
  }
  .setting-reset:hover {
    color: inherit;
    background: var(--surface-2);
  }
</style>
