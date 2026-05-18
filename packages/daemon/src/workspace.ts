import { join } from "node:path";
import { mkdir, readFile, writeFile, access } from "node:fs/promises";
import { randomUUID } from "node:crypto";

/**
 * User-defined "open in" link. Two flavours:
 *  - `kind: "url"` — a plain web URL (Coolify dashboards, staging
 *    deploys). Opened in a new browser tab by the UI.
 *  - `kind: "file"` — a local filesystem path opened with the
 *    operating system's default app (the same handler a Finder /
 *    Explorer double-click would route to).
 *
 * The `kind` field is optional on read to keep older repos.json
 * files (written before file links existed) interpretable — entries
 * without a kind default to "url" and carry their target in `url`.
 * New writes always include the explicit `kind`.
 */
export type CustomLink =
  | { id: string; kind?: "url"; url: string; name?: string }
  | { id: string; kind: "file"; path: string; name?: string };

/** Resolve a CustomLink's effective kind, treating a missing field as
 *  "url" for backward-compat with pre-file-link repos.json entries. */
export function customLinkKind(link: CustomLink): "url" | "file" {
  return link.kind === "file" ? "file" : "url";
}

/** Resolve a CustomLink's open target — URL for `url` links, absolute
 *  filesystem path for `file` links. The two share no field name, so
 *  callers reach for this helper instead of `link.url ?? link.path`. */
export function customLinkTarget(link: CustomLink): string {
  return customLinkKind(link) === "file"
    ? (link as { path: string }).path
    : (link as { url: string }).url;
}

/** Validate raw user input and assemble a CustomLink with the given
 *  id. Shared by `addCustomLink` (which generates a fresh uuid) and
 *  `updateCustomLink` (which preserves the existing id while swapping
 *  the target). Throws on bad URLs / non-absolute file paths /
 *  unknown kinds. */
function buildCustomLink(
  id: string,
  input:
    | { url: string; name?: string }
    | { kind: "url"; url: string; name?: string }
    | { kind: "file"; path: string; name?: string },
): CustomLink {
  const isFile = "kind" in input && input.kind === "file";
  if (isFile) {
    const rawPath =
      typeof (input as { path: string }).path === "string"
        ? (input as { path: string }).path.trim()
        : "";
    if (rawPath.length === 0) {
      throw new Error("path must be a non-empty string");
    }
    if (!rawPath.startsWith("/") && !/^[a-zA-Z]:[\\/]/.test(rawPath)) {
      throw new Error("path must be absolute");
    }
    const link: CustomLink = { id, kind: "file", path: rawPath };
    if (typeof input.name === "string") {
      const trimmed = input.name.trim();
      if (trimmed.length > 0) link.name = trimmed;
    }
    return link;
  }
  // URL — either explicit `kind: "url"` or the legacy `{ url }` shape.
  const rawUrl =
    typeof (input as { url: string }).url === "string"
      ? (input as { url: string }).url.trim()
      : "";
  if (rawUrl.length === 0) {
    throw new Error("url must be a non-empty string");
  }
  let parsed: URL;
  try {
    parsed = new URL(rawUrl);
  } catch {
    throw new Error("url must be a valid URL");
  }
  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
    throw new Error("url must be http(s)");
  }
  const link: CustomLink = { id, kind: "url", url: rawUrl };
  if (typeof input.name === "string") {
    const trimmed = input.name.trim();
    if (trimmed.length > 0) link.name = trimmed;
  }
  return link;
}

export interface Repo {
  id: string;
  path: string;
  name: string;
  addedAt: string;
  /** Optional accent colour for the repo name — applied wherever the
   *  repo title renders (worktree header chip, TUI overview, etc.) so
   *  the user can tell repos apart at a glance. `#rrggbb` lowercase
   *  hex when set; absent means "use the default text colour". */
  color?: string;
  /** User-defined "open in <X>" links (e.g. Coolify dashboards, staging
   *  URLs). Render as extra chips in the worktree row's actions strip,
   *  with the target site's favicon as their icon. */
  customLinks?: CustomLink[];
}

interface ReposFile {
  repos: Repo[];
}

const REPOS_FILE = "repos.json";
const SESSION_TITLES_FILE = "session-titles.json";

export class Workspace {
  private constructor(public readonly path: string) {}

  static async open(path: string): Promise<Workspace> {
    await mkdir(path, { recursive: true });
    const reposPath = join(path, REPOS_FILE);
    try {
      await access(reposPath);
    } catch {
      const empty: ReposFile = { repos: [] };
      await writeFile(reposPath, JSON.stringify(empty, null, 2));
    }
    return new Workspace(path);
  }

  /** Return all manual session titles as `{ [source]: title }`. Missing
   *  file or unparseable contents yield an empty map (tolerant of corrupt
   *  state). */
  async listSessionTitles(): Promise<Record<string, string>> {
    let raw: string;
    try {
      raw = await readFile(join(this.path, SESSION_TITLES_FILE), "utf-8");
    } catch {
      return {};
    }
    let parsed: unknown;
    try {
      parsed = JSON.parse(raw);
    } catch {
      return {};
    }
    if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
      return {};
    }
    const out: Record<string, string> = {};
    for (const [k, v] of Object.entries(parsed as Record<string, unknown>)) {
      if (typeof k !== "string" || k.length === 0) continue;
      if (typeof v !== "string" || v.length === 0) continue;
      out[k] = v;
    }
    return out;
  }

  /** Persist a manual title for a session, keyed by the session's `source`
   *  (its JSONL path, or the synthetic `__new__:…` source while a TUI is
   *  still spawning). Empty / whitespace-only `title` deletes the entry. */
  async setSessionTitle(source: string, title: string): Promise<void> {
    if (typeof source !== "string" || source.length === 0) {
      throw new Error("source must be a non-empty string");
    }
    const titles = await this.listSessionTitles();
    const trimmed = title.trim();
    if (trimmed.length === 0) {
      if (!(source in titles)) return;
      delete titles[source];
    } else {
      titles[source] = trimmed;
    }
    await writeFile(
      join(this.path, SESSION_TITLES_FILE),
      JSON.stringify(titles, null, 2),
    );
  }

  /** Move a manual title from `oldSource` to `newSource`. Used when a
   *  column's source string changes mid-flight (e.g. a `__new__:shell:<random>`
   *  PTY spawns and we swap to its `__attached__:shell:<termId>` form, or a
   *  `__new__:claude:<random>` agent's JSONL appears on disk and we swap to
   *  the real path). Without this, the title the user typed against the
   *  synthetic source would be silently orphaned.
   *
   *  No-op if `oldSource` has no title. Preserves both entries if `newSource`
   *  already has its own title (the more-explicit later edit wins; we never
   *  silently overwrite). */
  async migrateSessionTitle(oldSource: string, newSource: string): Promise<void> {
    if (typeof oldSource !== "string" || oldSource.length === 0) {
      throw new Error("oldSource must be a non-empty string");
    }
    if (typeof newSource !== "string" || newSource.length === 0) {
      throw new Error("newSource must be a non-empty string");
    }
    if (oldSource === newSource) return;
    const titles = await this.listSessionTitles();
    const oldTitle = titles[oldSource];
    if (!oldTitle) return;
    if (titles[newSource]) return; // destination already named; don't clobber
    delete titles[oldSource];
    titles[newSource] = oldTitle;
    await writeFile(
      join(this.path, SESSION_TITLES_FILE),
      JSON.stringify(titles, null, 2),
    );
  }

  async listRepos(): Promise<Repo[]> {
    const data = await readFile(join(this.path, REPOS_FILE), "utf-8");
    const parsed = JSON.parse(data) as ReposFile;
    return parsed.repos;
  }

  async addRepo(repoPath: string): Promise<Repo> {
    const repos = await this.listRepos();
    if (repos.some((r) => r.path === repoPath)) {
      throw new Error(`Repo already registered: ${repoPath}`);
    }
    const segments = repoPath.split("/").filter(Boolean);
    const name = segments[segments.length - 1] ?? repoPath;
    const repo: Repo = {
      id: randomUUID(),
      path: repoPath,
      name,
      addedAt: new Date().toISOString(),
    };
    repos.push(repo);
    await this.writeRepos(repos);
    return repo;
  }

  async removeRepo(id: string): Promise<boolean> {
    const repos = await this.listRepos();
    const next = repos.filter((r) => r.id !== id);
    if (next.length === repos.length) return false;
    await this.writeRepos(next);
    return true;
  }

  /**
   * Re-insert a repo with its original id and metadata. Used by undo/redo so
   * id stability lets later toggle events still reference the same repo.
   */
  async restoreRepo(repo: Repo): Promise<void> {
    const repos = await this.listRepos();
    if (repos.some((r) => r.id === repo.id)) {
      throw new Error(`Repo already exists with id ${repo.id}`);
    }
    if (repos.some((r) => r.path === repo.path)) {
      throw new Error(`Repo already exists at path ${repo.path}`);
    }
    repos.push(repo);
    await this.writeRepos(repos);
  }

  /**
   * Set (or clear with `null`) a repo's accent colour. Returns the
   * previous and new values so the caller can decide whether to emit
   * an event or skip a no-op write. Colours are validated as `#rrggbb`
   * hex; anything else is rejected.
   */
  async setRepoColor(
    id: string,
    color: string | null,
  ): Promise<{ oldColor?: string; newColor?: string }> {
    let nextColor: string | undefined;
    if (color !== null) {
      const trimmed = color.trim().toLowerCase();
      if (!/^#[0-9a-f]{6}$/.test(trimmed)) {
        throw new Error("color must be #rrggbb hex or null");
      }
      nextColor = trimmed;
    }
    const repos = await this.listRepos();
    const idx = repos.findIndex((r) => r.id === id);
    if (idx < 0) throw new Error(`Repo not found: ${id}`);
    const oldColor = repos[idx]!.color;
    if (oldColor === nextColor) return { oldColor, newColor: nextColor };
    const next: Repo = { ...repos[idx]! };
    if (nextColor === undefined) delete next.color;
    else next.color = nextColor;
    repos[idx] = next;
    await this.writeRepos(repos);
    return { oldColor, newColor: nextColor };
  }

  /**
   * Rename a registered repo. Returns the previous name so the caller can
   * record an inverse for undo.
   */
  async renameRepo(
    id: string,
    newName: string,
  ): Promise<{ oldName: string; newName: string }> {
    const trimmed = newName.trim();
    if (trimmed.length === 0) {
      throw new Error("name must not be empty");
    }
    const repos = await this.listRepos();
    const idx = repos.findIndex((r) => r.id === id);
    if (idx < 0) throw new Error(`Repo not found: ${id}`);
    const oldName = repos[idx]!.name;
    if (oldName === trimmed) return { oldName, newName: trimmed };
    repos[idx] = { ...repos[idx]!, name: trimmed };
    await this.writeRepos(repos);
    return { oldName, newName: trimmed };
  }

  /**
   * Append a user-defined "open in" link to a repo. Returns the newly
   * minted entry (with its generated id) so the caller can echo it
   * back to the client.
   *
   * Input shape is a discriminated union: pass `{ url: "https://…" }`
   * for a web link or `{ path: "/abs/path" }` for a file link. URLs
   * are validated as http(s); file paths must be absolute.
   */
  async addCustomLink(
    id: string,
    input:
      | { url: string; name?: string }
      | { kind: "url"; url: string; name?: string }
      | { kind: "file"; path: string; name?: string },
  ): Promise<CustomLink> {
    const repos = await this.listRepos();
    const idx = repos.findIndex((r) => r.id === id);
    if (idx < 0) throw new Error(`Repo not found: ${id}`);
    const link = buildCustomLink(randomUUID(), input);
    const next: Repo = { ...repos[idx]! };
    next.customLinks = [...(next.customLinks ?? []), link];
    repos[idx] = next;
    await this.writeRepos(repos);
    return link;
  }

  /**
   * Update a previously-added custom link in place. Pass `url` to
   * change a URL link's target (also implicitly converts a file link
   * to a URL one), `path` to set a file path, `name` to set or clear
   * (`""`) the label. Returns the updated link, or `null` if no link
   * with that id exists on the repo. Throws if the repo itself is
   * unknown or the new value fails validation.
   */
  async updateCustomLink(
    id: string,
    linkId: string,
    input: { url?: string; path?: string; name?: string },
  ): Promise<CustomLink | null> {
    const repos = await this.listRepos();
    const idx = repos.findIndex((r) => r.id === id);
    if (idx < 0) throw new Error(`Repo not found: ${id}`);
    const links = repos[idx]!.customLinks ?? [];
    const linkIdx = links.findIndex((l) => l.id === linkId);
    if (linkIdx < 0) return null;
    const current = links[linkIdx]!;

    // Start from the current link, then apply only the fields the
    // caller passed. If they pass `url` we flip to kind=url; if they
    // pass `path` we flip to kind=file. Passing both is rejected as
    // ambiguous.
    if (input.url !== undefined && input.path !== undefined) {
      throw new Error("pass either url or path, not both");
    }

    const currentKind = customLinkKind(current);
    const currentName = current.name;

    let merged:
      | { url: string; name?: string }
      | { kind: "url"; url: string; name?: string }
      | { kind: "file"; path: string; name?: string };
    if (input.url !== undefined) {
      merged = { kind: "url", url: input.url };
    } else if (input.path !== undefined) {
      merged = { kind: "file", path: input.path };
    } else if (currentKind === "file") {
      merged = {
        kind: "file",
        path: (current as { path: string }).path,
      };
    } else {
      merged = {
        kind: "url",
        url: (current as { url: string }).url,
      };
    }

    // Name: explicit blank clears, explicit value sets, undefined
    // preserves whatever was there before.
    if (input.name !== undefined) {
      const trimmedName = input.name.trim();
      if (trimmedName.length > 0) merged.name = trimmedName;
    } else if (currentName !== undefined) {
      merged.name = currentName;
    }

    const next = buildCustomLink(current.id, merged);
    const newLinks = [...links];
    newLinks[linkIdx] = next;
    const repo: Repo = { ...repos[idx]!, customLinks: newLinks };
    repos[idx] = repo;
    await this.writeRepos(repos);
    return next;
  }

  /**
   * Reorder the repo's custom links to match the provided id list.
   * `orderedIds` must be a permutation of the repo's existing link
   * ids — same length, same set, just rearranged. Returns the
   * previous order (id list) so the caller can record an inverse for
   * undo. Throws if the repo is unknown or the ids don't match.
   */
  async reorderCustomLinks(
    id: string,
    orderedIds: string[],
  ): Promise<{ oldOrder: string[]; newOrder: string[] }> {
    if (!Array.isArray(orderedIds)) {
      throw new Error("orderedIds must be an array of link ids");
    }
    const repos = await this.listRepos();
    const idx = repos.findIndex((r) => r.id === id);
    if (idx < 0) throw new Error(`Repo not found: ${id}`);
    const links = repos[idx]!.customLinks ?? [];
    const oldOrder = links.map((l) => l.id);
    if (orderedIds.length !== oldOrder.length) {
      throw new Error("orderedIds length must match existing links");
    }
    const seen = new Set<string>();
    for (const lid of orderedIds) {
      if (typeof lid !== "string" || lid.length === 0) {
        throw new Error("orderedIds must contain non-empty strings");
      }
      if (seen.has(lid)) {
        throw new Error("orderedIds must be unique");
      }
      seen.add(lid);
    }
    const byId = new Map(links.map((l) => [l.id, l]));
    const reordered: CustomLink[] = [];
    for (const lid of orderedIds) {
      const link = byId.get(lid);
      if (!link) throw new Error(`Unknown link id: ${lid}`);
      reordered.push(link);
    }
    if (oldOrder.every((lid, i) => lid === orderedIds[i])) {
      return { oldOrder, newOrder: [...orderedIds] };
    }
    const next: Repo = { ...repos[idx]!, customLinks: reordered };
    repos[idx] = next;
    await this.writeRepos(repos);
    return { oldOrder, newOrder: [...orderedIds] };
  }

  /**
   * Remove a custom link by its id. Returns the removed entry so the
   * caller can record an inverse, or `null` if no such link exists on
   * the repo. Throws if the repo itself is unknown.
   */
  async removeCustomLink(
    id: string,
    linkId: string,
  ): Promise<CustomLink | null> {
    const repos = await this.listRepos();
    const idx = repos.findIndex((r) => r.id === id);
    if (idx < 0) throw new Error(`Repo not found: ${id}`);
    const links = repos[idx]!.customLinks ?? [];
    const linkIdx = links.findIndex((l) => l.id === linkId);
    if (linkIdx < 0) return null;
    const removed = links[linkIdx]!;
    const next: Repo = { ...repos[idx]! };
    const remaining = links.filter((_, i) => i !== linkIdx);
    if (remaining.length === 0) delete next.customLinks;
    else next.customLinks = remaining;
    repos[idx] = next;
    await this.writeRepos(repos);
    return removed;
  }

  private async writeRepos(repos: Repo[]): Promise<void> {
    const payload: ReposFile = { repos };
    await writeFile(
      join(this.path, REPOS_FILE),
      JSON.stringify(payload, null, 2),
    );
  }
}
