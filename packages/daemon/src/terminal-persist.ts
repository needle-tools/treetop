import { readFile, writeFile, rename, unlink, mkdir } from "node:fs/promises";
import { join } from "node:path";

const FILE = "active-terminals.json";

export interface PersistedTerminal {
  termId: string;
  cmd: string[];
  cwd: string;
  wtPath: string;
  title?: string;
  /** Last command the user typed in this shell (for display + prefill on restore). */
  lastCmd?: string;
}

interface PersistFile {
  terminals: PersistedTerminal[];
}

export class TerminalPersist {
  private dir: string;
  private writeLock: Promise<void> = Promise.resolve();

  constructor(workspacePath: string) {
    this.dir = workspacePath;
  }

  async list(): Promise<PersistedTerminal[]> {
    try {
      const raw = await readFile(join(this.dir, FILE), "utf-8");
      const parsed = JSON.parse(raw) as PersistFile;
      return parsed.terminals ?? [];
    } catch {
      return [];
    }
  }

  async save(entry: PersistedTerminal): Promise<void> {
    await this.withLock(async () => {
      const existing = await this.list();
      const filtered = existing.filter((t) => t.termId !== entry.termId);
      filtered.push(entry);
      await this.write({ terminals: filtered });
    });
  }

  async remove(termId: string): Promise<void> {
    await this.withLock(async () => {
      const existing = await this.list();
      const filtered = existing.filter((t) => t.termId !== termId);
      if (filtered.length === existing.length) return;
      await this.write({ terminals: filtered });
    });
  }

  async updateLastCmd(termId: string, lastCmd: string): Promise<void> {
    await this.withLock(async () => {
      const existing = await this.list();
      const entry = existing.find((t) => t.termId === termId);
      if (!entry) return;
      entry.lastCmd = lastCmd;
      await this.write({ terminals: existing });
    });
  }

  async clear(): Promise<void> {
    await this.withLock(async () => {
      await this.write({ terminals: [] });
    });
  }

  private async write(data: PersistFile): Promise<void> {
    await mkdir(this.dir, { recursive: true });
    const dst = join(this.dir, FILE);
    const tmp = `${dst}.tmp`;
    await writeFile(tmp, JSON.stringify(data, null, 2));
    try {
      await rename(tmp, dst);
    } catch (err) {
      await unlink(tmp).catch(() => {});
      throw err;
    }
  }

  private async withLock(fn: () => Promise<void>): Promise<void> {
    const prev = this.writeLock;
    this.writeLock = prev.then(fn, fn);
    await this.writeLock;
  }
}
