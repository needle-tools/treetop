import uFuzzy from "@leeoniya/ufuzzy";
import {
  sessionDisplayTitle,
  type AgentSession as SessionSearchAgent,
} from "./sessionSearch";

export type SearchKind =
  | "action"
  | "project"
  | "session"
  | "snippet"
  | "note"
  | "readme"
  | "proc"
  | "event";

export interface SearchItem {
  id: string;
  kind: SearchKind;
  title: string;
  subtitle?: string;
  meta?: string;
  text?: string;
  keywords?: string[];
  timestamp?: string;
  path?: string;
  color?: string;
  agent?: string;
  data?: unknown;
}

export interface SearchResult {
  item: SearchItem;
  score: number;
}

export interface SearchOptions {
  kinds?: Set<SearchKind>;
  now?: number;
  limit?: number;
}

export function nextSearchKindsSelection(
  activeKinds: SearchKind[] | null,
  kind: SearchKind,
): SearchKind[] | null {
  const next = new Set(activeKinds ?? []);
  if (next.has(kind)) next.delete(kind);
  else next.add(kind);
  return next.size > 0 ? [...next] : null;
}

type AgeMode = "today" | "yesterday" | "last-week";

export interface ParsedAgeQuery {
  text: string;
  range: { start: number; end: number } | null;
  mode: AgeMode | null;
}

const fuzzy = new uFuzzy({
  intraMode: 1,
  intraIns: 1,
  intraSub: 1,
  intraTrn: 1,
});

const DAY_MS = 24 * 60 * 60 * 1000;

function startOfLocalDay(ms: number): number {
  const d = new Date(ms);
  d.setHours(0, 0, 0, 0);
  return d.getTime();
}

function parseTimestamp(iso: string | undefined): number | null {
  if (!iso) return null;
  const ms = Date.parse(iso);
  return Number.isFinite(ms) ? ms : null;
}

function ageRange(mode: AgeMode, now: number): { start: number; end: number } {
  const todayStart = startOfLocalDay(now);
  if (mode === "today") return { start: todayStart, end: todayStart + DAY_MS };
  if (mode === "yesterday") {
    return { start: todayStart - DAY_MS, end: todayStart };
  }
  return { start: now - 7 * DAY_MS, end: now + 1 };
}

export function parseAgeQuery(
  query: string,
  now: number = Date.now(),
): ParsedAgeQuery {
  let text = query.trim();
  let mode: AgeMode | null = null;

  const replacements: Array<[RegExp, AgeMode]> = [
    [/\b(last\s+week|letzte\s+woche)\b/i, "last-week"],
    [/\b(yesterday|gestern)\b/i, "yesterday"],
    [/\b(today|heute)\b/i, "today"],
  ];

  for (const [pattern, found] of replacements) {
    if (!pattern.test(text)) continue;
    mode = found;
    text = text.replace(pattern, " ");
    break;
  }

  text = text.replace(/\s+/g, " ").trim();
  return { text, mode, range: mode ? ageRange(mode, now) : null };
}

function inAgeRange(
  item: SearchItem,
  range: { start: number; end: number },
): boolean {
  const t = parseTimestamp(item.timestamp);
  return t !== null && t >= range.start && t < range.end;
}

function searchText(item: SearchItem): string {
  return [
    item.title,
    item.subtitle,
    item.meta,
    item.text,
    item.path,
    ...(item.keywords ?? []),
  ]
    .filter((v): v is string => typeof v === "string" && v.trim().length > 0)
    .join(" ");
}

function fieldBonus(item: SearchItem, needle: string): number {
  const q = needle.toLowerCase();
  if (!q) return 1;
  let score = 0;
  const title = item.title.toLowerCase();
  if (title === q) score += 900;
  if (title.startsWith(q)) score += 520;
  if (new RegExp(`(^|[\\s_./-])${escapeRegExp(q)}`).test(title)) score += 260;
  if (title.includes(q)) score += 180;
  if ((item.subtitle ?? "").toLowerCase().includes(q)) score += 60;
  if ((item.meta ?? "").toLowerCase().includes(q)) score += 35;
  if ((item.path ?? "").toLowerCase().includes(q)) score += 25;
  if ((item.text ?? "").toLowerCase().includes(q)) score += 20;
  for (const keyword of item.keywords ?? []) {
    if (keyword.toLowerCase().includes(q)) score += 20;
  }
  return score;
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

export function searchItems(
  items: SearchItem[],
  rawQuery: string,
  options: SearchOptions = {},
): SearchResult[] {
  const parsed = parseAgeQuery(rawQuery, options.now ?? Date.now());
  const pool = items.filter((item) => {
    if (options.kinds && !options.kinds.has(item.kind)) return false;
    if (parsed.range && !inAgeRange(item, parsed.range)) return false;
    return true;
  });
  const q = parsed.text;
  if (!q) {
    return pool
      .map((item) => ({ item, score: parseTimestamp(item.timestamp) ?? 0 }))
      .sort((a, b) => b.score - a.score)
      .slice(0, options.limit ?? pool.length);
  }

  const haystack = pool.map(searchText);
  const [idxs, info, order] = fuzzy.search(haystack, q, 5);
  if (!idxs) return [];
  const ordered = info && order ? order.map((i) => idxs[i]) : idxs;
  const results = ordered.map((idx, rank) => {
    const item = pool[idx];
    const activity = parseTimestamp(item.timestamp) ?? 0;
    return {
      item,
      score: fieldBonus(item, q) + (ordered.length - rank) + activity / 1e14,
    };
  });
  results.sort((a, b) => b.score - a.score);
  return results.slice(0, options.limit ?? results.length);
}

function basename(path: string): string {
  const clean = path.replace(/[\\/]+$/, "");
  return clean.split(/[\\/]/).pop() || clean;
}

interface WorktreeLike {
  path: string;
  branch?: string;
}

interface RepoLike {
  id: string;
  path: string;
  name: string;
  color?: string;
  addedAt?: string;
  worktrees?: WorktreeLike[];
}

export type ProjectSearchAction = "add-folder" | "open-from-sessions";

export function buildProjectActionSearchItems(): SearchItem[] {
  return [
    {
      id: "action:add-folder",
      kind: "action",
      title: "Add folder",
      subtitle: "Add a project folder",
      meta: "Projects",
      keywords: [
        "add project",
        "new project",
        "load folder",
        "load project",
        "add repository",
        "new repository",
      ],
      data: { action: "add-folder" satisfies ProjectSearchAction },
    },
    {
      id: "action:open-from-sessions",
      kind: "action",
      title: "Open from sessions",
      subtitle: "Suggest project folders from detected agent sessions",
      meta: "Projects",
      keywords: [
        "import sessions",
        "folders from sessions",
        "open folder from session",
        "load project from sessions",
      ],
      data: { action: "open-from-sessions" satisfies ProjectSearchAction },
    },
  ];
}

export function buildProjectSearchItems(repos: RepoLike[]): SearchItem[] {
  const out: SearchItem[] = [];
  for (const repo of repos) {
    const worktreeTerms = (repo.worktrees ?? []).flatMap((wt) => [
      wt.path,
      wt.branch ?? "",
      basename(wt.path),
    ]);
    out.push({
      id: `project:${repo.id}`,
      kind: "project",
      title: repo.name,
      subtitle: repo.path,
      meta: basename(repo.path),
      path: repo.path,
      color: repo.color,
      timestamp: repo.addedAt,
      keywords: [basename(repo.path), ...worktreeTerms],
      data: repo,
    });
  }
  return out;
}

export function buildSessionSearchItems(
  sessions: SessionSearchAgent[],
  repos: RepoLike[] = [],
): SearchItem[] {
  const out: SearchItem[] = [];
  for (const s of sessions) {
    const title = sessionDisplayTitle(s);
    const folder = basename(s.cwd);
    const project = repos.find(
      (repo) =>
        s.cwd === repo.path ||
        s.cwd.startsWith(`${repo.path}/`) ||
        (repo.worktrees ?? []).some(
          (wt) => s.cwd === wt.path || s.cwd.startsWith(`${wt.path}/`),
        ),
    );
    const projectName = project?.name;
    const subtitle = projectName
      ? `${projectName} · ${folder} · ${s.agent}`
      : `${folder} · ${s.agent}`;
    out.push({
      id: `session:${s.source}`,
      kind: "session",
      title,
      subtitle,
      meta: s.messageCount ? `${s.messageCount} messages` : undefined,
      path: s.source,
      timestamp: s.lastMessageTs ?? s.lastActive,
      agent: s.agent,
      color: project?.color,
      keywords: [s.sessionId ?? "", s.cwd, folder, s.model ?? ""],
      data: s,
    });
    const snippets = [s.lastUserMessage, ...(s.lastUserMessages ?? [])]
      .map((message) => (message ?? "").trim())
      .filter((message) => message.length >= 3);
    if (snippets.length > 0) {
      out.push({
        id: `snippet:${s.source}`,
        kind: "snippet",
        title: snippets[0] ?? title,
        subtitle: projectName ? `${title} · ${projectName}` : title,
        meta: s.agent,
        text: snippets.join(" "),
        path: s.source,
        timestamp: s.lastMessageTs ?? s.lastActive,
        agent: s.agent,
        color: project?.color,
        keywords: [s.cwd, folder],
        data: s,
      });
    }
  }
  return out;
}

export interface NoteSearchLike {
  id: string;
  body: string;
  updatedAt: string;
  anchors?: string[];
}

export function buildNoteSearchItems(notes: NoteSearchLike[]): SearchItem[] {
  return notes.map((note) => ({
    id: `note:${note.id}`,
    kind: "note",
    title: note.body.trim().split(/\n/, 1)[0] || "Note",
    subtitle: note.anchors?.join(" · "),
    text: note.body,
    timestamp: note.updatedAt,
    keywords: note.anchors ?? [],
    data: note,
  }));
}

export interface ReadmeSearchLike {
  id: string;
  repoId: string;
  repoName: string;
  path: string;
  text: string;
  updatedAt?: string;
}

export function buildReadmeSearchItems(
  readmes: ReadmeSearchLike[],
): SearchItem[] {
  return readmes.map((readme) => ({
    id: `readme:${readme.id}`,
    kind: "readme",
    title: `${readme.repoName} README`,
    subtitle: readme.path,
    path: readme.path,
    text: readme.text,
    timestamp: readme.updatedAt,
    keywords: [readme.repoName, basename(readme.path)],
    data: readme,
  }));
}
