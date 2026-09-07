import { open as fsOpen, readdir, readFile, stat } from "node:fs/promises";
import { homedir } from "node:os";
import { createReadStream } from "node:fs";
import { createInterface } from "node:readline";
import { basename, dirname, join, relative, resolve, sep } from "node:path";
import { readCodexSessionOverview, type AgentSession } from "./agents";
import {
  tailParseSessionFile,
  type NormalizedSession,
} from "./sessions";

export interface CodexReplayTranscriptRef {
  threadId: string;
  path: string;
  name: string;
  mtimeMs: number;
  size: number;
  title?: string;
  messageCount?: number;
  cwd?: string;
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
  sessionTitles?: Record<string, string>;
  codexSessions?: AgentSession[];
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

interface SessionRecordingDraft {
  path: string;
  name: string;
  mtimeMs: number;
  size: number;
  threadIds: string[];
  threadFrameCounts: Map<string, number>;
  directTranscriptPaths: string[];
}

interface SessionDraftCacheEntry {
  signature: string;
  drafts: Promise<SessionRecordingDraft[]>;
}

const sessionDraftCache = new Map<string, SessionDraftCacheEntry>();

export interface CodexReplaySessionRef {
  threadId: string;
  title: string;
  mtimeMs: number;
  rpcRecordingCount: number;
  rpcFrameCount: number;
  hasTranscript: boolean;
  recordings: Array<
    Pick<CodexReplayRecordingRef, "path" | "name" | "mtimeMs" | "size">
  >;
  transcript?: CodexReplayTranscriptRef;
  transcripts?: CodexReplayTranscriptRef[];
}

export interface CodexReplaySessionPayload {
  session: CodexReplaySessionRef;
  recordingText: string;
  transcriptText?: string;
  transcriptTruncated?: boolean;
  transcriptSession?: NormalizedSession;
}

export interface CodexReplaySessionReadOptions extends CodexReplayRecordingOptions {
  threadId: string;
}

export async function listCodexReplayRecordings(
  options: CodexReplayRecordingOptions,
): Promise<CodexReplayRecordingRef[]> {
  const recordingDir = resolve(options.recordingDir);
  const sessionsRoot =
    options.sessionsRoot ?? join(homedir(), ".codex", "sessions");
  const files = await listRecordingFiles(recordingDir);
  const drafts = (
    await Promise.all(files.map((path) => recordingDraftFromPath(path)))
  ).filter((entry): entry is RecordingDraft => !!entry);
  const transcriptIndex = await buildTranscriptIndex(sessionsRoot, drafts);
  return drafts
    .map((draft) => recordingRefFromDraft(draft, transcriptIndex))
    .sort((a, b) => b.mtimeMs - a.mtimeMs);
}

export async function listCodexReplaySessions(
  options: CodexReplayRecordingOptions,
): Promise<CodexReplaySessionRef[]> {
  const recordingDir = resolve(options.recordingDir);
  const sessionsRoot =
    options.sessionsRoot ?? join(homedir(), ".codex", "sessions");
  const drafts = await indexedSessionRecordings(recordingDir);
  const transcriptIndex = await buildTranscriptIndex(
    sessionsRoot,
    drafts,
    options.sessionTitles,
  );
  for (const session of options.codexSessions ?? []) {
    const ref = transcriptRefFromAgent(session, sessionsRoot);
    if (!ref) continue;
    const current = transcriptIndex.get(ref.threadId);
    if (!current || ref.mtimeMs >= current.mtimeMs) {
      transcriptIndex.set(ref.threadId, ref);
    }
  }
  const agentTranscripts = new Map<string, CodexReplayTranscriptRef[]>();
  for (const agent of options.codexSessions ?? []) {
    const ref = transcriptRefFromAgent(agent, sessionsRoot);
    if (!ref) continue;
    const refs = agentTranscripts.get(ref.threadId) ?? [];
    if (!refs.some((candidate) => candidate.path === ref.path)) refs.push(ref);
    agentTranscripts.set(ref.threadId, refs);
  }
  const threadIds = [
    ...new Set([
      ...drafts.flatMap(recordingThreadIds),
      ...transcriptIndex.keys(),
    ]),
  ];
  return threadIds
    .map((threadId) => {
      const matching = drafts.filter((draft) =>
        recordingThreadIds(draft).includes(threadId),
      );
      const transcript = transcriptIndex.get(threadId);
      const transcripts = [
        ...(agentTranscripts.get(threadId) ?? []),
        ...(transcript ? [transcript] : []),
      ]
        .filter(
          (candidate, index, all) =>
            all.findIndex((other) => other.path === candidate.path) === index,
        )
        .sort((a, b) => a.path.localeCompare(b.path));
      return {
        threadId,
        title: transcript?.title ?? `Session ${threadId.slice(0, 8)}`,
        mtimeMs: Math.max(
          transcript?.mtimeMs ?? 0,
          ...matching.map((draft) => draft.mtimeMs),
        ),
        rpcRecordingCount: matching.length,
        rpcFrameCount: matching.reduce(
          (count, draft) =>
            count + (draft.threadFrameCounts.get(threadId) ?? 0),
          0,
        ),
        hasTranscript: !!transcript,
        recordings: matching
          .map(({ path, name, mtimeMs, size }) => ({
            path,
            name,
            mtimeMs,
            size,
          }))
          .sort(
            (a, b) => a.mtimeMs - b.mtimeMs || a.name.localeCompare(b.name),
          ),
        ...(transcript ? { transcript } : {}),
        ...(transcripts.length ? { transcripts } : {}),
      } satisfies CodexReplaySessionRef;
    })
    .filter((session) => session.rpcFrameCount > 0 || session.hasTranscript)
    .sort((a, b) => b.mtimeMs - a.mtimeMs);
}

function transcriptRefFromAgent(
  session: AgentSession,
  sessionsRoot: string,
): CodexReplayTranscriptRef | null {
  if (session.agent !== "codex" || !session.sessionId) return null;
  return {
    threadId: session.sessionId,
    path: session.source,
    name: relative(sessionsRoot, session.source),
    mtimeMs: Date.parse(session.lastActive) || 0,
    size: session.fileSizeBytes ?? 0,
    title:
      session.manualTitle ??
      session.aiTitle ??
      session.title ??
      session.firstUserMessage,
    messageCount: session.messageCount,
    cwd: session.cwd,
  };
}

export async function readCodexReplaySession(
  options: CodexReplaySessionReadOptions,
): Promise<CodexReplaySessionPayload> {
  if (!isThreadLikeId(options.threadId)) throw new Error("invalid thread id");
  const sessions = await listCodexReplaySessions(options);
  const session = sessions.find((entry) => entry.threadId === options.threadId);
  if (!session) throw new Error("recorded session not found");
  let recordingText = "";
  for (const recording of session.recordings.toReversed()) {
    const candidate = await readRecordingForThread(
      recording.path,
      options.threadId,
    );
    if (!recordingContainsThreadPage(candidate, options.threadId)) continue;
    recordingText = candidate;
    break;
  }
  if (!recordingText && !session.hasTranscript) {
    throw new Error("recorded session has no thread page");
  }
  const transcript = session.transcript
    ? await readReplayTranscript(session.transcript.path)
    : undefined;
  const transcriptParts = session.transcripts?.length
    ? session.transcripts
    : session.transcript
      ? [session.transcript]
      : [];
  let transcriptSession: NormalizedSession | undefined;
  for (const part of transcriptParts) {
    // Replay Lab must remain safe for real-world transcripts, which can be
    // multiple gigabytes. The production session surface is tail-bounded too;
    // feeding it a full parse here only inflated the daemon until the dev
    // proxy observed a socket hang-up. Small files are still read in full.
    const parsed = await tailParseSessionFile("codex", part.path);
    if (!transcriptSession) {
      transcriptSession = parsed;
    } else {
      transcriptSession.messages.push(...parsed.messages);
      transcriptSession.endedAt = parsed.endedAt ?? transcriptSession.endedAt;
      transcriptSession.cwd ||= parsed.cwd;
      transcriptSession.sessionId ||= parsed.sessionId;
    }
  }
  return {
    session,
    recordingText,
    ...(transcript
      ? {
          transcriptText: transcript.text,
          transcriptTruncated: transcript.truncated,
        }
      : {}),
    ...(transcriptSession ? { transcriptSession } : {}),
  };
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
  const sessionsRoot =
    options.sessionsRoot ?? join(homedir(), ".codex", "sessions");
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
  const transcriptPaths = recordingRefFromDraft(
    draft,
    transcriptIndex,
  ).transcriptPaths;
  const selectedTranscriptPath = options.transcriptPath
    ? resolve(options.transcriptPath)
    : undefined;
  const selectedTranscript = selectedTranscriptPath
    ? transcriptPaths.find(
        (ref) => resolve(ref.path) === selectedTranscriptPath,
      )
    : undefined;
  if (selectedTranscriptPath && !selectedTranscript) {
    throw new Error("transcript path does not belong to recording");
  }
  const transcripts = selectedTranscript
    ? [
        {
          ...selectedTranscript,
          text: await readFile(selectedTranscript.path, "utf8"),
        },
      ]
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

async function recordingDraftFromPath(
  path: string,
): Promise<RecordingDraft | null> {
  try {
    const [stats, text] = await Promise.all([
      stat(path),
      readFile(path, "utf8"),
    ]);
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

async function scanSessionRecording(
  path: string,
): Promise<SessionRecordingDraft | null> {
  try {
    const stats = await stat(path);
    const threadFrameCounts = new Map<string, number>();
    const threadIds = new Set<string>();
    const directTranscriptPaths = new Set<string>();
    const countRecord = (record: unknown) => {
      const ids = new Set<string>();
      collectThreadIds(record, (value) => {
        if (isThreadLikeId(value)) ids.add(value);
      });
      for (const id of ids) {
        threadIds.add(id);
        if (replayStepCount(record) > 0) {
          threadFrameCounts.set(id, (threadFrameCounts.get(id) ?? 0) + 1);
        }
      }
      collectTranscriptPaths(record, (value) =>
        directTranscriptPaths.add(value),
      );
    };

    if (/\.json$/i.test(path)) {
      for (const record of recordingRecords(await readFile(path, "utf8"))) {
        countRecord(record);
      }
    } else {
      const lines = createInterface({
        input: createReadStream(path),
        crlfDelay: Infinity,
      });
      for await (const line of lines) {
        const ids = threadIdsFromJsonLine(line);
        for (const id of ids) {
          threadIds.add(id);
        }
        if (ids.length && replayStepCountFromJsonLine(line) > 0) {
          for (const id of ids) {
            threadFrameCounts.set(id, (threadFrameCounts.get(id) ?? 0) + 1);
          }
        }
        if (line.includes("/.codex/sessions/")) {
          try {
            collectTranscriptPaths(JSON.parse(line), (value) =>
              directTranscriptPaths.add(value),
            );
          } catch {}
        }
      }
    }

    return {
      path,
      name: basename(path),
      mtimeMs: stats.mtimeMs,
      size: stats.size,
      threadIds: [...threadIds],
      threadFrameCounts,
      directTranscriptPaths: [...directTranscriptPaths],
    };
  } catch {
    return null;
  }
}

async function indexedSessionRecordings(
  recordingDir: string,
): Promise<SessionRecordingDraft[]> {
  const files = await listRecordingFiles(recordingDir);
  const fileStats = await Promise.all(
    files.map(async (path) => ({ path, stats: await stat(path) })),
  );
  const signature = fileStats
    .map(({ path, stats }) => `${path}\0${stats.size}\0${stats.mtimeMs}`)
    .join("\n");
  const cached = sessionDraftCache.get(recordingDir);
  if (cached?.signature === signature) return cached.drafts;

  const drafts = (async () => {
    const result: SessionRecordingDraft[] = [];
    for (const { path } of fileStats) {
      const draft = await scanSessionRecording(path);
      if (draft) result.push(draft);
    }
    return result;
  })();
  sessionDraftCache.set(recordingDir, { signature, drafts });
  try {
    return await drafts;
  } catch (error) {
    if (sessionDraftCache.get(recordingDir)?.drafts === drafts) {
      sessionDraftCache.delete(recordingDir);
    }
    throw error;
  }
}

async function readRecordingForThread(
  path: string,
  threadId: string,
): Promise<string> {
  if (/\.json$/i.test(path)) {
    return recordingRecordsForThread(await readFile(path, "utf8"), threadId)
      .map((record) => JSON.stringify(record))
      .join("\n");
  }
  const matching: string[] = [];
  const lines = createInterface({
    input: createReadStream(path),
    crlfDelay: Infinity,
  });
  for await (const line of lines) {
    if (threadIdsFromJsonLine(line).includes(threadId)) matching.push(line);
  }
  return matching.join("\n");
}

function recordingContainsThreadPage(text: string, threadId: string): boolean {
  for (const line of text.split(/\r?\n/)) {
    if (!line) continue;
    try {
      const frame = JSON.parse(line) as Record<string, unknown>;
      const message =
        frame.message && typeof frame.message === "object"
          ? (frame.message as Record<string, unknown>)
          : typeof frame.raw === "string"
            ? (JSON.parse(frame.raw) as Record<string, unknown>)
            : undefined;
      const result = message?.result as Record<string, unknown> | undefined;
      const thread = result?.thread as Record<string, unknown> | undefined;
      const page = result?.initialTurnsPage as
        | Record<string, unknown>
        | undefined;
      if (thread?.id === threadId && Array.isArray(page?.data)) return true;
    } catch {
      // Malformed rows are ignored by the recording index as well.
    }
  }
  return false;
}

const REPLAY_TRANSCRIPT_TAIL_BYTES = 16 * 1024 * 1024;

async function readReplayTranscript(
  path: string,
): Promise<{ text: string; truncated: boolean }> {
  const stats = await stat(path);
  const start = Math.max(0, stats.size - REPLAY_TRANSCRIPT_TAIL_BYTES);
  const handle = await fsOpen(path, "r");
  let text: string;
  try {
    const buffer = Buffer.allocUnsafe(stats.size - start);
    const { bytesRead } = await handle.read(buffer, 0, buffer.length, start);
    text = buffer.subarray(0, bytesRead).toString("utf8");
  } finally {
    await handle.close();
  }
  if (start > 0) {
    const firstNewline = text.indexOf("\n");
    text = firstNewline >= 0 ? text.slice(firstNewline + 1) : "";
  }
  const projected: string[] = [];
  for (const line of text.split(/\r?\n/)) {
    if (!line) continue;
    try {
      const row = JSON.parse(line) as Record<string, unknown>;
      const payload =
        row.payload && typeof row.payload === "object"
          ? (row.payload as Record<string, unknown>)
          : undefined;
      if (row.type === "compacted" || payload?.type === "compact_context") {
        projected.push(
          JSON.stringify({
            ...(typeof row.timestamp === "string"
              ? { timestamp: row.timestamp }
              : {}),
            type: "compacted",
            payload: {},
          }),
        );
      } else if (
        row.type === "session_meta" ||
        row.type === "event_msg" ||
        row.type === "response_item"
      ) {
        projected.push(line);
      } else {
        projected.push(JSON.stringify({ type: row.type, payload: {} }));
      }
    } catch {
      projected.push(line);
    }
  }
  return { text: projected.join("\n"), truncated: start > 0 };
}

function threadIdsFromJsonLine(line: string): string[] {
  const ids = new Set<string>();
  const keyedId =
    /"(?:threadId|thread_id|sessionId)"\s*:\s*"([0-9a-f-]{36})"/gi;
  for (const match of line.matchAll(keyedId)) {
    if (isThreadLikeId(match[1])) ids.add(match[1]);
  }
  const threadObject =
    /"thread"\s*:\s*\{[^\n]{0,2000}?"id"\s*:\s*"([0-9a-f-]{36})"/gi;
  for (const match of line.matchAll(threadObject)) {
    if (isThreadLikeId(match[1])) ids.add(match[1]);
  }
  return [...ids];
}

function replayStepCountFromJsonLine(line: string): number {
  try {
    return replayStepCount(JSON.parse(line));
  } catch {
    return 0;
  }
}

function replayStepCount(value: unknown): number {
  if (!value || typeof value !== "object" || Array.isArray(value)) return 0;
  const frame = value as Record<string, unknown>;
  const message =
    frame.message && typeof frame.message === "object"
      ? (frame.message as Record<string, unknown>)
      : undefined;
  if (!message || typeof message.method !== "string") return 0;
  if (frame.direction !== "client") return 1;
  if (message.method !== "turn/start" && message.method !== "turn/steer") {
    return 0;
  }
  const params =
    message.params && typeof message.params === "object"
      ? (message.params as Record<string, unknown>)
      : undefined;
  return params?.input ? 1 : 0;
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
  drafts: Array<Pick<RecordingDraft, "threadIds" | "directTranscriptPaths">>,
  sessionTitles?: Record<string, string>,
): Promise<Map<string, CodexReplayTranscriptRef>> {
  const ids = [...new Set(drafts.flatMap(recordingThreadIds))];
  const byThread = new Map<string, CodexReplayTranscriptRef>();
  for (const path of [
    ...new Set(drafts.flatMap((draft) => draft.directTranscriptPaths)),
  ]) {
    const ref = await transcriptRef(path, ids, sessionTitles);
    if (ref) byThread.set(ref.threadId, ref);
  }
  const missing = ids.filter((id) => !byThread.has(id));
  if (missing.length) {
    for (const ref of await scanTranscriptFiles(
      sessionsRoot,
      missing,
      sessionTitles,
    )) {
      byThread.set(ref.threadId, ref);
    }
  }
  return byThread;
}

function recordingThreadIds(
  draft: Pick<RecordingDraft, "threadIds" | "directTranscriptPaths">,
): string[] {
  return [
    ...new Set([
      ...draft.threadIds,
      ...draft.directTranscriptPaths.flatMap((path) =>
        threadIdsFromTranscriptPath(path),
      ),
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
  sessionTitles?: Record<string, string>,
): Promise<CodexReplayTranscriptRef | null> {
  try {
    const stats = await stat(path);
    if (!stats.isFile()) return null;
    const threadId =
      knownThreadIds.find((id) => basename(path).includes(id)) ??
      knownThreadIds[0];
    if (!threadId) return null;
    const overview = await readCodexSessionOverview(path, stats.size);
    return {
      threadId,
      path,
      name: relative(dirname(dirname(dirname(path))), path),
      mtimeMs: stats.mtimeMs,
      size: stats.size,
      title: sessionTitles?.[path] ?? overview.firstUserMessage,
      messageCount: overview.messageCount,
    };
  } catch {
    return null;
  }
}

async function scanTranscriptFiles(
  sessionsRoot: string,
  threadIds: string[],
  sessionTitles?: Record<string, string>,
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
        const ref = await transcriptRef(path, [threadId], sessionTitles);
        if (ref) refs.push({ ...ref, name: relative(sessionsRoot, path) });
      }),
    );
  }
  await visit(sessionsRoot);
  return refs;
}

function recordingRecords(text: string): unknown[] {
  const trimmed = text.trim();
  if (!trimmed) return [];
  try {
    const root = JSON.parse(trimmed);
    if (Array.isArray(root)) return root;
    if (root && typeof root === "object") {
      const record = root as Record<string, unknown>;
      for (const key of ["frames", "events", "records"]) {
        if (Array.isArray(record[key])) return record[key] as unknown[];
      }
      return [root];
    }
  } catch {}
  const records: unknown[] = [];
  for (const line of trimmed.split(/\r?\n/)) {
    try {
      records.push(JSON.parse(line));
    } catch {}
  }
  return records;
}

function recordingRecordsForThread(text: string, threadId: string): unknown[] {
  return recordingRecords(text).filter((record) => {
    const ids = new Set<string>();
    collectThreadIds(record, (value) => {
      if (isThreadLikeId(value)) ids.add(value);
    });
    return ids.has(threadId);
  });
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

function collectTranscriptPaths(
  value: unknown,
  add: (path: string) => void,
): void {
  if (!value || typeof value !== "object") return;
  if (Array.isArray(value)) {
    for (const item of value) collectTranscriptPaths(item, add);
    return;
  }
  for (const [key, child] of Object.entries(value)) {
    if (
      key === "path" &&
      typeof child === "string" &&
      child.includes("/.codex/sessions/")
    ) {
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
