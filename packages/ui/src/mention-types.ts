/**
 * Shared types for the mention/picker family. Lives apart from the
 * Svelte components so providers (which are pure TS) and tests don't
 * have to pull in Svelte to import `PickItem`.
 *
 * One picker. Many call sites. Pluggable providers. The shape here
 * is the contract that lets the popover stay dumb (renders a list of
 * PickItems) while each provider owns its own data source and ranking.
 */

/** Per-provider identifier. Used as a dedup key in the recents store
 *  and as the section heading id in the popover. */
export type ProviderId = "sessions" | "commits";

/** The link-target categories the rest of the app already understands
 *  (see daemon's LinkTarget). The picker maps each PickItem onto one
 *  of these so the link-kind StickyNote can render the right icon /
 *  open the right opener without knowing about providers. */
export type TargetType = "session" | "commit" | "url" | "file";

/** Search scope: what the picker should look at. `currentRepoPath`
 *  filters sessions / commits to the repo the note is anchored to;
 *  `currentWorktreePath` is what `/api/commits` requires. Leaving
 *  either undefined widens the scope (workspace-wide); call sites
 *  can opt in to that today via the AnchorPicker → "Move to" flow
 *  and will get a real scope-toggle UI later. */
export interface SearchScope {
  currentRepoPath?: string;
  currentWorktreePath?: string;
  /** Git remote provider for the current repo ("github" | "gitlab" |
   *  "bitbucket" | "azure" | "codeberg" | "sourcehut" | "gitea" | ...).
   *  Commit picker rows + saved commit chips use this to render the
   *  origin's brand mark instead of a generic glyph. Resolved by the
   *  caller (today: StickyNote reads it from repos[].remotes[0]). */
  currentRepoProvider?: string;
}

/** Single result in the picker. `value` is what ends up in the
 *  attachment's `target.value`; `targetType` what ends up in
 *  `target.type`. `label` is the primary line, `subtitle` the
 *  secondary, `meta` the right-aligned hint (age, author). */
export interface PickItem {
  providerId: ProviderId;
  /** Provider-unique id. Used to dedup recents and as a stable Svelte
   *  {#each} key. For sessions this is the session id; for commits
   *  the full sha. */
  id: string;
  value: string;
  targetType: TargetType;
  label: string;
  subtitle?: string;
  meta?: string;
  /** Session agent ("claude", "codex", ...) — drives AgentIcon
   *  rendering. Kept separate from `subtitle` so subtitle is free
   *  to carry display text (message count, author, etc.). */
  agent?: string;
  /** Git remote provider ("github", "gitlab", ...) — drives the
   *  brand-mark icon on commit picker rows / chips. */
  provider?: string;
}

/** Pluggable data source. `search` runs the provider's filter on the
 *  raw data (network fetch + fuzzy match) and returns a ranked list,
 *  bounded to ~8 items unless the caller bumps `limit`. */
export interface Provider {
  id: ProviderId;
  /** Group heading shown above this provider's items. */
  label: string;
  search(
    query: string,
    scope: SearchScope,
    limit?: number,
  ): Promise<PickItem[]>;
}
