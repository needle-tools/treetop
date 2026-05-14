import { writable } from "svelte/store";

export interface NoteShape {
  id: string;
  anchors: string[];
  tags: string[];
  body: string;
  createdAt: string;
  updatedAt: string;
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
