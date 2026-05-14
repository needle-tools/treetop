import { writable } from "svelte/store";

/** Count of notes pinned to each anchor string (e.g.
 *  `worktree:/abs/path`). Maintained by `StickyNotesLayer.svelte`
 *  whenever it fetches `/api/notes` so any consumer in the app tree
 *  (the per-row "+ note" badge in `App.svelte`, future indices) can
 *  read it without re-fetching. Empty until the layer mounts. */
export const notesCountByAnchor = writable<Record<string, number>>({});
