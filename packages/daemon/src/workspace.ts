import { join } from "node:path";
import { mkdir, readFile, writeFile, access } from "node:fs/promises";
import { randomUUID } from "node:crypto";

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

  private async writeRepos(repos: Repo[]): Promise<void> {
    const payload: ReposFile = { repos };
    await writeFile(
      join(this.path, REPOS_FILE),
      JSON.stringify(payload, null, 2),
    );
  }
}
