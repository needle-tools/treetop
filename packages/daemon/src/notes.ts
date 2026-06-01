import { join } from "node:path";
import {
  mkdir,
  readFile,
  writeFile,
  readdir,
  unlink,
  access,
} from "node:fs/promises";
import { randomUUID } from "node:crypto";

/** Discriminator for the two attachment kinds the same on-disk format
 *  carries today. "note" is a free-form markdown sticky; "link" is a
 *  compact chip whose payload is the `target` field below. They share
 *  the lifecycle (anchors, undo, SSE) and the storage path —
 *  `<workspace>/notes/<id>.md` — so the layer code in the UI can route
 *  on `kind` rather than having two parallel stores. */
export type AttachmentKind = "note" | "link" | "emoji";

/** Target a link points at. Five well-known shapes today; the schema
 *  stays open so future kinds (PR, issue, slack thread) can drop in
 *  without a migration. `value` is the raw payload — the UI is
 *  responsible for resolving it (window.open for url, fork/gh URL
 *  build for commit, etc.). */
export interface LinkTarget {
  type: "url" | "commit" | "session" | "file" | "command";
  value: string;
  /** Display snapshot captured at pick-time so the chip can render
   *  instantly without re-hitting /api/agents or /api/commits. */
  label?: string;
  /** Secondary line. For commits this is the author; for sessions
   *  it's now the message count ("42 msg"). Agent / provider live
   *  in their own fields below so the icon resolver doesn't have
   *  to parse strings. */
  subtitle?: string;
  /** Tertiary line — relative age ("2d") for both types. */
  meta?: string;
  /** Session agent ("claude", "codex", ...) — drives the per-agent
   *  brand mark on the chip. Empty / absent → fallback dot. */
  agent?: string;
  /** Git remote provider ("github", "gitlab", "bitbucket", ...) —
   *  drives the per-provider brand mark on commit chips. Resolved
   *  from the repo's origin remote at pick time. */
  provider?: string;
  /** Command links point at a repo custom-link id. These snapshot
   *  fields let the UI render and re-run the command without resolving
   *  a separate command-specific storage model. */
  repoId?: string;
  cwd?: string;
  command?: string;
  runMode?: "internal" | "external" | "shell";
}

export interface Note {
  /** Filename-safe id (lowercase letters, digits, dashes). Also the
   *  basename on disk: `<id>.md`. */
  id: string;
  /** Anchors are opaque strings with a type prefix:
   *    repo:<reponame>/<relpath>[:<line>]   file or folder
   *    commit:<sha>
   *    worktree:<absolute-path>
   *    session:<source>
   *  Match by `startsWith(prefix)`. */
  anchors: string[];
  tags: string[];
  /** ISO-8601 UTC. */
  createdAt: string;
  /** ISO-8601 UTC. Equal to createdAt on a freshly-created note. */
  updatedAt: string;
  /** Everything after the frontmatter block, with the leading newline
   *  stripped and trailing whitespace trimmed. Standard markdown for
   *  kind="note"; for kind="link" this holds the optional display
   *  label and is usually empty. */
  body: string;
  /** Attachment discriminator. Absent on every pre-existing note file;
   *  callers should treat `undefined` as `"note"` so legacy files
   *  continue to render as paper stickies without a migration step. */
  kind?: AttachmentKind;
  /** Only meaningful when `kind === "link"`. The frontmatter stores
   *  this as two flat keys (`targetType` + `targetValue`) so the
   *  hand-rolled YAML parser doesn't need nested-object support. */
  target?: LinkTarget;
  /** When true, the UI hides the note body until the reader briefly
   *  hovers the note's secret toggle (or opens it in edit mode). Only
   *  meaningful for `kind === "note"`. Stored as a single `secret: true`
   *  frontmatter scalar; absent (the common case) means not secret. */
  secret?: boolean;
}

const NOTES_DIR = "notes";
// Mirrors a valid filename slug. Lowercase keeps file lookups predictable
// on case-sensitive filesystems and avoids two notes only differing by case.
const ID_RE = /^[a-z0-9][a-z0-9-]*$/;

function isValidId(id: string): boolean {
  return typeof id === "string" && id.length > 0 && ID_RE.test(id);
}

/** Parse a note file's full text into a Note. Throws if frontmatter or
 *  `id` is missing. Unknown frontmatter keys are ignored — forward-compat
 *  with notes written by a newer version of supergit (or by hand). */
export function parseNoteFile(raw: string): Note {
  const lines = raw.replace(/\r\n/g, "\n").split("\n");
  if (lines[0] !== "---") {
    throw new Error("note file is missing YAML frontmatter");
  }
  let end = -1;
  for (let i = 1; i < lines.length; i++) {
    if (lines[i] === "---") {
      end = i;
      break;
    }
  }
  if (end === -1) {
    throw new Error("note file frontmatter is unterminated");
  }
  const fmLines = lines.slice(1, end);
  const fm = parseFrontmatter(fmLines);
  const id = fm.scalars.get("id");
  if (!id) throw new Error("note file frontmatter is missing `id`");
  const createdAt = fm.scalars.get("createdAt") ?? "";
  const updatedAt = fm.scalars.get("updatedAt") ?? createdAt;
  const anchors = fm.lists.get("anchors") ?? [];
  const tags = fm.lists.get("tags") ?? [];
  const body = lines
    .slice(end + 1)
    .join("\n")
    .replace(/\s+$/g, "");
  const note: Note = { id, anchors, tags, createdAt, updatedAt, body };
  // Optional kind discriminator. Anything other than the known values
  // is dropped silently — forward-compat with future kinds, and
  // defensive against hand-edits that fat-finger the field.
  const rawKind = fm.scalars.get("kind");
  if (rawKind === "note" || rawKind === "link" || rawKind === "emoji")
    note.kind = rawKind;
  // Secret flag. Only `true` flips it on; anything else (absent, "false",
  // a fat-fingered value) leaves the note visible.
  if (fm.scalars.get("secret") === "true") note.secret = true;
  // Flat target fields. Both must be present and the type recognized;
  // otherwise we treat the file as if no target was set so the UI
  // falls back to plain-note rendering rather than a half-broken chip.
  const tType = fm.scalars.get("targetType");
  const tValue = fm.scalars.get("targetValue");
  if (
    tValue !== undefined &&
    (tType === "url" ||
      tType === "commit" ||
      tType === "session" ||
      tType === "file" ||
      tType === "command")
  ) {
    const target: LinkTarget = { type: tType, value: tValue };
    // Display-snapshot fields are optional — older link files (and
    // hand-edited ones) omit them, and the renderer falls back to
    // value-derived display in that case.
    const tLabel = fm.scalars.get("targetLabel");
    const tSubtitle = fm.scalars.get("targetSubtitle");
    const tMeta = fm.scalars.get("targetMeta");
    const tAgent = fm.scalars.get("targetAgent");
    const tProvider = fm.scalars.get("targetProvider");
    const tRepoId = fm.scalars.get("targetRepoId");
    const tCwd = fm.scalars.get("targetCwd");
    const tCommand = fm.scalars.get("targetCommand");
    const tRunMode = fm.scalars.get("targetRunMode");
    if (tLabel !== undefined) target.label = tLabel;
    if (tSubtitle !== undefined) target.subtitle = tSubtitle;
    if (tMeta !== undefined) target.meta = tMeta;
    if (tAgent !== undefined) target.agent = tAgent;
    if (tProvider !== undefined) target.provider = tProvider;
    if (tRepoId !== undefined) target.repoId = tRepoId;
    if (tCwd !== undefined) target.cwd = tCwd;
    if (tCommand !== undefined) target.command = tCommand;
    if (
      tRunMode === "internal" ||
      tRunMode === "external" ||
      tRunMode === "shell"
    ) {
      target.runMode = tRunMode;
    }
    note.target = target;
  }
  return note;
}

interface ParsedFrontmatter {
  scalars: Map<string, string>;
  lists: Map<string, string[]>;
}

function parseFrontmatter(lines: string[]): ParsedFrontmatter {
  const scalars = new Map<string, string>();
  const lists = new Map<string, string[]>();
  let i = 0;
  while (i < lines.length) {
    const line = lines[i]!;
    if (line.trim().length === 0) {
      i++;
      continue;
    }
    const colon = line.indexOf(":");
    if (colon === -1 || /^\s/.test(line)) {
      // Stray indented line at top level — skip.
      i++;
      continue;
    }
    const key = line.slice(0, colon).trim();
    const value = line.slice(colon + 1).trim();
    if (value === "") {
      // Block list follows on subsequent `  - ` lines.
      const items: string[] = [];
      i++;
      while (i < lines.length && /^\s+-\s/.test(lines[i]!)) {
        items.push(lines[i]!.replace(/^\s+-\s+/, "").trim());
        i++;
      }
      lists.set(key, items);
      continue;
    }
    if (value.startsWith("[") && value.endsWith("]")) {
      // Inline list: `tags: [a, b]`. Empty `[]` yields an empty array.
      const inner = value.slice(1, -1).trim();
      const items =
        inner.length === 0
          ? []
          : inner
              .split(",")
              .map((s) => s.trim())
              .filter((s) => s.length > 0);
      lists.set(key, items);
      i++;
      continue;
    }
    scalars.set(key, value);
    i++;
  }
  return { scalars, lists };
}

/** Serialize a Note to the on-disk representation. Frontmatter keys are
 *  emitted in a fixed order so diffs stay readable. */
export function serializeNoteFile(note: Note): string {
  const out: string[] = ["---"];
  out.push(`id: ${note.id}`);
  out.push(`createdAt: ${note.createdAt}`);
  out.push(`updatedAt: ${note.updatedAt}`);
  if (note.anchors.length === 0) {
    out.push("anchors: []");
  } else {
    out.push("anchors:");
    for (const a of note.anchors) out.push(`  - ${a}`);
  }
  if (note.tags.length === 0) {
    out.push("tags: []");
  } else {
    out.push("tags:");
    for (const t of note.tags) out.push(`  - ${t}`);
  }
  // Emit kind/target only when they differ from the implicit defaults
  // ("note", no target). Plain notes keep their original frontmatter
  // shape — no churn on existing files when this version touches them.
  if (note.kind !== undefined && note.kind !== "note") {
    out.push(`kind: ${note.kind}`);
  }
  // Only emit when set — plain notes keep their original frontmatter
  // shape so this version touching one doesn't churn the file.
  if (note.secret === true) {
    out.push("secret: true");
  }
  if (note.target !== undefined) {
    // Snapshot fields may contain arbitrary user text (session
    // titles, commit subjects). Collapse newlines so the flat-YAML
    // parser doesn't see a stray line and treat it as the next key.
    const safe = (s: string) => s.replace(/\r?\n/g, " ").trim();
    out.push(`targetType: ${note.target.type}`);
    out.push(`targetValue: ${safe(note.target.value)}`);
    if (note.target.label !== undefined) {
      out.push(`targetLabel: ${safe(note.target.label)}`);
    }
    if (note.target.subtitle !== undefined) {
      out.push(`targetSubtitle: ${safe(note.target.subtitle)}`);
    }
    if (note.target.meta !== undefined) {
      out.push(`targetMeta: ${safe(note.target.meta)}`);
    }
    if (note.target.agent !== undefined) {
      out.push(`targetAgent: ${safe(note.target.agent)}`);
    }
    if (note.target.provider !== undefined) {
      out.push(`targetProvider: ${safe(note.target.provider)}`);
    }
    if (note.target.repoId !== undefined) {
      out.push(`targetRepoId: ${safe(note.target.repoId)}`);
    }
    if (note.target.cwd !== undefined) {
      out.push(`targetCwd: ${safe(note.target.cwd)}`);
    }
    if (note.target.command !== undefined) {
      out.push(`targetCommand: ${safe(note.target.command)}`);
    }
    if (note.target.runMode !== undefined) {
      out.push(`targetRunMode: ${safe(note.target.runMode)}`);
    }
  }
  out.push("---");
  out.push(note.body);
  return out.join("\n");
}

export interface CreateInput {
  id?: string;
  body: string;
  anchors?: string[];
  tags?: string[];
  kind?: AttachmentKind;
  target?: LinkTarget;
  secret?: boolean;
}

export interface UpdateInput {
  body?: string;
  anchors?: string[];
  tags?: string[];
  /** Kind transitions (note ↔ link) are allowed deliberately — a user
   *  who staged a link but then decides to write prose can keep the
   *  same note id rather than create-and-discard. */
  kind?: AttachmentKind;
  /** Pass `null` to clear an existing target (e.g. demoting a link
   *  back to a note). `undefined` leaves the existing target intact. */
  target?: LinkTarget | null;
  /** Toggle the hide-until-hover secret flag. `undefined` leaves it
   *  alone; `false` clears it (we drop the property rather than store
   *  `secret: false`). */
  secret?: boolean;
}

export interface ListFilter {
  /** Keep only notes that have at least one anchor whose string starts
   *  with `anchorPrefix`. Mostly used to "find every note anchored
   *  inside this worktree/repo" with prefixes like `repo:foo/` or
   *  `worktree:/abs/path`. */
  anchorPrefix?: string;
}

export class NotesStore {
  private constructor(public readonly workspacePath: string) {}

  static async open(workspacePath: string): Promise<NotesStore> {
    return new NotesStore(workspacePath);
  }

  private dir(): string {
    return join(this.workspacePath, NOTES_DIR);
  }

  private filePath(id: string): string {
    return join(this.dir(), `${id}.md`);
  }

  private async ensureDir(): Promise<void> {
    await mkdir(this.dir(), { recursive: true });
  }

  private async exists(id: string): Promise<boolean> {
    try {
      await access(this.filePath(id));
      return true;
    } catch {
      return false;
    }
  }

  async list(filter: ListFilter = {}): Promise<Note[]> {
    let entries: string[];
    try {
      entries = await readdir(this.dir());
    } catch {
      return [];
    }
    const notes: Note[] = [];
    for (const name of entries) {
      if (!name.endsWith(".md")) continue;
      const raw = await readFile(join(this.dir(), name), "utf-8").catch(
        () => null,
      );
      if (raw === null) continue;
      let note: Note;
      try {
        note = parseNoteFile(raw);
      } catch {
        continue;
      }
      if (filter.anchorPrefix !== undefined) {
        const p = filter.anchorPrefix;
        if (!note.anchors.some((a) => a.startsWith(p))) continue;
      }
      notes.push(note);
    }
    notes.sort((a, b) => b.createdAt.localeCompare(a.createdAt));
    return notes;
  }

  async get(id: string): Promise<Note | null> {
    if (!isValidId(id)) return null;
    let raw: string;
    try {
      raw = await readFile(this.filePath(id), "utf-8");
    } catch {
      return null;
    }
    try {
      return parseNoteFile(raw);
    } catch {
      return null;
    }
  }

  async create(input: CreateInput): Promise<Note> {
    if (typeof input.body !== "string") {
      throw new Error("body must be a string");
    }
    let id: string;
    if (input.id !== undefined) {
      if (!isValidId(input.id)) {
        throw new Error(
          "id must match [a-z0-9][a-z0-9-]* (lowercase, dashes only)",
        );
      }
      id = input.id;
    } else {
      id = generateId();
    }
    await this.ensureDir();
    if (await this.exists(id)) {
      throw new Error(`note already exists with id: ${id}`);
    }
    const now = new Date().toISOString();
    const note: Note = {
      id,
      anchors: normalizeStringArray(input.anchors),
      tags: normalizeStringArray(input.tags),
      createdAt: now,
      updatedAt: now,
      body: input.body,
      ...(input.kind !== undefined ? { kind: input.kind } : {}),
      ...(input.target !== undefined ? { target: input.target } : {}),
      ...(input.secret === true ? { secret: true } : {}),
    };
    await writeFile(this.filePath(id), serializeNoteFile(note));
    return note;
  }

  async update(id: string, input: UpdateInput): Promise<Note> {
    const existing = await this.get(id);
    if (!existing) throw new Error(`note not found: ${id}`);
    const hasAny =
      input.body !== undefined ||
      input.anchors !== undefined ||
      input.tags !== undefined ||
      input.kind !== undefined ||
      input.target !== undefined ||
      input.secret !== undefined;
    if (!hasAny) return existing;
    const next: Note = {
      ...existing,
      body: input.body ?? existing.body,
      anchors:
        input.anchors !== undefined
          ? normalizeStringArray(input.anchors)
          : existing.anchors,
      tags:
        input.tags !== undefined
          ? normalizeStringArray(input.tags)
          : existing.tags,
      updatedAt: new Date().toISOString(),
    };
    if (input.kind !== undefined) next.kind = input.kind;
    // Tri-state: undefined = leave alone, null = clear, value = set.
    // Translating null → "remove the property" keeps serializeNoteFile
    // simple (it only emits the keys when target is defined).
    if (input.target === null) {
      delete next.target;
    } else if (input.target !== undefined) {
      next.target = input.target;
    }
    // `false` clears it (drop the property); `true` sets it.
    if (input.secret === false) {
      delete next.secret;
    } else if (input.secret === true) {
      next.secret = true;
    }
    await writeFile(this.filePath(id), serializeNoteFile(next));
    return next;
  }

  async remove(id: string): Promise<boolean> {
    if (!isValidId(id)) return false;
    try {
      await unlink(this.filePath(id));
      return true;
    } catch {
      return false;
    }
  }
}

function normalizeStringArray(input: unknown): string[] {
  if (!Array.isArray(input)) return [];
  const out: string[] = [];
  for (const item of input) {
    if (typeof item !== "string") continue;
    const trimmed = item.trim();
    if (trimmed.length === 0) continue;
    out.push(trimmed);
  }
  return out;
}

function generateId(): string {
  const now = new Date();
  const yyyy = String(now.getUTCFullYear());
  const mm = String(now.getUTCMonth() + 1).padStart(2, "0");
  const dd = String(now.getUTCDate()).padStart(2, "0");
  // 8 hex chars is plenty of entropy for a per-workspace notes dir.
  const suffix = randomUUID().replace(/-/g, "").slice(0, 8);
  return `${yyyy}-${mm}-${dd}-${suffix}`;
}
