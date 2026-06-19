<script lang="ts">
  import { createEventDispatcher } from "svelte";
  import AgentIcon from "./AgentIcon.svelte";
  import Popover from "./Popover.svelte";
  import { repoChipFg } from "./display-helpers";
  import RowNoteActions from "./RowNoteActions.svelte";
  import RowNotesListPopover from "./RowNotesListPopover.svelte";
  import RowStatusBadges from "./RowStatusBadges.svelte";
  import SessionSearchList from "./SessionSearchList.svelte";
  import WorkspaceSessionPreview from "./WorkspaceSessionPreview.svelte";
  import ZenToggleButton from "./ZenToggleButton.svelte";
  import type { NoteShape } from "./notes-counts";
  import type {
    AgentSession,
    WorkspacePreviewRow,
    WorkspacePreviewSession,
  } from "./repo-types";

  export let row: WorkspacePreviewRow;
  export let noteCount = 0;
  export let notes: NoteShape[] = [];
  export let notesVisible = true;
  export let notesListOpen = false;
  export let emojiOpen = false;
  export let zen = false;
  export let selectedSource: string | null = null;

  type NoteActionDetail = {
    kind: "note" | "link" | "emoji";
    body?: string;
    originRect: DOMRect;
  };

  const dispatch = createEventDispatcher<{
    addNote: NoteActionDetail;
    closeEmoji: void;
    loadSummary: { path: string };
    pull: { path: string };
    push: { path: string };
    renameRepo: { name: string };
    setRepoColor: { color: string | null };
    toggleEmoji: void;
    toggleFold: void;
    toggleNotes: void;
    toggleNotesList: void;
    toggleZen: void;
    closeSession: WorkspacePreviewSession;
  }>();

  let repoEditOpen = false;
  let branchPickerOpen = false;
  let newAgentOpen = false;
  let sessionsPickerOpen = false;
  let sessionSearchOpen = false;
  let sessionSearchQuery = "";
  let wtPickerOpen = false;
  let previewRepoName = row.repo.name;
  let previewRepoColor = row.repo.color ?? "#60b74c";
  let previewBranch = row.worktree.branch;
  let newBranchName = "";

  $: repoStyle = row.repo.color
    ? `--repo-bg: ${row.repo.color}; --repo-fg: ${repoChipFg(row.repo.color)}`
    : "";
  $: if (!repoEditOpen) {
    previewRepoName = row.repo.name;
    previewRepoColor = row.repo.color ?? "#60b74c";
  }
  $: latestSession = row.sessions[0] ?? null;
  $: previewSessions = row.sessions as AgentSession[];
  $: branchChoices = row.worktree.branchChoices ?? [
    row.worktree.branch,
    "main",
    "feat/reuse-ui",
    "lab/arduino-pcb",
  ];
  $: worktreeChoices = row.repoWorktrees ?? [row.worktree];

  function relTime(iso?: string): string {
    if (!iso) return "unknown";
    const s = Math.floor((Date.now() - Date.parse(iso)) / 1000);
    if (s < 60) return "just now";
    if (s < 120) return "1 minute ago";
    if (s < 3600) return `${Math.floor(s / 60)} minutes ago`;
    if (s < 7200) return "1 hour ago";
    if (s < 86400) return `${Math.floor(s / 3600)} hours ago`;
    return `${Math.floor(s / 86400)} days ago`;
  }

  function sessionTooltip(session: AgentSession): string {
    return [
      session.manualTitle ?? session.aiTitle ?? session.title ?? session.agent,
      session.lastUserMessage,
    ]
      .filter(Boolean)
      .join("\n\n");
  }

  function pickSession(session: AgentSession): void {
    sessionsPickerOpen = false;
    selectedSource = session.source;
  }

  function commitRepoName(): void {
    const name = previewRepoName.trim();
    if (name && name !== row.repo.name) dispatch("renameRepo", { name });
  }
</script>

<li
  class="row workspace-preview-row"
  class:row-folded={row.folded}
  class:row-zen={zen}
  class:row-notes-hidden={!notesVisible}
  data-wt-row={row.worktree.path}
  data-repo-id={row.repo.id}
>
  <div class="row-content">
    <div class="row-head">
      <button
        class="chevron fold-toggle"
        class:open={!row.folded}
        title={row.folded
          ? `Expand \`${row.repo.name} · ${row.worktree.branch}\``
          : `Fold \`${row.repo.name} · ${row.worktree.branch}\` to a minimal row`}
        aria-label={row.folded ? "Expand row" : "Fold row"}
        on:click|stopPropagation={() => dispatch("toggleFold")}
      >
        <span class="arrow">▸</span>
      </button>

      <span class="repo-chip-anchor" data-repo-edit-anchor={row.key}>
        <button
          class="repo-chip"
          class:repo-chip-colored={!!row.repo.color}
          title="Edit repo"
          style={repoStyle}
          on:click|stopPropagation={() => (repoEditOpen = !repoEditOpen)}
        >
          {#if row.repo.daemonId}
            <span class="daemon-scheme">{row.repo.daemonId}://</span>
          {/if}
          {row.repo.name}
          <span class="chip-tail">
            <span class="pencil">✎</span>
          </span>
        </button>
        {#if repoEditOpen}
          <Popover
            variant="agents"
            extraClass="repo-edit-popover"
            headClass="repo-edit-popover-head"
          >
            <svelte:fragment slot="head">
              <span>Edit repo</span>
            </svelte:fragment>
            <div class="repo-edit-body">
              <label class="repo-edit-field">
                <span class="repo-edit-label">Name</span>
                <input
                  class="repo-edit-name"
                  bind:value={previewRepoName}
                  on:change={commitRepoName}
                  on:keydown={(e) => {
                    if (e.key === "Enter") {
                      commitRepoName();
                      repoEditOpen = false;
                    }
                    if (e.key === "Escape") repoEditOpen = false;
                  }}
                />
              </label>
              <div class="repo-edit-field">
                <span class="repo-edit-label">Color</span>
                <span class="repo-edit-color">
                  <input
                    class="repo-color-swatch"
                    type="color"
                    aria-label="Repo accent color"
                    bind:value={previewRepoColor}
                    style={`--swatch-bg: ${previewRepoColor}`}
                    on:input={(e) => {
                      const color = (e.currentTarget as HTMLInputElement).value;
                      previewRepoColor = color;
                      dispatch("setRepoColor", { color });
                    }}
                    on:change={(e) => {
                      const color = (e.currentTarget as HTMLInputElement).value;
                      previewRepoColor = color;
                      dispatch("setRepoColor", { color });
                    }}
                    on:contextmenu|preventDefault={() =>
                      dispatch("setRepoColor", { color: null })}
                  />
                  {#if row.repo.color}
                    <button
                      class="repo-edit-clear"
                      title="Clear accent color"
                      on:click|stopPropagation={() => {
                        previewRepoColor = "#60b74c";
                        dispatch("setRepoColor", { color: null });
                      }}>Clear</button
                    >
                  {/if}
                </span>
              </div>
              <button class="repo-edit-reorder" on:click|stopPropagation>
                <svg
                  class="repo-edit-reorder-icon"
                  viewBox="0 0 24 24"
                  width="13"
                  height="13"
                  aria-hidden="true"
                  ><path
                    d="M8 5v14M8 5L4 9M8 5l4 4M16 19V5m0 14l-4-4m4 4l4-4"
                  /></svg
                >
                Reorder repos…
              </button>
            </div>
          </Popover>
        {/if}
      </span>

      <span class="branch-anchor" data-branch-anchor={row.worktree.path}>
        <button
          class="branch branch-button"
          title="Click to switch this worktree to another branch"
          on:click|stopPropagation={() => (branchPickerOpen = !branchPickerOpen)}
        >
          <svg
            class="branch-icon"
            viewBox="0 0 24 24"
            width="12"
            height="12"
            aria-hidden="true"
            ><path
              d="M6 3v12M18 9a3 3 0 1 0 0-6 3 3 0 0 0 0 6zM6 21a3 3 0 1 0 0-6 3 3 0 0 0 0 6zM18 9c0 4-4 6-12 6"
            /></svg
          >
          {previewBranch}
          <span class="branch-caret" aria-hidden="true">▾</span>
        </button>
        {#if branchPickerOpen}
          <Popover
            variant="agents"
            extraClass="branch-popover"
            headClass="branch-popover-head"
          >
            <svelte:fragment slot="head">
              <span>Switch branch in {previewBranch}</span>
              <button class="branch-sort-toggle" on:click|stopPropagation>
                sort: recency ↻
              </button>
            </svelte:fragment>
            <ul class="agents-list">
              {#each branchChoices as bname (bname)}
                <li>
                  <button
                    class="agent-row branch-row"
                    class:branch-row-current={bname === previewBranch}
                    disabled={bname === previewBranch}
                    on:click={() => {
                      previewBranch = bname;
                      branchPickerOpen = false;
                    }}
                  >
                    <span class="branch-tick" aria-hidden="true">
                      {bname === previewBranch ? "●" : ""}
                    </span>
                    <span class="agent-row-name">{bname}</span>
                    <span class="agent-title muted"
                      >{bname.startsWith("origin/") ? "remote" : "local"}</span
                    >
                  </button>
                </li>
              {/each}
            </ul>
          </Popover>
        {/if}
      </span>

      <RowStatusBadges
        path={row.worktree.path}
        branchStatus={row.worktree.branchStatus}
        fileStatus={row.worktree.fileStatus}
        summary={row.summary}
        on:loadSummary={(e) => dispatch("loadSummary", e.detail)}
        on:push={(e) => dispatch("push", e.detail)}
        on:pull={(e) => dispatch("pull", e.detail)}
      />

      <span
        class="agent-wrap"
        style={row.repo.color ? `--repo-bg: ${row.repo.color}` : ""}
        data-agents-anchor={row.worktree.path}
        data-new-agent-anchor={row.worktree.path}
      >
        <button
          class="agent-add agent-{latestSession?.agent ?? 'empty'}"
          title="Start a new session in this worktree"
          on:click|stopPropagation={() => (newAgentOpen = !newAgentOpen)}
          >+</button
        >
        {#if newAgentOpen}
          <Popover variant="agents" extraClass="new-agent-popover">
            <svelte:fragment slot="head">Start a new session</svelte:fragment>
            <ul class="agents-list">
              <li>
                <button class="agent-row new-agent-row" on:click={() => (newAgentOpen = false)}>
                  <AgentIcon agent="claude" />
                  <span class="agent-row-name">Claude</span>
                  <span class="agent-title muted">claude</span>
                </button>
              </li>
              <li>
                <button class="agent-row new-agent-row" on:click={() => (newAgentOpen = false)}>
                  <AgentIcon agent="codex" />
                  <span class="agent-row-name">Codex CLI</span>
                  <span class="agent-title muted">codex</span>
                </button>
              </li>
              <li>
                <button class="agent-row new-agent-row" on:click={() => (newAgentOpen = false)}>
                  <AgentIcon agent="codex" />
                  <span class="agent-row-name">Codex App</span>
                  <span class="agent-title muted">app-server</span>
                </button>
              </li>
              <li>
                <button class="agent-row new-agent-row" on:click={() => (newAgentOpen = false)}>
                  <svg
                    class="agent-row-icon-svg"
                    viewBox="0 0 24 24"
                    fill="none"
                    stroke="currentColor"
                    stroke-width="1.8"
                    stroke-linecap="round"
                    stroke-linejoin="round"
                    aria-hidden="true"
                    ><path d="M4 17l5-5-5-5" /><path d="M11 19h8" /></svg
                  >
                  <span class="agent-row-name">Terminal</span>
                  <span class="agent-title muted">$SHELL</span>
                </button>
              </li>
              <li>
                <button class="agent-row new-agent-row" on:click={() => (newAgentOpen = false)}>
                  <svg
                    class="agent-row-icon-svg"
                    viewBox="0 0 24 24"
                    fill="none"
                    stroke="currentColor"
                    stroke-width="1.8"
                    stroke-linecap="round"
                    stroke-linejoin="round"
                    aria-hidden="true"
                    ><path
                      d="M22 19a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h5l2 3h9a2 2 0 0 1 2 2z"
                    /></svg
                  >
                  <span class="agent-row-name">Files</span>
                  <span class="agent-title muted">browse</span>
                </button>
              </li>
              <li>
                <button class="agent-row new-agent-row" on:click={() => (newAgentOpen = false)}>
                  <svg
                    class="agent-row-icon-svg"
                    viewBox="0 0 24 24"
                    fill="none"
                    stroke="currentColor"
                    stroke-width="1.8"
                    stroke-linecap="round"
                    stroke-linejoin="round"
                    aria-hidden="true"
                    ><circle cx="12" cy="12" r="3" /><line x1="12" y1="3" x2="12" y2="9" /><line x1="12" y1="15" x2="12" y2="21" /></svg
                  >
                  <span class="agent-row-name">History</span>
                  <span class="agent-title muted">commits</span>
                </button>
              </li>
            </ul>
          </Popover>
        {/if}
        {#if latestSession}
          <button
            class="agent-badge agent-{latestSession.agent}"
            class:active={selectedSource === latestSession.source}
            title={sessionTooltip(latestSession)}
            on:click|stopPropagation={() => (selectedSource = latestSession.source)}
          >
            <span class="agent-manual-title"
              >{latestSession.manualTitle ??
                latestSession.aiTitle ??
                latestSession.title ??
                latestSession.agent}</span
            >
            <span class="muted small">{relTime(latestSession.lastActive)}</span>
          </button>
        {/if}
        {#if row.sessions.length > 1}
          <button
            class="agent-more agent-{latestSession?.agent ?? 'claude'}"
            class:has-search={sessionSearchOpen}
            title={`Pick from ${row.sessions.length} sessions in this worktree`}
            on:click|stopPropagation={() => {
              sessionsPickerOpen = !sessionsPickerOpen;
              sessionSearchOpen = false;
            }}>{row.sessions.length}</button
          >
          <button
            class="agent-search agent-{latestSession?.agent ?? 'claude'}"
            class:active={sessionSearchOpen}
            title="Filter this row's sessions by title or message"
            aria-label="Filter sessions"
            on:click|stopPropagation={() => {
              sessionSearchOpen = !sessionSearchOpen;
              sessionsPickerOpen = false;
            }}
          >
            <svg viewBox="0 0 16 16" aria-hidden="true" width="11" height="11">
              <path
                fill="none"
                stroke="currentColor"
                stroke-width="1.8"
                stroke-linecap="round"
                d="M7 2.5a4.5 4.5 0 1 0 0 9 4.5 4.5 0 0 0 0-9zM13.5 13.5l-3-3"
              />
            </svg>
          </button>
          {#if sessionSearchOpen}
            <input
              class="agent-search-input"
              type="search"
              placeholder="filter…"
              bind:value={sessionSearchQuery}
              on:click|stopPropagation
            />
          {/if}
          {#if sessionsPickerOpen}
            <SessionSearchList
              sessions={previewSessions}
              headText={`${row.sessions.length} sessions in this worktree`}
              isOpen={(session) => session.source === selectedSource}
              tooltipFor={sessionTooltip}
              on:pick={(e) => pickSession(e.detail)}
              on:close={(e) => dispatch("closeSession", e.detail as WorkspacePreviewSession)}
            />
          {/if}
        {/if}
      </span>

      <code class="wt-path">{row.worktree.path}</code>

      <RowNoteActions
        rowKey={row.key}
        {notesVisible}
        noteTitle={`Pin a sticky note to this worktree (${row.worktree.branch})`}
        linkTitle={`Pin a link to this worktree (${row.worktree.branch})`}
        {emojiOpen}
        on:toggleNotes={() => dispatch("toggleNotes")}
        on:add={(e) => dispatch("addNote", e.detail)}
        on:toggleEmoji={() => dispatch("toggleEmoji")}
        on:closeEmoji={() => dispatch("closeEmoji")}
      >
        {#if noteCount > 0}
          <span class="row-note-count-anchor">
            <button
              type="button"
              class="row-note-count"
              class:open={notesListOpen}
              title={`${noteCount} sticky note${noteCount === 1 ? "" : "s"} pinned to this worktree`}
              on:click|stopPropagation={() => dispatch("toggleNotesList")}
              >{noteCount}</button
            >
            {#if notesListOpen}
              <RowNotesListPopover
                title={`Notes on ${row.repo.name} · ${row.worktree.branch}`}
                {notes}
                deletes={[]}
              />
            {/if}
          </span>
        {/if}
      </RowNoteActions>

      <ZenToggleButton
        open={zen}
        label={`${row.repo.name} · ${row.worktree.branch}`}
        on:toggle={() => dispatch("toggleZen")}
      />

      <span class="wt-picker-anchor" data-wt-picker-anchor={row.worktree.path}>
        <button
          class="new-wt"
          title="Worktrees of this repo (switch to / remove / create new)"
          on:click|stopPropagation={() => (wtPickerOpen = !wtPickerOpen)}
          >worktrees ({worktreeChoices.length})</button
        >
        {#if wtPickerOpen}
          <Popover variant="agents" extraClass="wt-picker-popover">
            <svelte:fragment slot="head">Worktrees of {row.repo.name}</svelte:fragment>
            <ul class="agents-list">
              {#each worktreeChoices as option (option.path)}
                <li>
                  <div
                    class="agent-row wt-pick-row"
                    class:wt-pick-visible={option.path === row.worktree.path}
                    role="button"
                    tabindex="0"
                    title={option.path}
                    on:click={() => (wtPickerOpen = false)}
                    on:keydown={(e) => {
                      if (e.key === "Enter" || e.key === " ") {
                        e.preventDefault();
                        wtPickerOpen = false;
                      }
                    }}
                  >
                    <span class="wt-pick-tick" aria-hidden="true">
                      {option.path === row.worktree.path ? "✓" : ""}
                    </span>
                    <span class="agent-row-name"
                      >{option.nonGit ? "—" : option.branch}</span
                    >
                    <span class="agent-title">{option.path}</span>
                    {#if option.path !== row.repo.path}
                      <button
                        class="row-close wt-pick-kill"
                        on:click|stopPropagation={() => (wtPickerOpen = false)}
                        title="Remove worktree from disk"
                        aria-label="Remove worktree from disk"
                        >×</button
                      >
                    {/if}
                  </div>
                </li>
              {/each}
            </ul>
            <form
              class="wt-pick-create-row"
              on:submit|preventDefault={() => {
                newBranchName = "";
                wtPickerOpen = false;
              }}
            >
              <input
                type="text"
                placeholder="new branch — creates worktree on it"
                bind:value={newBranchName}
                on:click|stopPropagation
                class="wt-pick-create-input"
              />
              <button
                type="submit"
                class="wt-pick-create-go"
                disabled={!newBranchName.trim()}
                >+ create</button
              >
            </form>
            <button
              class="wt-pick-remove-repo"
              on:click|stopPropagation={() => (wtPickerOpen = false)}
              >Remove repository and all worktree rows from supergit</button
            >
          </Popover>
        {/if}
      </span>

      <button
        class="row-remove"
        title="Hide this worktree's row from the dashboard"
        on:click|stopPropagation
        >×</button
      >
    </div>

    <div class="row-body">
      <div class="sessions-strip">
        {#each row.sessions as session (session.source)}
          <div
            class="session-col"
            data-session-source={session.source}
          >
            <WorkspaceSessionPreview
              {session}
              selected={selectedSource === session.source}
              on:close={(e) => dispatch("closeSession", e.detail)}
            />
          </div>
        {/each}
        <span class="sessions-strip-pad" aria-hidden="true"></span>
      </div>
    </div>
  </div>
</li>
