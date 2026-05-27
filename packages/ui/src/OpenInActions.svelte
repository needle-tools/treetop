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
  /** User-defined "open in" link. Three flavours:
   *   - `kind: "url"` (or absent for legacy entries) — a web URL,
   *     opened in a new browser tab.
   *   - `kind: "file"` — an absolute file path opened with the OS
   *     default app via `/api/open-default`.
   *   - `kind: "folder"` — an absolute directory opened in the OS
   *     file manager (same endpoint; OS handlers route folders to
   *     Finder / Explorer / the default file-manager). */
  export type CommandRunMode = "internal" | "external" | "shell";

  export type CustomLink =
    | { id: string; kind?: "url"; url: string; name?: string }
    | { id: string; kind: "file"; path: string; name?: string }
    | { id: string; kind: "folder"; path: string; name?: string }
    | { id: string; kind: "command"; cmd: string; cwd?: string; runMode: CommandRunMode; name?: string };

  export function customLinkKind(
    link: CustomLink,
  ): "url" | "file" | "folder" | "command" {
    if (link.kind === "command") return "command";
    if (link.kind === "file") return "file";
    if (link.kind === "folder") return "folder";
    return "url";
  }
  export function customLinkTarget(link: CustomLink): string {
    const k = customLinkKind(link);
    if (k === "command") return (link as { cmd: string }).cmd;
    return k === "file" || k === "folder"
      ? (link as { path: string }).path
      : (link as { url: string }).url;
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
  import { flip } from "svelte/animate";
  import { openUrl } from "./open-url";
  import { filterNpmSuggestions, npmScriptsPlaceholder } from "./npm-suggestions";
  import { LINK_TARGET_DRAG_MIME } from "./note-inline-attachments";

  export let path: string;
  export let repoId: string = "";
  export let editors: EditorDescriptor[] = [];
  export let remotes: RemoteRef[] = [];
  export let customLinks: CustomLink[] = [];
  export let runningCommandIds: ReadonlySet<string> = new Set();
  export let commandUrls: Record<string, string[]> = {};
  export let editRequest:
    | { repoId: string; linkId: string; nonce: number }
    | null = null;
  export let onCommandClick: ((link: CustomLink) => void) | null = null;
  export let openIn: (path: string, app: string) => void;
  export let openRemote: (remote: RemoteRef) => void;
  /** Add-link handler, supplied by the parent which owns the fetch.
   *  The popover collects a discriminated-union payload (URL, file,
   *  or folder) and calls this; resolves true on success so we can
   *  close the popover. */
  export let onAddCustomLink:
    | ((
        input:
          | { kind: "url"; url: string; name?: string }
          | { kind: "file"; path: string; name?: string }
          | { kind: "folder"; path: string; name?: string }
          | { kind: "command"; cmd: string; cwd?: string; runMode?: CommandRunMode; name?: string },
      ) => Promise<boolean>)
    | null = null;
  /** Remove-link handler. Same contract — the parent owns the fetch. */
  export let onRemoveCustomLink: ((linkId: string) => Promise<void>) | null =
    null;
  /** Edit-link handler. Called from the per-link edit popover when the
   *  user submits a new URL/path and/or label. Pass `url` OR `path`,
   *  not both — the daemon flips the link's kind based on `kind` (or
   *  preserves the existing kind when `kind` is omitted). */
  export let onEditCustomLink:
    | ((
        linkId: string,
        input: {
          url?: string;
          path?: string;
          cmd?: string;
          cwd?: string;
          runMode?: CommandRunMode;
          kind?: "url" | "file" | "folder" | "command";
          name?: string;
        },
      ) => Promise<boolean>)
    | null = null;
  /** Reorder-links handler. Receives the new ordered list of link ids
   *  after a drag-and-drop completes; parent updates state + persists
   *  to the daemon. Drag is disabled when this is null. */
  export let onReorderCustomLinks:
    | ((orderedIds: string[]) => Promise<void>)
    | null = null;
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
    const k = customLinkKind(link);
    if (k === "command") {
      const cmd = (link as { cmd: string }).cmd;
      return cmd.length > 30 ? cmd.slice(0, 28) + "…" : cmd;
    }
    if (k === "file" || k === "folder") {
      const p = (link as { path: string }).path;
      const segs = p.split(/[\\/]/).filter(Boolean);
      return segs[segs.length - 1] ?? p;
    }
    try {
      return new URL((link as { url: string }).url).host;
    } catch {
      return (link as { url: string }).url;
    }
  }

  function linkTooltip(link: CustomLink): string {
    const target = customLinkTarget(link);
    const k = customLinkKind(link);
    if (k === "command") {
      const mode = (link as { runMode: CommandRunMode }).runMode;
      return `Run: ${target} (${mode})`;
    }
    if (k === "file") return `Open ${target} with the default app`;
    if (k === "folder") return `Open ${target} in the file manager`;
    return `Open ${target} in browser`;
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
  let newKind: "url" | "file" | "folder" | "command" = "url";
  let newUrl = "";
  let newPath = "";
  let newCmd = "";
  let newCwd = "";
  let newRunMode: CommandRunMode = "internal";
  let newName = "";
  let adding = false;
  let addError = "";
  let urlInput: HTMLInputElement | undefined;
  let anchorEl: HTMLSpanElement | undefined;

  // npm script autocomplete
  let npmScripts: string[] = [];
  let npmScriptsDir = "";
  let showSuggestions = false;
  let selectedSuggestionIdx = -1;
  let suggestionsEl: HTMLUListElement | undefined;

  async function fetchNpmScripts(dir: string) {
    if (!dir || dir === npmScriptsDir) return;
    npmScriptsDir = dir;
    try {
      const res = await fetch(`/api/npm-scripts?dir=${encodeURIComponent(dir)}`);
      if (!res.ok) { npmScripts = []; return; }
      const body = await res.json() as { scripts?: string[] };
      npmScripts = body.scripts ?? [];
    } catch {
      npmScripts = [];
    }
  }

  function effectiveCwd(cwd: string): string {
    return cwd.trim() || path;
  }

  $: if (addOpen && newKind === "command") {
    void fetchNpmScripts(effectiveCwd(newCwd));
  }
  $: if (editingLinkId && editKind === "command") {
    void fetchNpmScripts(effectiveCwd(editCwd));
  }

  function filteredSuggestions(cmd: string, scripts: string[]): string[] {
    return filterNpmSuggestions(cmd, scripts);
  }

  $: addSuggestions = filteredSuggestions(newCmd, npmScripts);
  $: editSuggestions = filteredSuggestions(editCmd, npmScripts);
  let addSuggestions: string[] = [];
  let editSuggestions: string[] = [];
  let showEditSuggestions = false;
  let selectedEditSuggestionIdx = -1;

  /** Per-link edit popover. Only one link can be in edit mode at a
   *  time — opening one closes any other. Anchor refs live in a map
   *  so the outside-click handler can scope its `contains()` check to
   *  the active editor without touching the other chips' wraps. */
  let cmdUrlDropdown: string | null = null;
  let cmdUrlOverride: Record<string, string> = {};
  let editingLinkId: string | null = null;
  let editKind: "url" | "file" | "folder" | "command" = "url";
  let editUrl = "";
  let editPath = "";
  let editCmd = "";
  let editCwd = "";
  let editRunMode: CommandRunMode = "shell";
  let editName = "";
  let editing = false;
  let editError = "";
  let editUrlInput: HTMLInputElement | undefined;
  const editAnchorEls = new Map<string, HTMLElement>();
  let handledEditRequestNonce = -1;

  /** Svelte action: registers the chip-wrap element in
   *  `editAnchorEls` under its link id so the outside-click handler
   *  can scope its `contains()` check to whichever chip is currently
   *  in edit mode. Unregisters automatically when the row is removed
   *  (drag-reorder unmounts shouldn't drop the registration since
   *  animate:flip preserves the same node, but defensive cleanup is
   *  cheap). */
  function bindEditAnchor(
    node: HTMLElement,
    id: string,
  ): { update(newId: string): void; destroy(): void } {
    editAnchorEls.set(id, node);
    let registeredId = id;
    return {
      update(newId: string) {
        if (newId === registeredId) return;
        editAnchorEls.delete(registeredId);
        editAnchorEls.set(newId, node);
        registeredId = newId;
      },
      destroy() {
        if (editAnchorEls.get(registeredId) === node) {
          editAnchorEls.delete(registeredId);
        }
      },
    };
  }

  function openEdit(link: CustomLink) {
    if (!onEditCustomLink) return;
    addOpen = false;
    editingLinkId = link.id;
    editKind = customLinkKind(link);
    editUrl = editKind === "url" ? (link as { url: string }).url : "";
    editPath =
      editKind === "file" || editKind === "folder"
        ? (link as { path: string }).path
        : "";
    if (editKind === "command") {
      editCmd = (link as { cmd: string }).cmd;
      editCwd = (link as { cwd?: string }).cwd ?? "";
      editRunMode = (link as { runMode: CommandRunMode }).runMode;
    } else {
      editCmd = "";
      editCwd = "";
      editRunMode = "shell";
    }
    editName = link.name ?? "";
    editError = "";
    setTimeout(() => editUrlInput?.focus(), 0);
  }

  $: if (
    editRequest &&
    editRequest.nonce !== handledEditRequestNonce &&
    editRequest.repoId === repoId
  ) {
    const requestedLink = customLinks.find((link) => link.id === editRequest?.linkId);
    if (requestedLink) {
      handledEditRequestNonce = editRequest.nonce;
      openEdit(requestedLink);
    }
  }

  function closeEdit() {
    editingLinkId = null;
    editError = "";
  }

  async function submitEdit() {
    if (!onEditCustomLink || !editingLinkId) return;
    const id = editingLinkId;
    if (editKind === "command") {
      const c = editCmd.trim();
      if (c.length === 0) {
        editError = "Command required.";
        return;
      }
      editing = true;
      editError = "";
      try {
        const ok = await onEditCustomLink(id, {
          cmd: c,
          cwd: editCwd.trim() || undefined,
          runMode: editRunMode,
          kind: "command",
          name: editName,
        });
        if (ok) closeEdit();
        else editError = "Couldn't save — server rejected the change.";
      } catch (e) {
        editError = e instanceof Error ? e.message : String(e);
      } finally {
        editing = false;
      }
      return;
    }
    if (editKind === "file" || editKind === "folder") {
      const p = editPath.trim();
      if (p.length === 0) {
        editError = "Path required.";
        return;
      }
      editing = true;
      editError = "";
      try {
        const ok = await onEditCustomLink(id, {
          path: p,
          kind: editKind,
          name: editName,
        });
        if (ok) closeEdit();
        else editError = "Couldn't save — server rejected the change.";
      } catch (e) {
        editError = e instanceof Error ? e.message : String(e);
      } finally {
        editing = false;
      }
      return;
    }
    const u = editUrl.trim();
    if (u.length === 0) {
      editError = "URL required.";
      return;
    }
    editing = true;
    editError = "";
    try {
      const ok = await onEditCustomLink(id, { url: u, name: editName });
      if (ok) closeEdit();
      else editError = "Couldn't save — server rejected the change.";
    } catch (e) {
      editError = e instanceof Error ? e.message : String(e);
    } finally {
      editing = false;
    }
  }

  async function pickEditPath() {
    const want: "file" | "folder" =
      editKind === "folder" ? "folder" : "file";
    try {
      const picked = await runPathPicker(want);
      if (picked) {
        editPath = picked;
        editKind = want;
      }
    } catch (e) {
      editError = e instanceof Error ? e.message : String(e);
    }
  }

  async function deleteFromEdit() {
    if (!editingLinkId || !onRemoveCustomLink) return;
    const link = customLinks.find((l) => l.id === editingLinkId);
    if (!link) {
      closeEdit();
      return;
    }
    const label = linkLabel(link);
    const ok = await confirmDialog({
      title: `Remove the “${label}” link?`,
      message: link.url,
      confirmLabel: "Remove",
      danger: true,
    });
    if (!ok) return;
    const id = editingLinkId;
    closeEdit();
    await onRemoveCustomLink(id);
  }

  let addEverOpened = false;
  function toggleAdd() {
    addOpen = !addOpen;
    if (addOpen) {
      if (!addEverOpened) {
        addEverOpened = true;
        const draft = readDraft();
        newKind = draft.kind ?? readLastKind();
        newUrl = draft.url ?? "";
        newPath = draft.path ?? "";
        newCmd = draft.cmd ?? "";
        newCwd = draft.cwd ?? "";
        newRunMode = draft.runMode ?? "internal";
        newName = draft.name ?? "";
      }
      npmScriptsDir = "";
      addError = "";
      setTimeout(() => {
        urlInput?.focus();
        window.dispatchEvent(new Event("resize"));
      }, 0);
    }
  }

  async function submitAdd() {
    if (!onAddCustomLink) return;
    const trimmedName = newName.trim() || undefined;
    if (newKind === "command") {
      const c = newCmd.trim();
      if (c.length === 0) {
        addError = "Command required.";
        return;
      }
      adding = true;
      addError = "";
      try {
        const ok = await onAddCustomLink({
          kind: "command",
          cmd: c,
          cwd: newCwd.trim() || undefined,
          runMode: newRunMode,
          name: trimmedName,
        });
        if (ok) {
          addOpen = false;
          addEverOpened = false;
          newCmd = "";
          newCwd = "";
          newRunMode = "internal";
          newUrl = "";
          newPath = "";
          newName = "";
          clearDraft();
        } else {
          addError = "Couldn't add — server rejected the command.";
        }
      } catch (e) {
        addError = e instanceof Error ? e.message : String(e);
      } finally {
        adding = false;
      }
      return;
    }
    if (newKind === "file" || newKind === "folder") {
      const p = newPath.trim();
      if (p.length === 0) {
        addError =
          newKind === "folder" ? "Pick a folder first." : "Pick a file first.";
        return;
      }
      adding = true;
      addError = "";
      try {
        const ok = await onAddCustomLink({
          kind: newKind,
          path: p,
          name: trimmedName,
        });
        if (ok) {
          addOpen = false;
          addEverOpened = false;
          newUrl = "";
          newPath = "";
          newName = "";
          clearDraft();
        } else {
          addError = "Couldn't add — server rejected the path.";
        }
      } catch (e) {
        addError = e instanceof Error ? e.message : String(e);
      } finally {
        adding = false;
      }
      return;
    }
    const u = newUrl.trim();
    if (u.length === 0) {
      addError = "URL required.";
      return;
    }
    adding = true;
    addError = "";
    try {
      // Auto-fill the label from the page <title> when the user
      // didn't pick one. Best-effort: failure (timeout, no title,
      // non-HTML response) falls back to letting the daemon store
      // the link with no name; the chip then shows the host.
      let resolvedName = trimmedName;
      if (!resolvedName) resolvedName = (await fetchPageTitle(u)) ?? undefined;
      const ok = await onAddCustomLink({
        kind: "url",
        url: u,
        name: resolvedName,
      });
      if (ok) {
        addOpen = false;
        addEverOpened = false;
        newUrl = "";
        newPath = "";
        newName = "";
        clearDraft();
      } else {
        addError = "Couldn't add — server rejected the URL.";
      }
    } catch (e) {
      addError = e instanceof Error ? e.message : String(e);
    } finally {
      adding = false;
    }
  }

  /** Best-effort `<title>` fetch via the daemon. Used to auto-fill
   *  the chip label when the user didn't supply one. Bounded by a
   *  short timeout so add-link doesn't stall when the origin is slow
   *  or unreachable. Returns null on any failure — caller falls back
   *  to the host-derived label. */
  async function fetchPageTitle(url: string): Promise<string | null> {
    try {
      const ctl = new AbortController();
      const t = setTimeout(() => ctl.abort(), 4500);
      const res = await fetch(
        `/api/page-title?url=${encodeURIComponent(url)}`,
        { signal: ctl.signal },
      );
      clearTimeout(t);
      if (!res.ok) return null;
      const body = (await res.json()) as { title?: string | null };
      if (typeof body.title === "string" && body.title.length > 0) {
        // Clip aggressively — page titles routinely run to 80+ chars,
        // way too wide for a chip. The user can edit it down via the
        // pencil if the truncation lost meaning.
        return body.title.length > 40
          ? body.title.slice(0, 38).trimEnd() + "…"
          : body.title;
      }
      return null;
    } catch {
      return null;
    }
  }

  /** localStorage keys for per-worktree custom-link UI state. Scoping
   *  by the worktree path means each row remembers its own
   *  preferences — switching repos doesn't drag you to an unrelated
   *  start dir or flip the tab back. */
  function lastPickKey(): string {
    return `supergit.customLinks.lastPick.${path}`;
  }
  function lastKindKey(): string {
    return `supergit.customLinks.lastKind.${path}`;
  }
  function readLastPick(): string | null {
    try {
      return localStorage.getItem(lastPickKey());
    } catch {
      return null;
    }
  }
  function writeLastPick(p: string): void {
    try {
      localStorage.setItem(lastPickKey(), p);
    } catch {
      // localStorage unavailable / quota — non-fatal, picker still
      // works, the start dir just won't carry over next time.
    }
  }
  function readLastKind(): "url" | "file" | "folder" | "command" {
    try {
      const v = localStorage.getItem(lastKindKey());
      if (v === "file" || v === "folder" || v === "command") return v;
      return "url";
    } catch {
      return "url";
    }
  }
  function writeLastKind(k: "url" | "file" | "folder" | "command"): void {
    try {
      localStorage.setItem(lastKindKey(), k);
    } catch {
      // ignore — sticky preference is a nice-to-have, not load-bearing
    }
  }

  /** Per-worktree draft of the in-progress add form. Persists across
   *  popover close + page reload so the user doesn't lose what they
   *  typed if they accidentally clicked outside or navigated away.
   *  Cleared on successful submit. */
  function draftKey(): string {
    return `supergit.customLinks.draft.${path}`;
  }
  function readDraft(): {
    kind?: "url" | "file" | "folder" | "command";
    url?: string;
    path?: string;
    cmd?: string;
    cwd?: string;
    runMode?: CommandRunMode;
    name?: string;
  } {
    try {
      const raw = localStorage.getItem(draftKey());
      if (!raw) return {};
      const parsed = JSON.parse(raw);
      if (typeof parsed !== "object" || parsed === null) return {};
      return parsed;
    } catch {
      return {};
    }
  }
  function writeDraft(): void {
    try {
      const draft = {
        kind: newKind,
        url: newUrl,
        path: newPath,
        cmd: newCmd,
        cwd: newCwd,
        runMode: newRunMode,
        name: newName,
      };
      // No empty-state pruning — keep the JSON shape stable so the
      // shape lookup on read stays trivial.
      localStorage.setItem(draftKey(), JSON.stringify(draft));
    } catch {
      // ignore — draft persistence is a nice-to-have, not load-bearing
    }
  }
  function clearDraft(): void {
    try {
      localStorage.removeItem(draftKey());
    } catch {
      // ignore
    }
  }

  // Persist the user's URL/File tab choice + in-progress field values
  // whenever they change, but only while the popover is open. This
  // guards against the "form fields just got reset to empty"
  // reactive blip clobbering the saved draft.
  $: if (typeof window !== "undefined" && addOpen) {
    writeLastKind(newKind);
    writeDraft();
  }

  async function runPathPicker(
    kind: "file" | "folder",
  ): Promise<string | null> {
    const startAt = readLastPick() ?? undefined;
    const endpoint = kind === "folder" ? "/api/pick-folder" : "/api/pick-file";
    const prompt = kind === "folder" ? "Pick a folder to link" : "Pick a file to link";
    const res = await fetch(endpoint, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        prompt,
        // Start at last-picked path if it still exists, else the
        // worktree directory. The daemon stat()s both and uses
        // whichever is real.
        startAt,
        fallback: path,
      }),
    });
    if (res.status === 204) return null; // cancelled
    if (!res.ok) throw new Error("Picker failed.");
    const body = (await res.json()) as { path?: string };
    if (!body.path) return null;
    writeLastPick(body.path);
    return body.path;
  }

  async function pickAddPath() {
    if (newKind !== "file" && newKind !== "folder") return;
    try {
      const picked = await runPathPicker(newKind);
      if (picked) newPath = picked;
    } catch (e) {
      addError = e instanceof Error ? e.message : String(e);
    }
  }

  async function pickAddCwd() {
    try {
      const picked = await runPathPicker("folder");
      if (picked) newCwd = picked;
    } catch (e) {
      addError = e instanceof Error ? e.message : String(e);
    }
  }

  async function pickEditCwd() {
    try {
      const picked = await runPathPicker("folder");
      if (picked) editCwd = picked;
    } catch (e) {
      editError = e instanceof Error ? e.message : String(e);
    }
  }

  function openLink(link: CustomLink) {
    const k = customLinkKind(link);
    if (k === "command") {
      onCommandClick?.(link);
      return;
    }
    if (k === "file" || k === "folder") {
      const p = (link as { path: string }).path;
      void fetch("/api/open-default", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ path: p }),
      });
      return;
    }
    openUrl((link as { url: string }).url);
  }

  /** Quick-delete path used by shift-click and right-click on a chip
   *  — same destructive confirm dialog the edit popover's Delete
   *  button uses, just skipping the form. */
  async function quickRemoveLink(link: CustomLink, ev: MouseEvent) {
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

  /** Drag-reorder state. `dragId` is the id of the chip the user is
   *  currently dragging; `localOrder` is the live, optimistically
   *  reordered view that drives the `{#each}` block during the drag so
   *  `animate:flip` can transition the other chips out of the way.
   *  Both reset on dragend (committed or not). */
  let dragId: string | null = null;
  let localOrder: CustomLink[] | null = null;

  $: displayLinks = localOrder ?? customLinks;

  function canReorder(): boolean {
    return onReorderCustomLinks !== null && !iconOnly && customLinks.length > 1;
  }

  function canDragOut(link: CustomLink): boolean {
    return customLinkKind(link) === "command" && repoId.length > 0;
  }

  function canDragLink(link: CustomLink): boolean {
    return canReorder() || canDragOut(link);
  }

  function startDrag(link: CustomLink, ev: DragEvent) {
    if (!ev.dataTransfer || !canDragLink(link)) return;
    const reorder = canReorder();
    if (reorder) {
      dragId = link.id;
      localOrder = [...customLinks];
    }
    ev.dataTransfer.effectAllowed =
      reorder && canDragOut(link) ? "copyMove" : reorder ? "move" : "copy";
    // Safari refuses to fire `dragover` unless dataTransfer carries
    // at least one payload — set a noop text/plain so cross-browser
    // drop targets activate.
    try { ev.dataTransfer.setData("text/plain", link.id); } catch { /* IE-only quirk */ }
    if (canDragOut(link) && link.kind === "command") {
      ev.dataTransfer.setData(
        LINK_TARGET_DRAG_MIME,
        JSON.stringify({
          target: {
            type: "command",
            value: link.id,
            label: linkLabel(link),
            subtitle: link.runMode,
            meta: "command",
            repoId,
            cwd: link.cwd || path,
            command: link.cmd,
            runMode: link.runMode,
          },
        }),
      );
    }
  }

  function onDragOverLink(target: CustomLink, ev: DragEvent) {
    if (!dragId || dragId === target.id || !localOrder) return;
    ev.preventDefault();
    if (ev.dataTransfer) ev.dataTransfer.dropEffect = "move";
    const el = ev.currentTarget as HTMLElement | null;
    if (!el) return;
    const rect = el.getBoundingClientRect();
    const before = ev.clientX < rect.left + rect.width / 2;
    const draggedIdx = localOrder.findIndex((l) => l.id === dragId);
    const targetIdx = localOrder.findIndex((l) => l.id === target.id);
    if (draggedIdx < 0 || targetIdx < 0) return;
    let insertIdx = before ? targetIdx : targetIdx + 1;
    if (draggedIdx < insertIdx) insertIdx--;
    if (insertIdx === draggedIdx) return;
    const next = [...localOrder];
    const [item] = next.splice(draggedIdx, 1);
    next.splice(insertIdx, 0, item!);
    localOrder = next;
  }

  function onDragOverStrip(ev: DragEvent) {
    // Allow drop anywhere in the strip so the browser shows the move
    // cursor instead of the no-drop one when the user hovers gaps
    // between chips.
    if (dragId) ev.preventDefault();
  }

  async function onDragEnd() {
    const id = dragId;
    const order = localOrder;
    dragId = null;
    localOrder = null;
    if (!id || !order || !onReorderCustomLinks) return;
    const next = order.map((l) => l.id);
    const original = customLinks.map((l) => l.id);
    if (next.join() === original.join()) return;
    await onReorderCustomLinks(next);
  }

  function onAddPopoverKeydown(ev: KeyboardEvent) {
    if (ev.key === "Escape") {
      ev.preventDefault();
      addOpen = false;
    }
  }

  function onEditPopoverKeydown(ev: KeyboardEvent) {
    if (ev.key === "Escape") {
      ev.preventDefault();
      closeEdit();
    }
  }

  /** Dismiss on outside-click. Each popover's anchor span owns the
   *  trigger + the popover element, so we check `contains()` against
   *  whichever anchor is currently active. `mousedown` so the popover
   *  closes before any competing handler inside the target node fires.
   *
   *  Skip while the confirm-dialog is open — its overlay sits over the
   *  popover, and treating the overlay click as "outside" would close
   *  the popover behind the dialog and dump the user's edits. */
  function onWindowMouseDown(ev: MouseEvent) {
    const target = ev.target;
    if (!(target instanceof Node)) return;
    if (target instanceof Element && target.closest(".confirm-overlay")) return;
    if (addOpen && anchorEl && !anchorEl.contains(target)) {
      addOpen = false;
    }
    if (editingLinkId) {
      const anchor = editAnchorEls.get(editingLinkId);
      if (anchor && !anchor.contains(target)) closeEdit();
    }
    if (cmdUrlDropdown) {
      if (!(target instanceof Element && target.closest(".cmd-url-wrap"))) {
        cmdUrlDropdown = null;
      }
    }
  }
</script>

<svelte:window on:mousedown={onWindowMouseDown} />

<div
  class="row-actions"
  class:icon-only={iconOnly}
  on:dragover={onDragOverStrip}
>
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
      <div class="custom-link-popover-mount" class:hidden={!addOpen}>
        <Popover variant="agents" extraClass="custom-link-popover">
          <div class="custom-link-form" on:keydown={onAddPopoverKeydown} role="group">
            <div class="custom-link-kinds" role="tablist">
              <button
                type="button"
                class="custom-link-kind"
                class:active={newKind === "url"}
                role="tab"
                aria-selected={newKind === "url"}
                on:click={() => (newKind = "url")}
              >
                <svg viewBox="0 0 24 24" width="13" height="13" aria-hidden="true" class="kind-icon">
                  <path d="M10 13a5 5 0 0 0 7.07 0l3-3a5 5 0 1 0-7.07-7.07l-1.5 1.5" />
                  <path d="M14 11a5 5 0 0 0-7.07 0l-3 3a5 5 0 1 0 7.07 7.07l1.5-1.5" />
                </svg>
                URL
              </button>
              <button
                type="button"
                class="custom-link-kind"
                class:active={newKind === "file"}
                role="tab"
                aria-selected={newKind === "file"}
                on:click={() => (newKind = "file")}
              >
                <svg viewBox="0 0 24 24" width="13" height="13" aria-hidden="true" class="kind-icon kind-icon-filled">
                  <path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z" />
                  <path d="M14 2v6h6" />
                </svg>
                File
              </button>
              <button
                type="button"
                class="custom-link-kind"
                class:active={newKind === "folder"}
                role="tab"
                aria-selected={newKind === "folder"}
                on:click={() => (newKind = "folder")}
              >
                <svg viewBox="0 0 24 24" width="13" height="13" aria-hidden="true" class="kind-icon kind-icon-filled">
                  <path d="M3 7a2 2 0 0 1 2-2h4l2 2h8a2 2 0 0 1 2 2v8a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z" />
                </svg>
                Folder
              </button>
              <button
                type="button"
                class="custom-link-kind"
                class:active={newKind === "command"}
                role="tab"
                aria-selected={newKind === "command"}
                on:click={() => (newKind = "command")}
              >
                <svg viewBox="0 0 24 24" width="13" height="13" aria-hidden="true" class="kind-icon">
                  <polyline points="4 17 10 11 4 5" />
                  <line x1="12" y1="19" x2="20" y2="19" />
                </svg>
                Cmd
              </button>
            </div>
            {#if newKind === "command"}
              <label class="custom-link-field">
                <span class="custom-link-label">Command</span>
                <div class="custom-link-suggest-wrap">
                  <input
                    bind:this={urlInput}
                    class="custom-link-input"
                    type="text"
                    placeholder={npmScriptsPlaceholder(npmScripts)}
                    bind:value={newCmd}
                    disabled={adding}
                    autocomplete="off"
                    on:focus={() => { showSuggestions = true; selectedSuggestionIdx = -1; }}
                    on:blur={() => { setTimeout(() => { showSuggestions = false; }, 150); }}
                    on:input={() => { showSuggestions = true; selectedSuggestionIdx = -1; }}
                    on:keydown={(e) => {
                      if (showSuggestions && addSuggestions.length > 0) {
                        if (e.key === "ArrowDown") {
                          e.preventDefault();
                          selectedSuggestionIdx = (selectedSuggestionIdx + 1) % addSuggestions.length;
                          return;
                        }
                        if (e.key === "ArrowUp") {
                          e.preventDefault();
                          selectedSuggestionIdx = selectedSuggestionIdx <= 0 ? addSuggestions.length - 1 : selectedSuggestionIdx - 1;
                          return;
                        }
                        if ((e.key === "Tab" || e.key === "Enter") && selectedSuggestionIdx >= 0) {
                          e.preventDefault();
                          newCmd = addSuggestions[selectedSuggestionIdx];
                          showSuggestions = false;
                          if (e.key === "Enter") submitAdd();
                          return;
                        }
                      }
                      if (e.key === "Escape") { showSuggestions = false; return; }
                      if (e.key === "Enter") submitAdd();
                    }}
                  />
                  {#if showSuggestions && addSuggestions.length > 0}
                    <ul class="cmd-suggestions" bind:this={suggestionsEl}>
                      {#each addSuggestions as s, i}
                        <li
                          class="cmd-suggestion"
                          class:active={i === selectedSuggestionIdx}
                          on:mousedown|preventDefault|stopPropagation={() => { newCmd = s; urlInput?.focus(); }}
                          on:mouseenter={() => { selectedSuggestionIdx = i; }}
                        >{s}</li>
                      {/each}
                    </ul>
                  {/if}
                </div>
              </label>
              <label class="custom-link-field">
                <span class="custom-link-label">Working directory <span class="muted">(optional — defaults to repo dir)</span></span>
                <div class="custom-link-fileinput">
                  <input
                    class="custom-link-input"
                    type="text"
                    placeholder={path}
                    bind:value={newCwd}
                    disabled={adding}
                    on:keydown={(e) => {
                      if (e.key === "Enter") submitAdd();
                    }}
                  />
                  <button
                    type="button"
                    class="tiny custom-link-browse"
                    on:click={pickAddCwd}
                    disabled={adding}
                  >Browse…</button>
                </div>
              </label>
              <div class="custom-link-field">
                <span class="custom-link-label">Run mode</span>
                <div class="custom-link-kinds" role="radiogroup" style="margin-top:2px">
                  <button
                    type="button"
                    class="custom-link-kind"
                    class:active={newRunMode === "shell"}
                    role="radio"
                    aria-checked={newRunMode === "shell"}
                    on:click={() => (newRunMode = "shell")}
                  >Shell</button>
                  <button
                    type="button"
                    class="custom-link-kind"
                    class:active={newRunMode === "internal"}
                    role="radio"
                    aria-checked={newRunMode === "internal"}
                    on:click={() => (newRunMode = "internal")}
                  >Internal</button>
                  <button
                    type="button"
                    class="custom-link-kind"
                    class:active={newRunMode === "external"}
                    role="radio"
                    aria-checked={newRunMode === "external"}
                    on:click={() => (newRunMode = "external")}
                  >External</button>
                </div>
              </div>
            {:else if newKind === "url"}
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
            {:else}
              <label class="custom-link-field">
                <span class="custom-link-label"
                  >{newKind === "folder" ? "Folder path" : "File path"}</span
                >
                <div class="custom-link-fileinput">
                  <input
                    class="custom-link-input"
                    type="text"
                    placeholder={newKind === "folder"
                      ? "/abs/path/to/folder"
                      : "/abs/path/to/file"}
                    bind:value={newPath}
                    disabled={adding}
                    on:keydown={(e) => {
                      if (e.key === "Enter") submitAdd();
                    }}
                  />
                  <button
                    type="button"
                    class="tiny custom-link-browse"
                    on:click={pickAddPath}
                    disabled={adding}
                  >Browse…</button>
                </div>
              </label>
            {/if}
            <label class="custom-link-field">
              <span class="custom-link-label">Label <span class="muted">(optional{newKind === "url" ? " — auto-fills from page title for URLs" : ""})</span></span>
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
                disabled={adding
                  || (newKind === "url" && newUrl.trim().length === 0)
                  || ((newKind === "file" || newKind === "folder")
                    && newPath.trim().length === 0)
                  || (newKind === "command" && newCmd.trim().length === 0)}
              >{adding ? "Adding…" : newKind === "command" ? "Add command" : "Add link"}</button>
            </div>
          </div>
        </Popover>
      </div>
    </span>
  {/if}
  {#each displayLinks as link (link.id)}
    {@const label = linkLabel(link)}
    {@const failed = failedFavicons.has(link.id)}
    {@const kind = customLinkKind(link)}
    {@const target = customLinkTarget(link)}
    {@const cmdRunning = kind === "command" && runningCommandIds.has(link.id)}
    {@const cmdUrls = kind === "command" ? commandUrls[link.id] : undefined}
    {@const cmdUrl = (cmdUrls && cmdUrlOverride[link.id] && cmdUrls.includes(cmdUrlOverride[link.id])) ? cmdUrlOverride[link.id] : cmdUrls?.[0]}
    <span
      class="custom-link-wrap"
      class:icon-only={iconOnly}
      class:draggable={canDragLink(link)}
      class:dragging={dragId === link.id}
      class:editing={editingLinkId === link.id}
      use:bindEditAnchor={link.id}
      role="group"
      draggable={canDragLink(link)}
      animate:flip={{ duration: 220 }}
      on:dragstart={(ev) => startDrag(link, ev)}
      on:dragover={(ev) => onDragOverLink(link, ev)}
      on:dragend={onDragEnd}
      on:drop|preventDefault={onDragEnd}
    >
      <button
        type="button"
        class="tiny open-in-btn custom-link-btn"
        class:icon-only={iconOnly}
        title={cmdRunning ? `Stop: ${target}` : linkTooltip(link)}
        on:click={(ev) => {
          if (ev.shiftKey) return quickRemoveLink(link, ev);
          openLink(link);
        }}
        on:contextmenu={(ev) => quickRemoveLink(link, ev)}
      >
        {#if kind === "url" && !failed}
          <img
            class="custom-link-favicon"
            src={`/api/favicon?url=${encodeURIComponent(target)}`}
            alt=""
            width="14"
            height="14"
            on:error={() => markFaviconFailed(link.id)}
          />
        {:else if kind === "file"}
          <!-- Generic file glyph for file-flavoured links. Outline +
               muted so it reads as a quiet "platform default app"
               affordance rather than competing with the brand
               favicons / agent icons next to it. -->
          <svg
            class="open-in-icon muted"
            viewBox="0 0 24 24"
            width="13"
            height="13"
            aria-hidden="true"
          >
            <path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z" />
            <path d="M14 2v6h6" />
          </svg>
        {:else if kind === "folder"}
          <svg
            class="open-in-icon muted"
            viewBox="0 0 24 24"
            width="13"
            height="13"
            aria-hidden="true"
          >
            <path d="M3 7a2 2 0 0 1 2-2h4l2 2h8a2 2 0 0 1 2 2v8a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z" />
          </svg>
        {:else if kind === "command"}
          {#if cmdRunning}
            <svg
              class="open-in-icon cmd-spinner"
              viewBox="0 0 24 24"
              width="13"
              height="13"
              aria-hidden="true"
            >
              <circle cx="12" cy="12" r="9" />
            </svg>
          {:else}
            <svg
              class="open-in-icon muted"
              viewBox="0 0 24 24"
              width="13"
              height="13"
              aria-hidden="true"
            >
              <polyline points="4 17 10 11 4 5" />
              <line x1="12" y1="19" x2="20" y2="19" />
            </svg>
          {/if}
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
        {#if cmdUrl}
          <span class="cmd-url-wrap">
            <span
              class="cmd-url-inner"
              role="link"
              tabindex="-1"
              title={`Open ${cmdUrl}`}
              on:click|stopPropagation={() => openUrl(cmdUrl)}
              on:keydown={(e) => { if (e.key === "Enter") openUrl(cmdUrl); }}
            >
              <svg viewBox="0 0 24 24" width="12" height="12" aria-hidden="true">
                <path d="M18 13v6a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h6" />
                <polyline points="15 3 21 3 21 9" />
                <line x1="10" y1="14" x2="21" y2="3" />
              </svg>
            </span>
            {#if cmdUrls && cmdUrls.length > 1}
              <span
                class="cmd-url-caret"
                role="button"
                tabindex="-1"
                title="More URLs"
                on:click|stopPropagation={() => {
                  cmdUrlDropdown = cmdUrlDropdown === link.id ? null : link.id;
                }}
              >
                <svg viewBox="0 0 24 24" width="8" height="8" aria-hidden="true">
                  <polyline points="6 9 12 15 18 9" />
                </svg>
              </span>
            {/if}
            {#if cmdUrlDropdown === link.id && cmdUrls}
              <div class="cmd-url-dropdown">
                {#each cmdUrls as u}
                  <button
                    type="button"
                    class="cmd-url-option"
                    class:active={u === cmdUrl}
                    on:click|stopPropagation={() => { openUrl(u); cmdUrlOverride = { ...cmdUrlOverride, [link.id]: u }; cmdUrlDropdown = null; }}
                  >
                    {new URL(u).host}
                  </button>
                {/each}
              </div>
            {/if}
          </span>
        {/if}
      </button>
      {#if onEditCustomLink && !iconOnly}
        <!-- Edit pencil — hover-revealed on the wrap. Opens a popover
             with URL + Label fields and a Delete button (confirmed via
             the app-wide ConfirmDialog). Skipped in iconOnly mode
             (folded row-head) since the chip's already a 22px circle
             with no kebab room — users shift-click / right-click for
             quick removal, or expand the row to edit. -->
        <button
          type="button"
          class="custom-link-edit"
          title={`Edit this link`}
          aria-label={`Edit ${label}`}
          on:click|stopPropagation={() => openEdit(link)}
        >
          <!-- Solid pencil — single filled path so the glyph stays
               legible at 10px without stroke artifacts. -->
          <svg viewBox="0 0 24 24" width="10" height="10" aria-hidden="true">
            <path
              d="M3 17.25V21h3.75L17.81 9.94l-3.75-3.75L3 17.25zM20.71 7.04a1 1 0 0 0 0-1.41l-2.34-2.34a1 1 0 0 0-1.41 0l-1.83 1.83 3.75 3.75 1.83-1.83z"
            />
          </svg>
        </button>
      {/if}
      {#if editingLinkId === link.id}
        <Popover variant="agents" extraClass="custom-link-popover">
          <div
            class="custom-link-form"
            on:keydown={onEditPopoverKeydown}
            role="group"
          >
            <div class="custom-link-kinds" role="tablist">
              <button
                type="button"
                class="custom-link-kind"
                class:active={editKind === "url"}
                role="tab"
                aria-selected={editKind === "url"}
                on:click={() => (editKind = "url")}
              >
                <svg viewBox="0 0 24 24" width="13" height="13" aria-hidden="true" class="kind-icon">
                  <path d="M10 13a5 5 0 0 0 7.07 0l3-3a5 5 0 1 0-7.07-7.07l-1.5 1.5" />
                  <path d="M14 11a5 5 0 0 0-7.07 0l-3 3a5 5 0 1 0 7.07 7.07l1.5-1.5" />
                </svg>
                URL
              </button>
              <button
                type="button"
                class="custom-link-kind"
                class:active={editKind === "file"}
                role="tab"
                aria-selected={editKind === "file"}
                on:click={() => (editKind = "file")}
              >
                <svg viewBox="0 0 24 24" width="13" height="13" aria-hidden="true" class="kind-icon kind-icon-filled">
                  <path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z" />
                  <path d="M14 2v6h6" />
                </svg>
                File
              </button>
              <button
                type="button"
                class="custom-link-kind"
                class:active={editKind === "folder"}
                role="tab"
                aria-selected={editKind === "folder"}
                on:click={() => (editKind = "folder")}
              >
                <svg viewBox="0 0 24 24" width="13" height="13" aria-hidden="true" class="kind-icon kind-icon-filled">
                  <path d="M3 7a2 2 0 0 1 2-2h4l2 2h8a2 2 0 0 1 2 2v8a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z" />
                </svg>
                Folder
              </button>
              <button
                type="button"
                class="custom-link-kind"
                class:active={editKind === "command"}
                role="tab"
                aria-selected={editKind === "command"}
                on:click={() => (editKind = "command")}
              >
                <svg viewBox="0 0 24 24" width="13" height="13" aria-hidden="true" class="kind-icon">
                  <polyline points="4 17 10 11 4 5" />
                  <line x1="12" y1="19" x2="20" y2="19" />
                </svg>
                Cmd
              </button>
            </div>
            {#if editKind === "command"}
              <label class="custom-link-field">
                <span class="custom-link-label">Command</span>
                <div class="custom-link-suggest-wrap">
                  <input
                    bind:this={editUrlInput}
                    class="custom-link-input"
                    type="text"
                    bind:value={editCmd}
                    disabled={editing}
                    autocomplete="off"
                    on:focus={() => { showEditSuggestions = true; selectedEditSuggestionIdx = -1; }}
                    on:blur={() => { setTimeout(() => { showEditSuggestions = false; }, 150); }}
                    on:input={() => { showEditSuggestions = true; selectedEditSuggestionIdx = -1; }}
                    on:keydown={(e) => {
                      if (showEditSuggestions && editSuggestions.length > 0) {
                        if (e.key === "ArrowDown") {
                          e.preventDefault();
                          selectedEditSuggestionIdx = (selectedEditSuggestionIdx + 1) % editSuggestions.length;
                          return;
                        }
                        if (e.key === "ArrowUp") {
                          e.preventDefault();
                          selectedEditSuggestionIdx = selectedEditSuggestionIdx <= 0 ? editSuggestions.length - 1 : selectedEditSuggestionIdx - 1;
                          return;
                        }
                        if ((e.key === "Tab" || e.key === "Enter") && selectedEditSuggestionIdx >= 0) {
                          e.preventDefault();
                          editCmd = editSuggestions[selectedEditSuggestionIdx];
                          showEditSuggestions = false;
                          if (e.key === "Enter") submitEdit();
                          return;
                        }
                      }
                      if (e.key === "Escape") { showEditSuggestions = false; return; }
                      if (e.key === "Enter") submitEdit();
                    }}
                  />
                  {#if showEditSuggestions && editSuggestions.length > 0}
                    <ul class="cmd-suggestions">
                      {#each editSuggestions as s, i}
                        <li
                          class="cmd-suggestion"
                          class:active={i === selectedEditSuggestionIdx}
                          on:mousedown|preventDefault|stopPropagation={() => { editCmd = s; editUrlInput?.focus(); }}
                          on:mouseenter={() => { selectedEditSuggestionIdx = i; }}
                        >{s}</li>
                      {/each}
                    </ul>
                  {/if}
                </div>
              </label>
              <label class="custom-link-field">
                <span class="custom-link-label">Working directory <span class="muted">(optional)</span></span>
                <div class="custom-link-fileinput">
                  <input
                    class="custom-link-input"
                    type="text"
                    placeholder={path}
                    bind:value={editCwd}
                    disabled={editing}
                    on:keydown={(e) => {
                      if (e.key === "Enter") submitEdit();
                    }}
                  />
                  <button
                    type="button"
                    class="tiny custom-link-browse"
                    on:click={pickEditCwd}
                    disabled={editing}
                  >Browse…</button>
                </div>
              </label>
              <div class="custom-link-field">
                <span class="custom-link-label">Run mode</span>
                <div class="custom-link-kinds" role="radiogroup" style="margin-top:2px">
                  <button
                    type="button"
                    class="custom-link-kind"
                    class:active={editRunMode === "shell"}
                    role="radio"
                    aria-checked={editRunMode === "shell"}
                    on:click={() => (editRunMode = "shell")}
                  >Shell</button>
                  <button
                    type="button"
                    class="custom-link-kind"
                    class:active={editRunMode === "internal"}
                    role="radio"
                    aria-checked={editRunMode === "internal"}
                    on:click={() => (editRunMode = "internal")}
                  >Internal</button>
                  <button
                    type="button"
                    class="custom-link-kind"
                    class:active={editRunMode === "external"}
                    role="radio"
                    aria-checked={editRunMode === "external"}
                    on:click={() => (editRunMode = "external")}
                  >External</button>
                </div>
              </div>
            {:else if editKind === "url"}
              <label class="custom-link-field">
                <span class="custom-link-label">URL</span>
                <input
                  bind:this={editUrlInput}
                  class="custom-link-input"
                  type="url"
                  bind:value={editUrl}
                  disabled={editing}
                  on:keydown={(e) => {
                    if (e.key === "Enter") submitEdit();
                  }}
                />
              </label>
            {:else}
              <label class="custom-link-field">
                <span class="custom-link-label"
                  >{editKind === "folder" ? "Folder path" : "File path"}</span
                >
                <div class="custom-link-fileinput">
                  <input
                    class="custom-link-input"
                    type="text"
                    bind:value={editPath}
                    disabled={editing}
                    on:keydown={(e) => {
                      if (e.key === "Enter") submitEdit();
                    }}
                  />
                  <button
                    type="button"
                    class="tiny custom-link-browse"
                    on:click={pickEditPath}
                    disabled={editing}
                  >Browse…</button>
                </div>
              </label>
            {/if}
            <label class="custom-link-field">
              <span class="custom-link-label"
                >Label <span class="muted">(optional)</span></span
              >
              <input
                class="custom-link-input"
                type="text"
                bind:value={editName}
                disabled={editing}
                on:keydown={(e) => {
                  if (e.key === "Enter") submitEdit();
                }}
              />
            </label>
            {#if editError}
              <div class="custom-link-error">{editError}</div>
            {/if}
            <div class="custom-link-buttons">
              {#if onRemoveCustomLink}
                <button
                  type="button"
                  class="tiny custom-link-delete"
                  on:click={deleteFromEdit}
                  disabled={editing}
                  title="Delete this link"
                >Delete</button>
              {/if}
              <span class="custom-link-buttons-spacer"></span>
              <button
                type="button"
                class="tiny custom-link-cancel"
                on:click={closeEdit}
                disabled={editing}
              >Cancel</button>
              <button
                type="button"
                class="tiny custom-link-go"
                on:click={submitEdit}
                disabled={editing
                  || (editKind === "url" && editUrl.trim().length === 0)
                  || ((editKind === "file" || editKind === "folder")
                    && editPath.trim().length === 0)
                  || (editKind === "command" && editCmd.trim().length === 0)}
              >{editing ? "Saving…" : "Save"}</button>
            </div>
          </div>
        </Popover>
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
  /* Drag affordance — the favicon doubles as the drag handle, so the
     `grab` cursor is anchored to it rather than the whole chip. The
     wrap itself stays normal-cursor so the label feels click-only. */
  .custom-link-wrap.draggable :global(.custom-link-favicon),
  .custom-link-wrap.draggable :global(.open-in-icon) {
    cursor: grab;
  }
  .custom-link-wrap.dragging {
    opacity: 0.35;
  }
  .custom-link-wrap.dragging :global(.custom-link-favicon),
  .custom-link-wrap.dragging :global(.open-in-icon) {
    cursor: grabbing;
  }
  /* Edit pencil — hover-revealed at the chip's top-right. No border
     and no chip background; just the filled glyph sitting against
     the row. The visible glyph stays at 10px, but the button itself
     carries enough padding to make a comfortable ~22px click target
     (negative inset keeps the visual top-right corner aligned with
     the chip). Reads as "tweak" rather than "remove now" — the
     destructive delete lives inside the edit popover. */
  .custom-link-edit {
    position: absolute;
    top: -8px;
    right: -11px;
    width: 22px;
    height: 22px;
    border: none;
    padding: 6px;
    background: transparent;
    color: var(--text-muted);
    cursor: pointer;
    opacity: 0;
    transition: opacity 0.12s, color 0.12s;
    display: inline-flex;
    align-items: center;
    justify-content: center;
    box-sizing: border-box;
  }
  .custom-link-wrap:hover .custom-link-edit,
  .custom-link-wrap:focus-within .custom-link-edit,
  .custom-link-wrap.editing .custom-link-edit,
  .custom-link-edit:hover,
  .custom-link-edit:focus-visible {
    opacity: 1;
  }
  .custom-link-edit:hover,
  .custom-link-edit:focus-visible {
    color: var(--text, inherit);
    outline: none;
  }
  .custom-link-edit svg {
    fill: currentColor;
    stroke: none;
    display: block;
  }

  .custom-link-btn {
    display: inline-flex;
    align-items: center;
    gap: 0.3rem;
    line-height: 1;
    white-space: nowrap;
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
  /* Tab-style toggle between URL / File at the top of the form. The
     selected tab carries a thin underline-style accent so it reads as
     "you're editing this kind right now". */
  .custom-link-kinds {
    display: inline-flex;
    gap: 0.15rem;
    align-self: flex-start;
    padding: 2px;
    background: color-mix(in srgb, var(--text-muted) 12%, transparent);
    border-radius: 4px;
  }
  .custom-link-kind {
    display: inline-flex;
    align-items: center;
    gap: 0.3rem;
    font: inherit;
    font-size: 0.75rem;
    padding: 0.2rem 0.55rem;
    border: none;
    background: transparent;
    color: var(--text-muted);
    border-radius: 3px;
    cursor: pointer;
  }
  .custom-link-kind:hover {
    color: var(--text, inherit);
  }
  .custom-link-kind.active {
    background: var(--surface-1);
    color: var(--text, inherit);
  }
  .kind-icon {
    flex: 0 0 auto;
    fill: none;
    stroke: currentColor;
    stroke-width: 1.8;
    stroke-linecap: round;
    stroke-linejoin: round;
  }
  .kind-icon.kind-icon-filled {
    fill: currentColor;
    stroke: none;
  }
  /* File path input + Browse button live on one row. Input flexes,
     the button hugs its label. */
  .custom-link-fileinput {
    display: flex;
    gap: 0.3rem;
    align-items: center;
  }
  .custom-link-fileinput .custom-link-input {
    flex: 1 1 auto;
  }
  .custom-link-browse {
    flex: 0 0 auto;
  }
  /* The file glyph (rendered via `<svg class="open-in-icon filled">`)
     fills with currentColor instead of stroking. Otherwise the
     stroked variant defined a few rules up would draw a hollow
     icon — wrong silhouette for a file. */
  .open-in-icon.filled {
    fill: currentColor;
    stroke: none;
  }
  .custom-link-buttons {
    display: flex;
    align-items: center;
    gap: 0.3rem;
    margin-top: 0.15rem;
  }
  .custom-link-buttons-spacer {
    flex: 1 1 auto;
  }
  .custom-link-delete {
    color: #c0392b;
    border: 1px solid color-mix(in srgb, #c0392b 50%, transparent);
    background: transparent;
  }
  .custom-link-delete:hover:not(:disabled) {
    background: color-mix(in srgb, #c0392b 75%, transparent);
    color: #fff;
  }

  /* Override the agents-popover defaults: the shared shell ships with
     min-width 380px for the wide picker lists, more than this two-
     field form needs. Inputs don't naturally push their parent wider
     (they pin to whatever explicit width the container hands them),
     so `width: max-content` against the agents-popover root just
     settled at min-width. Pin the popover to a comfortable URL-
     friendly width (~340px ≈ 1.5× the old 240px baseline) so longer
     URLs are legible without scrolling. `:global()` is required
     because the popover root lives outside this component's scope
     hash. */
  :global(.custom-link-popover) {
    min-width: 340px;
    width: 340px;
    max-width: 90vw;
    padding: 0.45rem 0.55rem;
  }
  /* Inputs fill the popover. `min-width: 0` overrides the flex
     default that would otherwise prevent shrinking on narrow
     viewports. */
  .custom-link-input {
    min-width: 0;
  }
  .cmd-spinner {
    fill: none;
    stroke: currentColor;
    stroke-width: 2.5;
    stroke-dasharray: 42;
    stroke-dashoffset: 12;
    stroke-linecap: round;
    animation: cmd-spin 0.8s linear infinite;
    transform-origin: center;
  }
  @keyframes cmd-spin {
    to { transform: rotate(360deg); }
  }
  .cmd-url-inner {
    display: inline-flex;
    align-items: center;
    justify-content: center;
    padding: 1px 2px;
    margin-left: 0;
    border-radius: 2px;
    color: var(--text-muted);
    cursor: pointer;
    transition: color 0.12s;
  }
  .cmd-url-inner:hover {
    color: var(--text-1, #fff);
  }
  .cmd-url-inner svg {
    fill: none;
    stroke: currentColor;
    stroke-width: 2;
    stroke-linecap: round;
    stroke-linejoin: round;
  }
  .cmd-url-wrap {
    position: relative;
    display: inline-flex;
    align-items: center;
  }
  .cmd-url-caret {
    display: inline-flex;
    align-items: center;
    justify-content: center;
    padding: 0 1px;
    color: var(--text-muted);
    cursor: pointer;
    transition: color 0.12s;
  }
  .cmd-url-caret:hover { color: var(--text-1, #fff); }
  .cmd-url-caret svg {
    fill: none;
    stroke: currentColor;
    stroke-width: 2.5;
    stroke-linecap: round;
    stroke-linejoin: round;
  }
  .cmd-url-dropdown {
    position: absolute;
    top: 100%;
    right: 0;
    z-index: 200;
    margin-top: 4px;
    padding: 4px 0;
    background: var(--bg-2, #1e1e1e);
    border: 1px solid var(--border, #333);
    border-radius: 4px;
    box-shadow: 0 4px 12px rgba(0,0,0,0.4);
    min-width: 180px;
    white-space: nowrap;
  }
  .cmd-url-option {
    display: block;
    width: 100%;
    padding: 5px 12px;
    border: none;
    background: none;
    color: var(--text-2, #ccc);
    font: inherit;
    font-size: 0.82rem;
    text-align: left;
    cursor: pointer;
  }
  .cmd-url-option:hover {
    background: var(--bg-hover, #2a2a2a);
    color: var(--text-1, #fff);
  }
  .cmd-url-option.active {
    color: var(--accent, #58a6ff);
  }
  .custom-link-popover-mount.hidden {
    display: none;
  }
  .custom-link-suggest-wrap {
    position: relative;
  }
  .cmd-suggestions {
    position: absolute;
    top: 100%;
    left: 0;
    right: 0;
    z-index: 100;
    margin: 2px 0 0;
    padding: 3px 0;
    list-style: none;
    background: var(--bg-2, #1e1e1e);
    border: 1px solid var(--border, #444);
    border-radius: 4px;
    max-height: 160px;
    overflow-y: auto;
    box-shadow: 0 4px 12px rgba(0,0,0,0.35);
  }
  .cmd-suggestion {
    padding: 3px 8px;
    font-size: 12px;
    cursor: pointer;
    color: var(--text-2, #ccc);
    white-space: nowrap;
    overflow: hidden;
    text-overflow: ellipsis;
  }
  .cmd-suggestion:hover,
  .cmd-suggestion.active {
    background: var(--accent, #2563eb);
    color: #fff;
  }
</style>
