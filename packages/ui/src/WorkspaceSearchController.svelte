<script lang="ts">
  import { createEventDispatcher, onDestroy, onMount, tick } from "svelte";
  import { apiUrl } from "./api";
  import { notesAll } from "./notes-counts";
  import { repoPrefsKey } from "./repo-fanout";
  import { effectiveVisibleWorktrees } from "./storage";
  import WorkspaceOmnibar from "./WorkspaceOmnibar.svelte";
  import {
    buildProjectActionSearchItems,
    buildNoteSearchItems,
    buildProjectSearchItems,
    buildReadmeSearchItems,
    buildSessionSearchItems,
    type ProjectSearchAction,
    type NoteSearchLike,
    type ReadmeSearchLike,
    type SearchItem,
    type SearchKind,
  } from "./workspace-search";
  import type { AgentSession } from "./sessionSearch";

  interface SearchWorktree {
    path: string;
    branch?: string;
  }

  interface SearchRepo {
    id: string;
    path: string;
    name: string;
    color?: string;
    addedAt?: string;
    daemonId?: string;
    worktrees?: SearchWorktree[];
  }

  interface SearchRow {
    key: string;
    wt?: { path: string } | null;
  }

  interface RevealSession {
    agent: AgentSession["agent"];
    source: string;
    resumeSessionId?: string;
  }

  export let repos: SearchRepo[] = [];
  export let sessionsByWorktree: Record<string, AgentSession[]> = {};
  export let rows: SearchRow[] = [];
  export let visibleWorktreesByRepo: Record<string, string[]> = {};
  export let focusRepoRow: (repoId: string) => void | Promise<void> = () => {};
  export let jumpToWorktreeRow: (path: string) => void = () => {};
  export let revealSession: (
    rowKey: string,
    wtPath: string,
    session: RevealSession,
  ) => void = () => {};
  export let revealNote: (
    noteId: string,
    fallbackWtPath?: string | null,
  ) => boolean | Promise<boolean> = () => false;
  export let addFolder: () => void | Promise<void> = () => {};
  export let openFromSessions: () => void | Promise<void> = () => {};

  let omnibarOpen = false;
  let omnibarQuery = "";
  let omnibarActiveKinds: SearchKind[] | null = null;
  let readmesLoaded = false;
  let readmesLoading = false;
  let readmeRecords: ReadmeSearchLike[] = [];

  const dispatch = createEventDispatcher<{
    open: void;
  }>();

  $: allSearchSessions = collectSessions(sessionsByWorktree);
  $: projectSearchItems = [
    ...buildProjectSearchItems(repos),
    ...buildProjectActionSearchItems(),
  ];
  $: sessionSearchItems = buildSessionSearchItems(allSearchSessions, repos);
  $: noteSearchItems = buildNoteSearchItems($notesAll as NoteSearchLike[]);
  $: readmeSearchItems = buildReadmeSearchItems(readmeRecords);
  $: omnibarItems = [
    ...projectSearchItems,
    ...sessionSearchItems,
    ...noteSearchItems,
    ...readmeSearchItems,
  ];

  function collectSessions(
    byWorktree: Record<string, AgentSession[]>,
  ): AgentSession[] {
    const out: AgentSession[] = [];
    const seen = new Set<string>();
    for (const sessions of Object.values(byWorktree)) {
      for (const session of sessions) {
        if (seen.has(session.source)) continue;
        seen.add(session.source);
        out.push(session);
      }
    }
    return out;
  }

  export function open(kinds?: SearchKind[] | null): void {
    if (kinds !== undefined) omnibarActiveKinds = kinds;
    omnibarQuery = "";
    void loadReadmes();
    omnibarOpen = true;
    dispatch("open");
  }

  export function close(): void {
    omnibarOpen = false;
  }

  function worktreeRowKey(wtPath: string): string | null {
    return rows.find((row) => row.wt?.path === wtPath)?.key ?? null;
  }

  async function ensureWorktreeVisible(wtPath: string): Promise<string | null> {
    let rowKey = worktreeRowKey(wtPath);
    if (rowKey) return rowKey;
    const repo = repos.find((r) =>
      (r.worktrees ?? []).some((w) => w.path === wtPath),
    );
    if (!repo) return null;
    const prefKey = repoPrefsKey(repo);
    const visible = effectiveVisibleWorktrees(
      prefKey,
      (repo.worktrees ?? []).map((w) => w.path),
      visibleWorktreesByRepo,
    );
    if (!visible.includes(wtPath)) {
      visibleWorktreesByRepo = {
        ...visibleWorktreesByRepo,
        [prefKey]: [...visible, wtPath],
      };
      await tick();
    }
    return worktreeRowKey(wtPath);
  }

  async function openProject(item: SearchItem): Promise<void> {
    const action = searchAction(item);
    if (action === "add-folder") {
      await addFolder();
      return;
    }
    if (action === "open-from-sessions") {
      await openFromSessions();
      return;
    }
    const data = item.data as
      | SearchRepo
      | { repo?: SearchRepo; wt?: SearchWorktree }
      | undefined;
    if (data && "wt" in data && data.wt?.path) {
      await ensureWorktreeVisible(data.wt.path);
      jumpToWorktreeRow(data.wt.path);
      return;
    }
    const repo =
      data && "repo" in data ? data.repo : (data as SearchRepo | undefined);
    if (repo?.id) void focusRepoRow(repo.id);
  }

  async function openSession(item: SearchItem): Promise<void> {
    const session = item.data as AgentSession | undefined;
    if (!session?.cwd) return;
    const rowKey = await ensureWorktreeVisible(session.cwd);
    if (!rowKey) {
      jumpToWorktreeRow(session.cwd);
      return;
    }
    revealSession(rowKey, session.cwd, {
      agent: session.agent,
      source: session.source,
      resumeSessionId: session.sessionId,
    });
  }

  async function openNote(item: SearchItem): Promise<void> {
    const note = item.data as NoteSearchLike | undefined;
    if (!note?.id) return;
    const worktreeAnchor = note?.anchors?.find((anchor) =>
      anchor.startsWith("worktree:"),
    );
    const wtPath = worktreeAnchor?.slice("worktree:".length) ?? null;
    if (wtPath) await ensureWorktreeVisible(wtPath);
    const revealed = await revealNote(note.id, wtPath);
    if (!revealed && wtPath) {
      const rowKey = await ensureWorktreeVisible(wtPath);
      if (rowKey) jumpToWorktreeRow(wtPath);
    }
  }

  function openReadme(item: SearchItem): void {
    const readme = item.data as ReadmeSearchLike | undefined;
    if (readme?.repoId) void focusRepoRow(readme.repoId);
  }

  async function loadReadmes(): Promise<void> {
    if (readmesLoaded || readmesLoading) return;
    readmesLoading = true;
    try {
      const res = await fetch(apiUrl("/api/readmes"), { cache: "no-cache" });
      const body = (await res.json().catch(() => null)) as {
        readmes?: ReadmeSearchLike[];
      } | null;
      if (res.ok && Array.isArray(body?.readmes)) {
        readmeRecords = body.readmes;
        readmesLoaded = true;
      }
    } finally {
      readmesLoading = false;
    }
  }

  function pick(item: SearchItem): void {
    close();
    if (item.kind === "project" || item.kind === "action") {
      void openProject(item);
      return;
    }
    if (item.kind === "note") {
      void openNote(item);
      return;
    }
    if (item.kind === "readme") {
      openReadme(item);
      return;
    }
    void openSession(item);
  }

  function searchAction(item: SearchItem): ProjectSearchAction | null {
    const data = item.data as { action?: unknown } | undefined;
    return data?.action === "add-folder" ||
      data?.action === "open-from-sessions"
      ? data.action
      : null;
  }

  function onShortcut(e: KeyboardEvent): void {
    const mod = e.metaKey || e.ctrlKey;
    if (
      !mod ||
      e.altKey ||
      e.shiftKey ||
      (e.code !== "KeyK" && e.key.toLowerCase() !== "k")
    ) {
      return;
    }
    e.preventDefault();
    open(null);
  }

  onMount(() => {
    window.addEventListener("keydown", onShortcut, { capture: true });
  });

  onDestroy(() => {
    window.removeEventListener("keydown", onShortcut, { capture: true });
  });
</script>

<WorkspaceOmnibar
  open={omnibarOpen}
  items={omnibarItems}
  bind:query={omnibarQuery}
  bind:activeKinds={omnibarActiveKinds}
  on:pick={(e) => pick(e.detail)}
  on:close={close}
/>
