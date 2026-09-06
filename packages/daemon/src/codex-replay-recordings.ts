import {
  readdir,
  readFile,
  stat,
} from "node:fs/promises";
import { homedir } from "node:os";
import {
  basename,
  dirname,
  join,
  relative,
  resolve,
  sep,
} from "node:path";

export interface CodexReplayTranscriptRef {
  threadId: string;
  path: string;
  name: string;
  mtimeMs: number;
  size: number;
}

export interface CodexReplayRecordingRef {
  path: string;
  name: string;
  mtimeMs: number;
  size: number;
  threadIds: string[];
  transcriptPaths: CodexReplayTranscriptRef[];
}

export interface CodexReplayRecordingPayload {
  recording: CodexReplayRecordingRef;
  text: string;
  transcripts: Array<CodexReplayTranscriptRef & { text: string }>;
}

export interface CodexReplayRecordingOptions {
  recordingDir: string;
  sessionsRoot?: string;
}

export interface CodexReplayRecordingReadOptions extends CodexReplayRecordingOptions {
  path: string;
  transcriptPath?: string;
}

interface RecordingDraft {
  path: string;
  name: string;
  mtimeMs: number;
  size: number;
  text: string;
  threadIds: string[];
  directTranscriptPaths: string[];
}

export async function listCodexReplayRecordings(
  options: CodexReplayRecordingOptions,
): Promise<CodexReplayRecordingRef[]> {
  const recordingDir = resolve(options.recordingDir);
  const sessionsRoot = options.sessionsRoot ?? join(homedir(), ".codex", "sessions");
  const files = await listRecordingFiles(recordingDir);
  const drafts = (
    await Promise.all(files.map((path) => recordingDraftFromPath(path)))
  ).filter((entry): entry is RecordingDraft => !!entry);
  const transcriptIndex = await buildTranscriptIndex(sessionsRoot, drafts);
  return drafts
    .map((draft) => recordingRefFromDraft(draft, transcriptIndex))
    .sort((a, b) => b.mtimeMs - a.mtimeMs);
}

export async function readCodexReplayRecording(
  options: CodexReplayRecordingReadOptions,
): Promise<CodexReplayRecordingPayload> {
  const recordingDir = resolve(options.recordingDir);
  const path = resolve(options.path);
  assertInside(path, recordingDir);
  const text = await readFile(path, "utf8");
  const stats = await stat(path);
  const threadIds = extractCodexReplayThreadIds(text);
  const sessionsRoot = options.sessionsRoot ?? join(homedir(), ".codex", "sessions");
  const draft: RecordingDraft = {
    path,
    name: basename(path),
    mtimeMs: stats.mtimeMs,
    size: stats.size,
    text,
    threadIds,
    directTranscriptPaths: transcriptPathsFromReplay(text),
  };
  const transcriptIndex = await buildTranscriptIndex(sessionsRoot, [draft]);
  const transcriptPaths = recordingRefFromDraft(draft, transcriptIndex).transcriptPaths;
  const selectedTranscriptPath = options.transcriptPath
    ? resolve(options.transcriptPath)
    : undefined;
  const selectedTranscript = selectedTranscriptPath
    ? transcriptPaths.find((ref) => resolve(ref.path) === selectedTranscriptPath)
    : undefined;
  if (selectedTranscriptPath && !selectedTranscript) {
    throw new Error("transcript path does not belong to recording");
  }
  const transcripts = selectedTranscript
    ? [{ ...selectedTranscript, text: await readFile(selectedTranscript.path, "utf8") }]
    : [];
  return {
    recording: {
      path,
      name: basename(path),
      mtimeMs: stats.mtimeMs,
      size: stats.size,
      threadIds,
      transcriptPaths,
    },
    text,
    transcripts,
  };
}

export function extractCodexReplayThreadIds(text: string): string[] {
  const ids = new Set<string>();
  const add = (value: unknown) => {
    if (isThreadLikeId(value)) {
      ids.add(value);
    }
  };
  for (const line of text.split(/\r?\n/)) {
    if (!line.trim()) continue;
    try {
      collectThreadIds(JSON.parse(line), add);
    } catch {
      // Ignore malformed lines; the replay parser will report them when opened.
    }
  }
  return [...ids];
}

async function recordingDraftFromPath(path: string): Promise<RecordingDraft | null> {
  try {
    const [stats, text] = await Promise.all([stat(path), readFile(path, "utf8")]);
    const threadIds = extractCodexReplayThreadIds(text);
    return {
      path,
      name: basename(path),
      mtimeMs: stats.mtimeMs,
      size: stats.size,
      threadIds,
      text,
      directTranscriptPaths: transcriptPathsFromReplay(text),
    };
  } catch {
    return null;
  }
}

function recordingRefFromDraft(
  draft: RecordingDraft,
  transcriptIndex: Map<string, CodexReplayTranscriptRef>,
): CodexReplayRecordingRef {
  const ids = recordingThreadIds(draft);
  return {
    path: draft.path,
    name: draft.name,
    mtimeMs: draft.mtimeMs,
    size: draft.size,
    threadIds: draft.threadIds,
    transcriptPaths: ids
      .map((id) => transcriptIndex.get(id))
      .filter((ref): ref is CodexReplayTranscriptRef => !!ref),
  };
}

async function listRecordingFiles(recordingDir: string): Promise<string[]> {
  try {
    const entries = await readdir(recordingDir, { withFileTypes: true });
    return entries
      .filter((entry) => entry.isFile() && /\.(jsonl|json)$/i.test(entry.name))
      .map((entry) => join(recordingDir, entry.name));
  } catch {
    return [];
  }
}

async function buildTranscriptIndex(
  sessionsRoot: string,
  drafts: RecordingDraft[],
): Promise<Map<string, CodexReplayTranscriptRef>> {
  const ids = [...new Set(drafts.flatMap(recordingThreadIds))];
  const byThread = new Map<string, CodexReplayTranscriptRef>();
  for (const path of [...new Set(drafts.flatMap((draft) => draft.directTranscriptPaths))]) {
    const ref = await transcriptRef(path, ids);
    if (ref) byThread.set(ref.threadId, ref);
  }
  const missing = ids.filter((id) => !byThread.has(id));
  if (missing.length) {
    for (const ref of await scanTranscriptFiles(sessionsRoot, missing)) {
      byThread.set(ref.threadId, ref);
    }
  }
  return byThread;
}

function recordingThreadIds(draft: RecordingDraft): string[] {
  return [
    ...new Set([
      ...draft.threadIds,
      ...draft.directTranscriptPaths.flatMap((path) => threadIdsFromTranscriptPath(path)),
    ]),
  ];
}

function transcriptPathsFromReplay(text: string): string[] {
  const paths = new Set<string>();
  for (const line of text.split(/\r?\n/)) {
    if (!line.trim()) continue;
    try {
      collectTranscriptPaths(JSON.parse(line), (path) => paths.add(path));
    } catch {}
  }
  return [...paths];
}

async function transcriptRef(
  path: string,
  knownThreadIds: string[],
): Promise<CodexReplayTranscriptRef | null> {
  try {
    const stats = await stat(path);
    if (!stats.isFile()) return null;
    const threadId =
      knownThreadIds.find((id) => basename(path).includes(id)) ?? knownThreadIds[0];
    if (!threadId) return null;
    return {
      threadId,
      path,
      name: relative(dirname(dirname(dirname(path))), path),
      mtimeMs: stats.mtimeMs,
      size: stats.size,
    };
  } catch {
    return null;
  }
}

async function scanTranscriptFiles(
  sessionsRoot: string,
  threadIds: string[],
): Promise<CodexReplayTranscriptRef[]> {
  const wanted = new Set(threadIds);
  const refs: CodexReplayTranscriptRef[] = [];
  async function visit(dir: string): Promise<void> {
    let entries;
    try {
      entries = await readdir(dir, { withFileTypes: true });
    } catch {
      return;
    }
    await Promise.all(
      entries.map(async (entry) => {
        const path = join(dir, entry.name);
        if (entry.isDirectory()) {
          await visit(path);
          return;
        }
        if (!entry.isFile() || !/\.(jsonl|json)$/i.test(entry.name)) return;
        const threadId = threadIds.find((id) => entry.name.includes(id));
        if (!threadId || !wanted.has(threadId)) return;
        const stats = await stat(path);
        refs.push({
          threadId,
          path,
          name: relative(sessionsRoot, path),
          mtimeMs: stats.mtimeMs,
          size: stats.size,
        });
      }),
    );
  }
  await visit(sessionsRoot);
  return refs;
}

function collectThreadIds(value: unknown, add: (value: unknown) => void): void {
  if (!value || typeof value !== "object") return;
  if (Array.isArray(value)) {
    for (const item of value) collectThreadIds(item, add);
    return;
  }
  const record = value as Record<string, unknown>;
  add(record.threadId);
  add(record.thread_id);
  add(record.sessionId);
  const thread = record.thread;
  if (thread && typeof thread === "object" && !Array.isArray(thread)) {
    add((thread as Record<string, unknown>).id);
    add((thread as Record<string, unknown>).sessionId);
  }
  for (const child of Object.values(record)) {
    collectThreadIds(child, add);
  }
}

function threadIdsFromTranscriptPath(path: string): string[] {
  return [...path.matchAll(/[0-9a-f]{8}-[0-9a-f-]{27,}/gi)]
    .map((match) => match[0])
    .filter(isThreadLikeId);
}

function isThreadLikeId(value: unknown): value is string {
  if (typeof value !== "string") return false;
  if (!/^[0-9a-f]{8}-[0-9a-f-]{27,}$/i.test(value)) return false;
  const parts = value.split("-");
  return (
    parts.length === 5 &&
    parts[0]?.length === 8 &&
    parts[1]?.length === 4 &&
    parts[2]?.length === 4 &&
    parts[3]?.length === 4 &&
    parts[4]?.length === 12
  );
}

function collectTranscriptPaths(value: unknown, add: (path: string) => void): void {
  if (!value || typeof value !== "object") return;
  if (Array.isArray(value)) {
    for (const item of value) collectTranscriptPaths(item, add);
    return;
  }
  for (const [key, child] of Object.entries(value)) {
    if (key === "path" && typeof child === "string" && child.includes("/.codex/sessions/")) {
      add(child);
    }
    collectTranscriptPaths(child, add);
  }
}

function assertInside(path: string, root: string): void {
  const rel = relative(root, path);
  if (rel.startsWith("..") || rel === "" || rel.includes(`..${sep}`)) {
    throw new Error("recording path outside recording directory");
  }
}
