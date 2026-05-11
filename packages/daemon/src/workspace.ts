import { join } from "node:path";
import { mkdir, readFile, writeFile, access } from "node:fs/promises";
import { randomUUID } from "node:crypto";

export interface Repo {
  id: string;
  path: string;
  name: string;
  addedAt: string;
}

interface ReposFile {
  repos: Repo[];
}

const REPOS_FILE = "repos.json";

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

  private async writeRepos(repos: Repo[]): Promise<void> {
    const payload: ReposFile = { repos };
    await writeFile(
      join(this.path, REPOS_FILE),
      JSON.stringify(payload, null, 2),
    );
  }
}
