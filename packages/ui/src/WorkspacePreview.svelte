<script lang="ts">
  import { onDestroy, tick } from "svelte";
  import StickyNotesLayer, { spawnNote } from "./StickyNotesLayer.svelte";
  import SessionDock from "./SessionDock.svelte";
  import WorktreePreviewRow from "./WorktreePreviewRow.svelte";
  import { notesAll, notesCountByAnchor, type NoteShape } from "./notes-counts";
  import type {
    DockEntry,
    DockRepoStatus,
    DockWorktreeStatus,
    Repo,
    WorkspacePreviewRow,
  } from "./repo-types";

  export let memoryKey: string;
  export let rows: WorkspacePreviewRow[];
  export let initialNotes: NoteShape[] = [];
  export let sticky = false;

  type NoteActionDetail = {
    kind: "note" | "link" | "emoji";
    body?: string;
    originRect: DOMRect;
  };

  let notesVisibleByRow: Record<string, boolean> = {};
  let notesListOpenByRow: Record<string, boolean> = {};
  let emojiOpenByRow: Record<string, boolean> = {};
  let zenRowKey: string | null = null;
  let notesShownInZen = false;
  let selectedSource: string | null = rows[0]?.sessions[0]?.source ?? null;
  let notesLayer: { refreshPositions: () => void } | null = null;
  let noteRefreshFrame = 0;
  let previewRows = rows;

  $: selectedSession =
    previewRows.flatMap((row) => row.sessions).find((session) => session.source === selectedSource) ??
    null;

  $: repos = previewRows.map(
    (row) =>
      ({
        id: row.repo.id,
        name: row.repo.name,
        path: row.repo.path,
        color: row.repo.color,
        daemonId: row.repo.daemonId,
        addedAt: "",
        worktrees: [
          {
            ...row.worktree,
            head: "",
            bare: row.worktree.bare ?? false,
            detached: row.worktree.detached ?? false,
            lastCommit: null,
            agents: row.sessions.map((session) => ({
              ...session,
              firstUserMessage: session.firstUserMessage ?? session.preview,
            })),
          },
        ],
      }) satisfies Repo,
  );

  function anchorFor(row: WorkspacePreviewRow): string {
    return `worktree:${row.worktree.path}`;
  }

  function rowNotes(row: WorkspacePreviewRow): NoteShape[] {
    const anchor = anchorFor(row);
    return $notesAll.filter((note) => note.anchors.some((a) => a === anchor));
  }

  $: dockEntries = previewRows.flatMap((row) =>
    row.sessions.map(
      (session): DockEntry => ({
        source: session.source,
        wtPath: row.worktree.path,
        rowKey: row.key,
        repoId: row.repo.id,
        agent: session.agent,
        repoColor: row.repo.color,
        repoName: row.repo.name,
        branch: row.worktree.branch,
        title: session.title,
        manualTitle: session.manualTitle,
        aiTitle: session.aiTitle,
        lastUserMessage: session.lastUserMessage,
        lastActive: session.lastActive,
        recentMessageCount: session.recentMessageCount,
        lastMessageTs: session.lastMessageTs,
        working: session.state === "working",
        awaiting: session.state === "awaiting",
        exited: session.state === "idle" || session.state === "paused",
        terminalActive: false,
      }),
    ),
  );

  $: dockRepoStatuses = previewRows.map(
    (row): DockRepoStatus => ({
      repoId: row.repo.id,
      repoColor: row.repo.color,
      repoName: row.repo.name,
      ahead: row.worktree.branchStatus?.ahead ?? 0,
      aheadDanger: !!row.worktree.branchStatus?.aheadOldestTime,
      behind: row.worktree.branchStatus?.behind ?? 0,
      staged: row.worktree.fileStatus?.staged ?? 0,
      unstaged: row.worktree.fileStatus?.unstaged ?? 0,
      untracked: row.worktree.fileStatus?.untracked ?? 0,
    }),
  );

  $: dockRepoWorktrees = previewRows.reduce(
    (acc, row) => {
      const status: DockWorktreeStatus = {
        path: row.worktree.path,
        branch: row.worktree.branch,
        ahead: row.worktree.branchStatus?.ahead ?? 0,
        aheadDanger: !!row.worktree.branchStatus?.aheadOldestTime,
        behind: row.worktree.branchStatus?.behind ?? 0,
        dirty:
          (row.worktree.fileStatus?.staged ?? 0) +
          (row.worktree.fileStatus?.unstaged ?? 0) +
          (row.worktree.fileStatus?.untracked ?? 0),
        upstream: row.worktree.branchStatus?.upstream ?? null,
        daemonId: row.repo.daemonId,
      };
      acc[row.repo.id] = [...(acc[row.repo.id] ?? []), status];
      return acc;
    },
    {} as Record<string, DockWorktreeStatus[]>,
  );

  function addNote(row: WorkspacePreviewRow, detail: NoteActionDetail): void {
    if (zenRowKey === row.key) notesShownInZen = true;
    else notesVisibleByRow = { ...notesVisibleByRow, [row.key]: true };
    void spawnNote({
      anchor: anchorFor(row),
      originRect: detail.originRect,
      kind: detail.kind,
      body: detail.body,
    });
  }

  function updateRow(
    rowKey: string,
    updater: (row: WorkspacePreviewRow) => WorkspacePreviewRow,
  ): void {
    previewRows = previewRows.map((row) =>
      row.key === rowKey ? updater(row) : row,
    );
  }

  function toggleFold(rowKey: string): void {
    updateRow(rowKey, (row) => ({ ...row, folded: !row.folded }));
  }

  function renameRepo(rowKey: string, name: string): void {
    updateRow(rowKey, (row) => ({ ...row, repo: { ...row.repo, name } }));
  }

  function setRepoColor(rowKey: string, color: string | null): void {
    updateRow(rowKey, (row) => {
      const repo = { ...row.repo };
      if (color) repo.color = color;
      else delete repo.color;
      return { ...row, repo };
    });
  }

  async function focusSessionColumn(source: string): Promise<void> {
    await tick();
    await tick();
    const col = document.querySelector<HTMLElement>(
      `.session-col[data-session-source="${CSS.escape(source)}"]`,
    );
    col?.scrollIntoView({
      behavior: "smooth",
      block: "nearest",
      inline: "center",
    });
  }

  function resetZenPopovers(): void {
    emojiOpenByRow = {};
    notesListOpenByRow = {};
  }

  function refreshNotesAfterDomUpdate(): void {
    void tick().then(() => notesLayer?.refreshPositions());
  }

  function setZenRow(rowKey: string | null): void {
    zenRowKey = rowKey;
    notesShownInZen = false;
    resetZenPopovers();
    refreshNotesAfterDomUpdate();
  }

  function toggleZenRow(row: WorkspacePreviewRow): void {
    const exiting = zenRowKey === row.key;
    setZenRow(exiting ? null : row.key);
    if (exiting) {
      void tick().then(() =>
        document
          .querySelector(`[data-wt-row="${CSS.escape(row.worktree.path)}"]`)
          ?.scrollIntoView({ behavior: "smooth", block: "center" }),
      );
    }
  }

  function focusRow(row: WorkspacePreviewRow): void {
    selectedSource = row.sessions[0]?.source ?? selectedSource;
    document
      .querySelector(`[data-wt-row="${CSS.escape(row.worktree.path)}"]`)
      ?.scrollIntoView({ behavior: "smooth", block: "center" });
  }

  async function focusRowByKey(rowKey: string, source?: string): Promise<void> {
    const row = previewRows.find((candidate) => candidate.key === rowKey);
    if (!row) return;
    selectedSource = source ?? row.sessions[0]?.source ?? selectedSource;
    if (zenRowKey && zenRowKey !== row.key) {
      setZenRow(row.key);
    }
    if (selectedSource) {
      await focusSessionColumn(selectedSource);
      return;
    }
    if (zenRowKey) return;
    document
      .querySelector(`[data-wt-row="${CSS.escape(row.worktree.path)}"]`)
      ?.scrollIntoView({ behavior: "smooth", block: "center" });
  }

  function focusRepo(repoId: string): void {
    const row = previewRows.find((candidate) => candidate.repo.id === repoId);
    if (row && zenRowKey) {
      setZenRow(row.key);
      selectedSource = row.sessions[0]?.source ?? selectedSource;
      if (selectedSource) void focusSessionColumn(selectedSource);
      return;
    }
    if (row) focusRow(row);
  }

  function refreshNotesForInternalScroll(): void {
    if (noteRefreshFrame) return;
    noteRefreshFrame = requestAnimationFrame(() => {
      noteRefreshFrame = 0;
      notesLayer?.refreshPositions();
    });
  }

  onDestroy(() => {
    if (noteRefreshFrame) cancelAnimationFrame(noteRefreshFrame);
  });
</script>

<div
  class="workspace-preview-shell"
  class:workspace-preview-sticky={sticky}
  class:workspace-preview-zen={!!zenRowKey}
>
  <div
    class="workspace-preview"
    class:zen-row={!!zenRowKey}
    class:bounded={sticky}
  >
    <div class="workspace-preview-frame">
      <SessionDock
        entries={dockEntries}
        focusedSource={selectedSession?.source ?? null}
        dockRepoStatuses={dockRepoStatuses}
        {dockRepoWorktrees}
        zen={!!zenRowKey}
        embedded
        on:pick={(e) => void focusRowByKey(e.detail.rowKey, e.detail.source)}
        on:scrollToRepo={(e) => focusRepo(e.detail.repoId)}
      />

      <div
        class="workspace-preview-layout"
        on:scroll={refreshNotesForInternalScroll}
      >
        <ul class="rows">
          {#each previewRows as row (row.key)}
            {@const anchor = anchorFor(row)}
            <WorktreePreviewRow
              {row}
              noteCount={$notesCountByAnchor[anchor] ?? 0}
              notes={rowNotes(row)}
              notesVisible={zenRowKey !== null
                ? zenRowKey === row.key && notesShownInZen
                : notesVisibleByRow[row.key] ?? true}
              notesListOpen={!!notesListOpenByRow[row.key]}
              emojiOpen={!!emojiOpenByRow[row.key]}
              zen={zenRowKey === row.key}
              {selectedSource}
              on:addNote={(e) => addNote(row, e.detail)}
              on:toggleNotes={() => {
                if (zenRowKey === row.key) {
                  notesShownInZen = !notesShownInZen;
                  refreshNotesAfterDomUpdate();
                } else {
                  notesVisibleByRow = {
                    ...notesVisibleByRow,
                    [row.key]: !(notesVisibleByRow[row.key] ?? true),
                  };
                  refreshNotesAfterDomUpdate();
                }
              }}
              on:toggleNotesList={() =>
                (notesListOpenByRow = {
                  ...notesListOpenByRow,
                  [row.key]: !notesListOpenByRow[row.key],
                })}
              on:toggleEmoji={() =>
                (emojiOpenByRow = {
                  ...emojiOpenByRow,
                  [row.key]: !emojiOpenByRow[row.key],
                })}
              on:closeEmoji={() =>
                (emojiOpenByRow = { ...emojiOpenByRow, [row.key]: false })}
              on:toggleFold={() => toggleFold(row.key)}
              on:renameRepo={(e) => renameRepo(row.key, e.detail.name)}
              on:setRepoColor={(e) => setRepoColor(row.key, e.detail.color)}
              on:toggleZen={() => toggleZenRow(row)}
              on:closeSession={() => {
                selectedSource = null;
              }}
            />
          {/each}
        </ul>
      </div>
    </div>

    <StickyNotesLayer
      bind:this={notesLayer}
      {memoryKey}
      {initialNotes}
      {repos}
      contained
    />
  </div>
</div>
