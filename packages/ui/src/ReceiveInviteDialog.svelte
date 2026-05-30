<script lang="ts">
  /**
   * Receiver-side invite dialog. Subscribes to `activeInvite` and
   * fetches the matching offer from `GET /api/sessions/invites` so we
   * can show the user exactly what's being offered: title, repo,
   * origin machine, agent, turn count, transcript size, and whether
   * the sender included tool outputs. Accept / Decline post to the
   * matching daemon route.
   */
  import { apiUrl } from "./api";
  import { activeInvite, closeInvite } from "./receive-invite-dialog";
  import { requestSessionFocus } from "./session-focus-store";

  interface InviteManifest {
    offerId: string;
    sid: string;
    title: string;
    agent: string;
    turnCount: number;
    summary?: string;
    originMachine: string;
    originMachineLabel: string;
    originPlatform: string;
    originRepoRemote: string;
    originRepoName: string;
    originRepoPath: string;
    originWorktreePath?: string;
    createdAt: string;
    sentAt: string;
    bytes: number;
    toolOutputs: "stripped" | "included";
    strippedCount: number;
    secrets?: "redacted" | "raw";
    redactionCount?: number;
  }
  interface InviteCard {
    manifest: InviteManifest;
    receivedAt: string;
    needsClone: boolean;
  }

  interface Divergence {
    commonPrefix: number;
    existingAfter: number;
    incomingAfter: number;
    supersetOfExisting: boolean;
    diverged: boolean;
  }

  let invite: InviteCard | null = null;
  let loading = false;
  let actionPending = false;
  let action:
    | { kind: "ok"; message: string }
    | { kind: "err"; message: string }
    | null = null;
  /** Set when a previous accept attempt returned 409 "exists" — the
   *  dialog then shows the conflict view with three buttons (replace
   *  / keep both / cancel) instead of the normal Accept button. */
  let conflict: Divergence | null = null;
  /** Set after a successful accept — drives the post-accept "imported"
   *  view that shows where the session landed (repo + filename) and a
   *  "Go to session" button. We deliberately do NOT auto-close: the
   *  user asked for an explicit destination read-out. */
  let imported: {
    importedAs: string;
    title: string;
    repoName: string;
    agent: string;
    mode: "fresh" | "replace" | "keep_both";
  } | null = null;

  let lastOfferId: string | null = null;
  $: if ($activeInvite && $activeInvite.offerId !== lastOfferId) {
    lastOfferId = $activeInvite.offerId;
    invite = null;
    action = null;
    conflict = null;
    imported = null;
    void loadInvite($activeInvite.offerId);
  }
  $: if (!$activeInvite) {
    lastOfferId = null;
    invite = null;
    action = null;
    conflict = null;
    imported = null;
  }

  async function loadInvite(offerId: string) {
    loading = true;
    try {
      const res = await fetch(apiUrl("/api/sessions/invites"));
      const body = (await res.json().catch(() => null)) as {
        invites?: InviteCard[];
      } | null;
      const match = body?.invites?.find((i) => i.manifest.offerId === offerId);
      invite = match ?? null;
      if (!match)
        action = { kind: "err", message: "Invite no longer pending." };
    } catch (e) {
      action = {
        kind: "err",
        message: e instanceof Error ? e.message : String(e),
      };
    } finally {
      loading = false;
    }
  }

  async function accept(mode?: "replace" | "keep_both") {
    if (!invite || actionPending) return;
    actionPending = true;
    action = null;
    try {
      const res = await fetch(
        apiUrl(`/api/sessions/invites/${encodeURIComponent(invite.manifest.offerId)}/accept`),
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(mode ? { mode } : {}),
        },
      );
      if (res.status === 409) {
        const body = (await res.json().catch(() => null)) as {
          error?: string;
          remote?: string;
          divergence?: Divergence;
        } | null;
        if (body?.error === "exists" && body.divergence) {
          // Surface the three-button conflict view instead of an error.
          conflict = body.divergence;
          return;
        }
        action = {
          kind: "err",
          message: `Clone the repo first: ${body?.remote ?? invite.manifest.originRepoRemote}`,
        };
        return;
      }
      if (!res.ok) {
        const body = (await res.json().catch(() => null)) as {
          error?: string;
        } | null;
        action = { kind: "err", message: body?.error ?? `HTTP ${res.status}` };
        return;
      }
      const body = (await res.json().catch(() => null)) as {
        sid?: string;
        importedAs?: string;
        title?: string;
        repoName?: string;
        agent?: string;
      } | null;
      // Show a post-accept summary instead of auto-closing — the user
      // asked for an explicit "where did it land" read-out with a
      // button to navigate to the freshly imported session.
      if (body?.importedAs) {
        imported = {
          importedAs: body.importedAs,
          title: body.title || invite.manifest.title,
          repoName: body.repoName || invite.manifest.originRepoName,
          agent: body.agent || invite.manifest.agent,
          mode:
            mode === "replace"
              ? "replace"
              : mode === "keep_both"
                ? "keep_both"
                : "fresh",
        };
        conflict = null;
      } else {
        action = {
          kind: "ok",
          message:
            mode === "replace"
              ? "Replaced. Session updated."
              : mode === "keep_both"
                ? "Saved alongside the existing copy."
                : "Accepted. Session imported.",
        };
        setTimeout(() => closeInvite(), 1200);
      }
    } catch (e) {
      action = {
        kind: "err",
        message: e instanceof Error ? e.message : String(e),
      };
    } finally {
      actionPending = false;
    }
  }

  async function decline() {
    if (!invite || actionPending) return;
    actionPending = true;
    action = null;
    try {
      const res = await fetch(
        apiUrl(`/api/sessions/invites/${encodeURIComponent(invite.manifest.offerId)}/decline`),
        { method: "POST" },
      );
      if (!res.ok && res.status !== 204) {
        action = { kind: "err", message: `HTTP ${res.status}` };
        return;
      }
      action = { kind: "ok", message: "Declined." };
      setTimeout(() => closeInvite(), 800);
    } catch (e) {
      action = {
        kind: "err",
        message: e instanceof Error ? e.message : String(e),
      };
    } finally {
      actionPending = false;
    }
  }

  function goToSession() {
    if (!imported) return;
    requestSessionFocus(imported.importedAs);
    closeInvite();
  }

  function fmtBytes(n: number): string {
    if (n < 1024) return `${n} B`;
    if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
    return `${(n / 1024 / 1024).toFixed(2)} MB`;
  }

  function onKeydown(ev: KeyboardEvent) {
    if (!$activeInvite) return;
    if (ev.key === "Escape") {
      ev.preventDefault();
      closeInvite();
    }
  }
</script>

<svelte:window on:keydown={onKeydown} />

{#if $activeInvite}
  <div
    class="invite-overlay"
    on:click={closeInvite}
    on:keydown|stopPropagation
    role="presentation"
  >
    <div
      class="invite-dialog"
      role="dialog"
      aria-modal="true"
      aria-labelledby="invite-title"
      on:click|stopPropagation
    >
      {#if loading}
        <p class="invite-loading">Loading invite…</p>
      {:else if !invite}
        <h2 id="invite-title" class="invite-title">Invite not found</h2>
        <p class="invite-body">
          {action?.kind === "err"
            ? action.message
            : "It may have been accepted or declined already."}
        </p>
        <div class="invite-buttons">
          <button type="button" class="invite-btn" on:click={closeInvite}
            >Close</button
          >
        </div>
      {:else if imported}
        <h2 id="invite-title" class="invite-title">
          {imported.mode === "replace"
            ? "Session updated"
            : imported.mode === "keep_both"
              ? "Session saved alongside existing copy"
              : "Session imported"}
        </h2>
        <dl class="invite-meta">
          <div>
            <dt>name</dt>
            <dd class="invite-ellipsis" title={imported.title || "(untitled)"}>
              {imported.title || "(untitled)"}
            </dd>
          </div>
          <div>
            <dt>repo</dt>
            <dd class="invite-ellipsis" title={imported.repoName || "—"}>
              {imported.repoName || "—"}
            </dd>
          </div>
          <div>
            <dt>agent</dt>
            <dd>{imported.agent}</dd>
          </div>
          <div>
            <dt>file</dt>
            <dd
              class="invite-path invite-ellipsis"
              title={imported.importedAs}
            >
              {imported.importedAs}
            </dd>
          </div>
        </dl>
        <div class="invite-buttons">
          <button
            type="button"
            class="invite-btn"
            on:click={closeInvite}>Close</button
          >
          <button
            type="button"
            class="invite-btn invite-accept"
            on:click={goToSession}>Go to session</button
          >
        </div>
      {:else}
        <h2 id="invite-title" class="invite-title">{invite.manifest.title}</h2>

        <dl class="invite-meta">
          <div>
            <dt>from</dt>
            <dd>{invite.manifest.originMachineLabel}</dd>
          </div>
          <div>
            <dt>repo</dt>
            <dd>{invite.manifest.originRepoName}</dd>
          </div>
          <div>
            <dt>remote</dt>
            <dd class="invite-remote">{invite.manifest.originRepoRemote}</dd>
          </div>
          <div>
            <dt>agent</dt>
            <dd>{invite.manifest.agent}</dd>
          </div>
          <div>
            <dt>turns</dt>
            <dd>{invite.manifest.turnCount}</dd>
          </div>
          <div>
            <dt>size</dt>
            <dd>{fmtBytes(invite.manifest.bytes)}</dd>
          </div>
          <div>
            <dt>tool outputs</dt>
            <dd>
              {#if invite.manifest.toolOutputs === "stripped"}
                <span class="invite-pill ok"
                  >stripped ({invite.manifest.strippedCount})</span
                >
              {:else}
                <span class="invite-pill warn">included — full transcript</span>
              {/if}
            </dd>
          </div>
          <div>
            <dt>secrets</dt>
            <dd>
              {#if invite.manifest.secrets === "raw"}
                <span class="invite-pill warn">NOT redacted</span>
              {:else}
                <span class="invite-pill ok">
                  redacted{#if (invite.manifest.redactionCount ?? 0) > 0}
                    ({invite.manifest.redactionCount}){/if}
                </span>
              {/if}
            </dd>
          </div>
        </dl>

        {#if invite.manifest.summary}
          <p class="invite-summary">{invite.manifest.summary}</p>
        {/if}

        {#if invite.needsClone}
          <p class="invite-warn">
            This repo isn't cloned locally. Add <code
              >{invite.manifest.originRepoRemote}</code
            > as a repo first, then re-open this invite.
          </p>
        {/if}

        {#if action}
          <p
            class="invite-result {action.kind === 'ok' ? 'ok' : 'err'}"
            role="alert"
          >
            {action.message}
          </p>
        {/if}

        {#if conflict}
          <div class="invite-conflict">
            {#if conflict.supersetOfExisting}
              <p class="invite-conflict-head">
                You already have this session. The new offer adds <strong
                  >{conflict.incomingAfter}</strong
                >
                message{conflict.incomingAfter === 1 ? "" : "s"} on top of the existing
                {conflict.commonPrefix} you have.
              </p>
            {:else}
              <p class="invite-conflict-head">
                Diverged from your copy at message {conflict.commonPrefix}. You
                have <strong>{conflict.existingAfter}</strong>
                message{conflict.existingAfter === 1 ? "" : "s"} the sender doesn't;
                sender has
                <strong>{conflict.incomingAfter}</strong>
                message{conflict.incomingAfter === 1 ? "" : "s"} you don't.
              </p>
            {/if}
            <p class="invite-conflict-help">
              <strong>Replace</strong> overwrites your local copy.
              <strong>Keep both</strong> saves the incoming next to it as a
              sibling file.
              <strong>Cancel</strong> leaves everything alone.
            </p>
            <div class="invite-buttons">
              <button
                type="button"
                class="invite-btn"
                disabled={actionPending}
                on:click={() => {
                  conflict = null;
                }}>Cancel</button
              >
              <button
                type="button"
                class="invite-btn"
                disabled={actionPending}
                on:click={() => accept("keep_both")}>Keep both</button
              >
              <button
                type="button"
                class="invite-btn invite-accept"
                disabled={actionPending}
                on:click={() => accept("replace")}
                >{conflict.supersetOfExisting ? "Update" : "Replace"}</button
              >
            </div>
          </div>
        {:else}
          <div class="invite-buttons">
            <button
              type="button"
              class="invite-btn invite-decline"
              disabled={actionPending}
              on:click={decline}>Decline</button
            >
            <button
              type="button"
              class="invite-btn invite-accept"
              disabled={actionPending || invite.needsClone}
              on:click={() => accept()}
              >{invite.needsClone ? "Clone first" : "Accept"}</button
            >
          </div>
        {/if}
      {/if}
    </div>
  </div>
{/if}

<style>
  .invite-overlay {
    position: fixed;
    inset: 0;
    background: rgba(0, 0, 0, 0.5);
    display: flex;
    align-items: center;
    justify-content: center;
    z-index: 2000;
    backdrop-filter: blur(2px);
  }
  .invite-dialog {
    min-width: 420px;
    max-width: min(560px, 92vw);
    background: var(--surface-1);
    color: var(--text, inherit);
    border: 1px solid var(--surface-2);
    border-radius: var(--radius-md, 8px);
    box-shadow: 0 12px 32px rgba(0, 0, 0, 0.5);
    padding: 1rem 1.1rem;
    display: flex;
    flex-direction: column;
    gap: 0.7rem;
  }
  .invite-loading {
    margin: 0;
    font-size: 0.85rem;
    color: var(--text-muted);
  }
  .invite-title {
    margin: 0;
    font-size: 1rem;
    font-weight: 600;
    line-height: 1.3;
    /* Long titles (incoming-invite view shows the sender's free-text
       title verbatim) would push the dialog past its max-width and
       trigger horizontal overflow. Clamp to two lines + ellipsis. */
    display: -webkit-box;
    -webkit-line-clamp: 2;
    -webkit-box-orient: vertical;
    overflow: hidden;
    overflow-wrap: anywhere;
  }
  .invite-body {
    margin: 0;
    font-size: 0.85rem;
    color: var(--text-muted);
  }
  .invite-meta {
    display: grid;
    grid-template-columns: max-content 1fr;
    gap: 0.25rem 0.7rem;
    margin: 0;
    font-size: 0.8rem;
  }
  .invite-meta > div {
    display: contents;
  }
  .invite-meta dt {
    color: var(--text-muted);
  }
  .invite-meta dd {
    margin: 0;
    color: inherit;
    word-break: break-all;
    /* Without min-width: 0 a grid `1fr` track is sized by its content
       min-width (longest unbreakable token) instead of the available
       column space — paths without spaces would otherwise stretch the
       cell and force the dialog wider than its max-width. */
    min-width: 0;
  }
  /* Single-line ellipsis variant used for paths + session titles in the
     post-accept summary. Pair with title="…" for hover tooltip so the
     full string remains discoverable. */
  .invite-ellipsis {
    white-space: nowrap;
    overflow: hidden;
    text-overflow: ellipsis;
    word-break: normal;
  }
  .invite-remote {
    font-family: var(--font-mono, ui-monospace, monospace);
    font-size: 0.75rem;
  }
  .invite-path {
    font-family: var(--font-mono, ui-monospace, monospace);
    font-size: 0.72rem;
    color: var(--text-muted);
    word-break: break-all;
  }
  .invite-pill {
    display: inline-block;
    padding: 0.1rem 0.45rem;
    border-radius: 999px;
    font-size: 0.72rem;
    line-height: 1.4;
  }
  .invite-pill.ok {
    background: color-mix(in srgb, #2ecc71 22%, transparent);
    color: color-mix(in srgb, #2ecc71 90%, var(--text));
  }
  .invite-pill.warn {
    background: color-mix(in srgb, #c0392b 22%, transparent);
    color: #fff;
  }
  .invite-summary {
    margin: 0;
    font-size: 0.8rem;
    line-height: 1.45;
    padding: 0.5rem 0.6rem;
    background: color-mix(in srgb, var(--surface-2) 40%, transparent);
    border-radius: 4px;
    color: var(--text-muted);
  }
  .invite-warn {
    margin: 0;
    font-size: 0.8rem;
    line-height: 1.45;
    padding: 0.5rem 0.6rem;
    background: color-mix(in srgb, #d35400 22%, transparent);
    color: color-mix(in srgb, #d35400 90%, var(--text));
    border-radius: 4px;
  }
  .invite-warn code {
    font-size: 0.78rem;
  }
  .invite-result {
    margin: 0;
    font-size: 0.8rem;
    padding: 0.45rem 0.6rem;
    border-radius: 4px;
  }
  .invite-result.ok {
    background: color-mix(in srgb, #2ecc71 18%, transparent);
    color: color-mix(in srgb, #2ecc71 90%, var(--text));
  }
  .invite-result.err {
    background: color-mix(in srgb, #c0392b 22%, transparent);
    color: #fff;
  }
  .invite-conflict {
    display: flex;
    flex-direction: column;
    gap: 0.55rem;
    padding: 0.6rem 0.7rem;
    background: color-mix(in srgb, #d35400 12%, transparent);
    border: 1px solid color-mix(in srgb, #d35400 35%, transparent);
    border-radius: 4px;
  }
  .invite-conflict-head {
    margin: 0;
    font-size: 0.82rem;
    line-height: 1.45;
    color: var(--text-1, inherit);
  }
  .invite-conflict-help {
    margin: 0;
    font-size: 0.75rem;
    line-height: 1.4;
    color: var(--text-muted);
  }
  .invite-buttons {
    display: flex;
    justify-content: flex-end;
    gap: 0.5rem;
    margin-top: 0.2rem;
  }
  .invite-btn {
    font: inherit;
    font-size: 0.85rem;
    padding: 0.35rem 0.85rem;
    border-radius: 4px;
    border: 1px solid color-mix(in srgb, var(--text-muted) 40%, transparent);
    background: transparent;
    color: inherit;
    cursor: pointer;
  }
  .invite-btn:disabled {
    opacity: 0.5;
    cursor: not-allowed;
  }
  .invite-decline:hover:not(:disabled),
  .invite-decline:focus-visible:not(:disabled) {
    background: color-mix(in srgb, var(--chip-default-bg) 45%, transparent);
    outline: none;
  }
  .invite-accept {
    background: color-mix(in srgb, #2ecc71 24%, transparent);
  }
  .invite-accept:hover:not(:disabled),
  .invite-accept:focus-visible:not(:disabled) {
    background: color-mix(in srgb, #2ecc71 40%, transparent);
    outline: none;
  }
</style>
