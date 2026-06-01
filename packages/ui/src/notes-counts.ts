import { writable } from "svelte/store";

export interface NoteLinkTargetShape {
  type: "url" | "commit" | "session" | "file" | "command";
  value: string;
  label?: string;
  subtitle?: string;
  meta?: string;
  agent?: string;
  provider?: string;
  repoId?: string;
  cwd?: string;
  command?: string;
  runMode?: "internal" | "external" | "shell";
}

export interface NoteShape {
  id: string;
  anchors: string[];
  tags: string[];
  body: string;
  createdAt: string;
  updatedAt: string;
  /** Discriminator that mirrors the daemon's `AttachmentKind`. Absent on
   *  pre-existing note files; treat `undefined` as `"note"`. */
  kind?: "note" | "link";
  /** Only set when `kind === "link"`. Lets list consumers (the per-row
   *  notes popover) render a useful chip-style line for link kinds
   *  whose `body` is empty. */
  target?: NoteLinkTargetShape;
  /** In-memory only (NOT persisted): which daemon this note was fetched
   *  from — undefined = local. Set when StickyNotesLayer merges notes from
   *  all daemons, so updates/deletes route back to the owning daemon. */
  daemonId?: string;
}

/** Count of notes pinned to each anchor string (e.g.
 *  `worktree:/abs/path`). Maintained by `StickyNotesLayer.svelte`
 *  whenever it fetches `/api/notes` so any consumer in the app tree
 *  (the per-row "+ note" badge in `App.svelte`, future indices) can
 *  read it without re-fetching. Empty until the layer mounts. */
export const notesCountByAnchor = writable<Record<string, number>>({});

/** Every note in the workspace, also maintained by
 *  `StickyNotesLayer.svelte` on each `/api/notes` refresh. App-level
 *  consumers (the orphan-notes tray in App.svelte) use it to find
 *  notes whose anchor doesn't resolve to a live repo / worktree. */
export const notesAll = writable<NoteShape[]>([]);
