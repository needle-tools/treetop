<script lang="ts" context="module">
  export interface EditorDescriptor {
    name: string;
    cmd: string;
  }
  export interface RemoteRef {
    name: string;
    url: string;
    webUrl: string | null;
    provider: string | null;
    host: string | null;
  }
  export interface CustomLink {
    id: string;
    url: string;
    name?: string;
  }
</script>

<script lang="ts">
  /**
   * Row-actions strip: the cluster of "open in <X>" buttons (editors,
   * Fork, terminal, file manager, web remotes, and user-defined custom
   * links). Used in two places:
   *   - expanded row-body, full labels.
   *   - folded row-head, icons only, right-aligned just left of the
   *     zen button.
   *
   * Custom links show the target site's favicon (fetched via the daemon
   * proxy at `/api/favicon?url=…`) with a fallback to the generic link
   * glyph when the proxy can't resolve one. The leading `+` chip is a
   * compact 22px round affordance that opens a Popover (shared shell
   * from Popover.svelte) for entering the URL + optional label.
   */
  import OpenInButton from "./OpenInButton.svelte";
  import Popover from "./Popover.svelte";
  import { iconFor } from "./icons";
  import { confirmDialog } from "./confirm-dialog";

  export let path: string;
  export let editors: EditorDescriptor[] = [];
  export let remotes: RemoteRef[] = [];
  export let customLinks: CustomLink[] = [];
  export let openIn: (path: string, app: string) => void;
  export let openRemote: (remote: RemoteRef) => void;
  /** Add-link handler, supplied by the parent which owns the fetch. The
   *  popover collects (url, name?) and calls this; resolves true on
   *  success so we can close the popover. */
  export let onAddCustomLink:
    | ((input: { url: string; name?: string }) => Promise<boolean>)
    | null = null;
  /** Remove-link handler. Same contract — the parent owns the fetch. */
  export let onRemoveCustomLink: ((linkId: string) => Promise<void>) | null =
    null;
  export let iconOnly: boolean = false;

  const PROVIDER_LABELS: Record<string, string> = {
    github: "GitHub",
    gitlab: "GitLab",
    bitbucket: "Bitbucket",
    azure: "Azure",
    codeberg: "Codeberg",
    sourcehut: "sourcehut",
    gitea: "Gitea",
  };

  function fileManagerLabel(): string {
    if (typeof navigator === "undefined") return "Files";
    const ua = navigator.userAgent;
    if (/Mac|iPhone|iPad/.test(ua)) return "Finder";
    if (/Win/.test(ua)) return "Explorer";
    return "Files";
  }

  function fileManagerIcon(): string {
    if (typeof navigator === "undefined") return "files";
    const ua = navigator.userAgent;
    if (/Mac|iPhone|iPad/.test(ua)) return "finder";
    if (/Win/.test(ua)) return "explorer";
    return "files";
  }

  function remoteButtonLabel(remote: RemoteRef): string {
    const base =
      (remote.provider ? PROVIDER_LABELS[remote.provider] : null) ??
      remote.host ??
      remote.name;
    return remote.name === "origin" ? base : `${base} (${remote.name})`;
  }

  function linkLabel(link: CustomLink): string {
    if (link.name && link.name.trim().length > 0) return link.name;
    try {
      return new URL(link.url).host;
    } catch {
      return link.url;
    }
  }

  /** Favicons sometimes fail to load — corporate auth pages, captive
   *  portals, or sites that genuinely don't ship one. Once an <img>
   *  errors we mark it failed in a Set keyed by linkId so we render the
   *  generic link glyph instead. The set is per-component-instance: a
   *  refresh resets it (the user may have fixed the upstream by then). */
  let failedFavicons: Set<string> = new Set();
  function markFaviconFailed(id: string) {
    if (failedFavicons.has(id)) return;
    failedFavicons = new Set([...failedFavicons, id]);
  }

  $: linkIconDef = iconFor("link");

  let addOpen = false;
  let newUrl = "";
  let newName = "";
  let adding = false;
  let addError = "";
  let urlInput: HTMLInputElement | undefined;
  let anchorEl: HTMLSpanElement | undefined;

  function toggleAdd() {
    addOpen = !addOpen;
    if (addOpen) {
      newUrl = "";
      newName = "";
      addError = "";
      // Focus the URL input after Svelte commits the conditional.
      setTimeout(() => urlInput?.focus(), 0);
    }
  }

  async function submitAdd() {
    if (!onAddCustomLink) return;
    const url = newUrl.trim();
    if (url.length === 0) {
      addError = "URL required.";
      return;
    }
    adding = true;
    addError = "";
    try {
      const ok = await onAddCustomLink({
        url,
        name: newName.trim() || undefined,
      });
      if (ok) {
        addOpen = false;
        newUrl = "";
        newName = "";
      } else {
        addError = "Couldn't add — server rejected the URL.";
      }
    } catch (e) {
      addError = e instanceof Error ? e.message : String(e);
    } finally {
      adding = false;
    }
  }

  function openLink(link: CustomLink) {
    window.open(link.url, "_blank", "noopener,noreferrer");
  }

  async function removeLink(link: CustomLink, ev: MouseEvent) {
    ev.preventDefault();
    ev.stopPropagation();
    if (!onRemoveCustomLink) return;
    const label = linkLabel(link);
    const ok = await confirmDialog({
      title: `Remove the “${label}” link?`,
      message: link.url,
      confirmLabel: "Remove",
      danger: true,
    });
    if (!ok) return;
    await onRemoveCustomLink(link.id);
  }

  function onPopoverKeydown(ev: KeyboardEvent) {
    if (ev.key === "Escape") {
      ev.preventDefault();
      addOpen = false;
    }
  }

  /** Dismiss on outside-click. Same pattern used by App.svelte for its
   *  other popovers — check whether the click landed on the anchor span
   *  (the `+` button + popover sit inside it). Using `mousedown` so the
   *  popover closes before any click-handler inside competing UI fires. */
  function onWindowMouseDown(ev: MouseEvent) {
    if (!addOpen || !anchorEl) return;
    const target = ev.target;
    if (target instanceof Node && anchorEl.contains(target)) return;
    addOpen = false;
  }
</script>

<svelte:window on:mousedown={onWindowMouseDown} />

<div class="row-actions" class:icon-only={iconOnly}>
  {#if onAddCustomLink}
    <span class="add-link-anchor" bind:this={anchorEl}>
      <button
        type="button"
        class="tiny open-in-btn add-link-btn"
        class:open={addOpen}
        title="Add a custom link (e.g. Coolify dashboard) to this repo's open-in row"
        aria-label="Add custom link"
        on:click={toggleAdd}
      >
        <span class="add-link-glyph" aria-hidden="true">+</span>
      </button>
      {#if addOpen}
        <Popover variant="agents" extraClass="custom-link-popover">
          <svelte:fragment slot="head">Add a custom link</svelte:fragment>
          <div class="custom-link-form" on:keydown={onPopoverKeydown} role="group">
            <label class="custom-link-field">
              <span class="custom-link-label">URL</span>
              <input
                bind:this={urlInput}
                class="custom-link-input"
                type="url"
                placeholder="https://…"
                bind:value={newUrl}
                disabled={adding}
                on:keydown={(e) => {
                  if (e.key === "Enter") submitAdd();
                }}
              />
            </label>
            <label class="custom-link-field">
              <span class="custom-link-label">Label <span class="muted">(optional)</span></span>
              <input
                class="custom-link-input"
                type="text"
                placeholder=""
                bind:value={newName}
                disabled={adding}
                on:keydown={(e) => {
                  if (e.key === "Enter") submitAdd();
                }}
              />
            </label>
            {#if addError}
              <div class="custom-link-error">{addError}</div>
            {/if}
            <div class="custom-link-buttons">
              <button
                type="button"
                class="tiny custom-link-cancel"
                on:click={() => (addOpen = false)}
                disabled={adding}
              >Cancel</button>
              <button
                type="button"
                class="tiny custom-link-go"
                on:click={submitAdd}
                disabled={adding || newUrl.trim().length === 0}
              >{adding ? "Adding…" : "Add link"}</button>
            </div>
          </div>
        </Popover>
      {/if}
    </span>
  {/if}
  {#each customLinks as link (link.id)}
    {@const label = linkLabel(link)}
    {@const failed = failedFavicons.has(link.id)}
    <span class="custom-link-wrap" class:icon-only={iconOnly}>
      <button
        type="button"
        class="tiny open-in-btn custom-link-btn"
        class:icon-only={iconOnly}
        title={`Open ${link.url} in browser`}
        on:click={(ev) => {
          if (ev.shiftKey) return removeLink(link, ev);
          openLink(link);
        }}
        on:contextmenu={(ev) => removeLink(link, ev)}
      >
        {#if !failed}
          <img
            class="custom-link-favicon"
            src={`/api/favicon?url=${encodeURIComponent(link.url)}`}
            alt=""
            width="14"
            height="14"
            on:error={() => markFaviconFailed(link.id)}
          />
        {:else if linkIconDef}
          <svg
            class="open-in-icon"
            viewBox="0 0 24 24"
            width="13"
            height="13"
            aria-hidden="true"
          >
            {#each linkIconDef.paths ?? [] as d}
              <path {d} />
            {/each}
          </svg>
        {/if}
        {#if !iconOnly}
          <span>{label}</span>
        {/if}
      </button>
      {#if onRemoveCustomLink && !iconOnly}
        <!-- Remove `x` — hover-revealed on the wrap. Skipped in
             iconOnly mode (folded row-head) since the chip's already a
             22px circle and there's no room for a kebab; users
             shift-click or right-click there instead. -->
        <button
          type="button"
          class="custom-link-x"
          title={`Remove this link`}
          aria-label={`Remove ${label}`}
          on:click={(ev) => removeLink(link, ev)}
        >×</button>
      {/if}
    </span>
  {/each}
  {#if customLinks.length > 0}
    <!-- Extra spacer between user-defined links (left) and the
         built-in actions (right). Only renders when there's at least
         one custom link to separate — when the left group is empty
         (or only has the `+` chip) the normal flex gap is enough. -->
    <span class="action-gap" aria-hidden="true"></span>
  {/if}
  {#each editors as ed}
    <OpenInButton
      icon={ed.cmd}
      label={ed.name}
      title={`Open in ${ed.name}`}
      onClick={() => openIn(path, ed.cmd)}
      {iconOnly}
    />
  {/each}
  <OpenInButton
    icon="fork"
    label="Fork"
    title="Open in Fork"
    onClick={() => openIn(path, "fork")}
    {iconOnly}
  />
  <OpenInButton
    icon="terminal"
    label="Terminal"
    title="Open in terminal"
    onClick={() => openIn(path, "terminal")}
    {iconOnly}
  />
  <OpenInButton
    icon={fileManagerIcon()}
    label={fileManagerLabel()}
    title="Reveal in file manager"
    onClick={() => openIn(path, "files")}
    {iconOnly}
  />
  {#each remotes.filter((r) => r.webUrl) as remote}
    <OpenInButton
      icon={remote.provider ?? "git"}
      label={remoteButtonLabel(remote)}
      title={`Open ${remote.name} (${remote.url}) in browser`}
      onClick={() => openRemote(remote)}
      {iconOnly}
    />
  {/each}
</div>

<style>
  /* The anchor wraps the `+` chip AND the popover so the popover can
     position itself absolutely against the anchor and the outside-
     click handler can use `anchorEl.contains(target)`. */
  .add-link-anchor {
    position: relative;
    display: inline-flex;
    align-items: center;
  }

  /* `+` chip — uses the same rounded-rect treatment as the other
     .tiny .open-in-btn buttons (border-radius inherited from the
     global `button` baseline = var(--radius-md)). Just a glyph-only
     button with the same outline hover affordance. */
  .add-link-btn {
    display: inline-flex;
    align-items: center;
    justify-content: center;
    line-height: 1;
    outline: 1px solid transparent;
    outline-offset: -1px;
    transition: outline-color 0.15s;
  }
  .add-link-btn:hover:not(:disabled) {
    outline-color: color-mix(in srgb, var(--text-muted) 60%, transparent);
  }
  .add-link-btn.open {
    outline-color: color-mix(in srgb, var(--text-muted) 80%, transparent);
  }
  .add-link-glyph {
    display: inline-block;
    line-height: 1;
    font-weight: 400;
    font-size: 13px;
    color: var(--text-muted);
  }

  /* Pair the link button + its hover-revealed `x` so they live in one
     hover region — moving the cursor between them doesn't flicker the
     x away. `:focus-within` keeps the x visible while the link is
     keyboard-focused. */
  .custom-link-wrap {
    position: relative;
    display: inline-flex;
    align-items: center;
  }
  .custom-link-x {
    position: absolute;
    top: -4px;
    right: -4px;
    width: 14px;
    height: 14px;
    border-radius: 50%;
    border: none;
    padding: 0;
    background: color-mix(in srgb, #c0392b 78%, transparent);
    color: #fff;
    font-size: 11px;
    line-height: 1;
    cursor: pointer;
    opacity: 0;
    transition: opacity 0.12s;
    display: inline-flex;
    align-items: center;
    justify-content: center;
  }
  .custom-link-wrap:hover .custom-link-x,
  .custom-link-wrap:focus-within .custom-link-x,
  .custom-link-x:hover,
  .custom-link-x:focus-visible {
    opacity: 1;
  }
  .custom-link-x:hover {
    background: #c0392b;
  }

  .custom-link-btn {
    display: inline-flex;
    align-items: center;
    gap: 0.3rem;
    line-height: 1;
    outline: 1px solid transparent;
    outline-offset: -1px;
    transition: outline-color 0.15s;
  }
  .custom-link-btn:hover {
    outline-color: color-mix(in srgb, var(--text-muted) 60%, transparent);
  }

  /* Extra breathing room between the user-defined links group (left)
     and the built-in actions group (right). Pure spacer — no border,
     no background. Renders only when there's at least one custom
     link, otherwise the normal flex gap is enough. */
  .action-gap {
    display: inline-block;
    width: 0.8rem;
    height: 1px;
    flex: 0 0 auto;
  }
  .custom-link-favicon {
    flex: 0 0 auto;
    width: 14px;
    height: 14px;
    border-radius: 2px;
    object-fit: contain;
    background: color-mix(in srgb, var(--chip-default-bg) 30%, transparent);
  }
  .custom-link-btn.icon-only {
    padding: 0;
    width: 22px;
    height: 22px;
    border-radius: 50%;
    background: transparent;
    border-color: transparent;
    justify-content: center;
  }
  .custom-link-btn.icon-only:hover {
    background: color-mix(in srgb, var(--chip-default-bg) 55%, transparent);
  }
  .custom-link-btn.icon-only .custom-link-favicon {
    width: 16px;
    height: 16px;
    border-radius: 3px;
  }
  .open-in-icon {
    flex: 0 0 auto;
    fill: none;
    stroke: currentColor;
    stroke-width: 1.8;
    stroke-linecap: round;
    stroke-linejoin: round;
  }

  /* Popover-internal form — vertical stack with labelled inputs. The
     popover's outer width / padding / border-radius come from
     `.agents-popover` in popover.css; the `.custom-link-popover`
     :global() rule below tightens the default 380px min-width down to
     something proportional for a two-field form. */
  .custom-link-form {
    display: flex;
    flex-direction: column;
    gap: 0.4rem;
  }
  .custom-link-field {
    display: flex;
    flex-direction: column;
    gap: 0.15rem;
  }
  .custom-link-label {
    font-size: 0.7rem;
    color: var(--text-muted);
  }
  .custom-link-input {
    font: inherit;
    font-size: 0.85em;
    padding: 0.2rem 0.4rem;
    border-radius: 3px;
    border: 1px solid color-mix(in srgb, var(--text-muted) 40%, transparent);
    background: var(--bg, transparent);
    color: inherit;
    min-width: 0;
    width: 100%;
    box-sizing: border-box;
  }
  .custom-link-error {
    color: var(--err, #d05050);
    font-size: 0.8em;
  }
  .custom-link-buttons {
    display: flex;
    justify-content: flex-end;
    gap: 0.3rem;
    margin-top: 0.15rem;
  }

  /* Override the agents-popover defaults: the shared shell ships with
     min-width 380px for the wide picker lists, way too wide for our
     compact URL+label form. Constrain to ~240px so the popover hugs
     its contents. `:global()` is required because the popover root
     lives outside this component's scope hash. */
  :global(.custom-link-popover) {
    min-width: 240px;
    width: 240px;
    padding: 0.45rem 0.55rem;
  }
</style>
