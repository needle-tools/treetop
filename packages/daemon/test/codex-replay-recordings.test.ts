import { describe, expect, test } from "bun:test";
import { appendFile, mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  extractCodexReplayThreadIds,
  listCodexReplayRecordings,
  listCodexReplaySessions,
  readCodexReplayRecording,
  readCodexReplaySession,
} from "../src/codex-replay-recordings";

async function withTempDir<T>(fn: (dir: string) => Promise<T>): Promise<T> {
  const dir = await mkdtemp(join(tmpdir(), "supergit-replay-recordings-"));
  try {
    return await fn(dir);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

describe("Codex replay recording discovery", () => {
  test("extracts thread ids from recorded app-server frames", () => {
    const text = [
      JSON.stringify({
        seq: 1,
        message: {
          method: "thread/resume",
          params: { threadId: "019ed710-1a0a-7200-98ec-53f8aa8fab6b" },
        },
      }),
      JSON.stringify({
        seq: 2,
        message: {
          result: {
            thread: { id: "019ed710-1a0a-7200-98ec-53f8aa8fab6b" },
          },
        },
      }),
    ].join("\n");

    expect(extractCodexReplayThreadIds(text)).toEqual([
      "019ed710-1a0a-7200-98ec-53f8aa8fab6b",
    ]);
  });

  test("lists recordings with transcript refs from recorded thread paths", async () => {
    await withTempDir(async (dir) => {
      const recordingDir = join(dir, "recordings");
      const sessionsRoot = join(dir, "sessions");
      await mkdir(recordingDir, { recursive: true });
      await mkdir(join(sessionsRoot, "2026", "08", "27"), { recursive: true });
      const threadId = "019ed710-1a0a-7200-98ec-53f8aa8fab6b";
      const transcriptPath = join(
        sessionsRoot,
        "2026",
        "08",
        "27",
        `rollout-2026-08-27T12-38-52-${threadId}.jsonl`,
      );
      await writeFile(
        transcriptPath,
        JSON.stringify({ type: "session_meta", payload: { id: threadId } }),
      );
      const recordingPath = join(recordingDir, "codex-app-test.jsonl");
      await writeFile(
        recordingPath,
        `${JSON.stringify({
          seq: 1,
          message: {
            result: { thread: { id: threadId, path: transcriptPath } },
          },
        })}\n`,
      );

      const recordings = await listCodexReplayRecordings({
        recordingDir,
        sessionsRoot,
      });

      expect(recordings).toHaveLength(1);
      expect(recordings[0]?.threadIds).toEqual([threadId]);
      expect(recordings[0]?.transcriptPaths[0]?.path).toBe(transcriptPath);
    });
  });

  test("reads a recording with its matching transcript text", async () => {
    await withTempDir(async (dir) => {
      const recordingDir = join(dir, "recordings");
      const sessionsRoot = join(dir, "sessions");
      await mkdir(recordingDir, { recursive: true });
      await mkdir(join(sessionsRoot, "2026", "06", "17"), { recursive: true });
      const threadId = "019ed710-1a0a-7200-98ec-53f8aa8fab6b";
      const transcriptPath = join(
        sessionsRoot,
        "2026",
        "06",
        "17",
        `rollout-2026-06-17T21-30-17-${threadId}.jsonl`,
      );
      await writeFile(transcriptPath, '{"type":"session_meta"}\n');
      const recordingPath = join(recordingDir, "codex-app-test.jsonl");
      const recordingText = `${JSON.stringify({
        seq: 1,
        message: {
          method: "thread/resume",
          params: { threadId },
          result: { thread: { path: transcriptPath } },
        },
      })}\n`;
      await writeFile(recordingPath, recordingText);

      const payload = await readCodexReplayRecording({
        recordingDir,
        sessionsRoot,
        path: recordingPath,
        transcriptPath,
      });

      expect(payload.text).toBe(recordingText);
      expect(payload.transcripts).toHaveLength(1);
      expect(payload.transcripts[0]?.threadId).toBe(threadId);
      expect(payload.transcripts[0]?.text).toBe('{"type":"session_meta"}\n');
    });
  });

  test("does not eagerly read transcript bodies until one is selected", async () => {
    await withTempDir(async (dir) => {
      const recordingDir = join(dir, "recordings");
      const sessionsRoot = join(dir, "sessions");
      await mkdir(recordingDir, { recursive: true });
      await mkdir(join(sessionsRoot, "2026", "06", "17"), { recursive: true });
      const threadId = "019ed710-1a0a-7200-98ec-53f8aa8fab6b";
      const transcriptPath = join(
        sessionsRoot,
        "2026",
        "06",
        "17",
        `rollout-2026-06-17T21-30-17-${threadId}.jsonl`,
      );
      await writeFile(transcriptPath, '{"type":"session_meta"}\n');
      const recordingPath = join(recordingDir, "codex-app-test.jsonl");
      await writeFile(
        recordingPath,
        `${JSON.stringify({
          seq: 1,
          message: {
            result: { thread: { id: threadId, path: transcriptPath } },
          },
        })}\n`,
      );

      const payload = await readCodexReplayRecording({
        recordingDir,
        sessionsRoot,
        path: recordingPath,
      });

      expect(payload.recording.transcriptPaths).toHaveLength(1);
      expect(payload.transcripts).toEqual([]);
    });
  });

  test("groups recording fragments by session with human titles and coverage counts", async () => {
    await withTempDir(async (dir) => {
      const recordingDir = join(dir, "recordings");
      const sessionsRoot = join(dir, "sessions");
      await mkdir(recordingDir, { recursive: true });
      await mkdir(join(sessionsRoot, "2026", "08", "29"), { recursive: true });
      const threadA = "019ed710-1a0a-7200-98ec-53f8aa8fab6b";
      const threadB = "019f5e34-6ff7-7011-9d75-c7d4eb493c92";
      const transcriptA = join(
        sessionsRoot,
        "2026",
        "08",
        "29",
        `rollout-a-${threadA}.jsonl`,
      );
      await writeFile(
        transcriptA,
        [
          JSON.stringify({
            type: "session_meta",
            payload: { id: threadA, cwd: "/repo-a" },
          }),
          JSON.stringify({
            type: "response_item",
            payload: {
              type: "message",
              role: "user",
              content: [
                { type: "input_text", text: "Investigate the renderer freeze" },
              ],
            },
          }),
        ].join("\n"),
      );
      await writeFile(
        join(recordingDir, "one.jsonl"),
        [
          JSON.stringify({
            seq: 1,
            message: { method: "turn/start", params: { threadId: threadA } },
          }),
          JSON.stringify({
            seq: 2,
            message: { method: "turn/start", params: { threadId: threadB } },
          }),
        ].join("\n"),
      );
      await writeFile(
        join(recordingDir, "two.jsonl"),
        JSON.stringify({
          seq: 3,
          message: {
            method: "item/completed",
            params: { threadId: threadA, item: { id: "done-a" } },
          },
        }),
      );

      const sessions = await listCodexReplaySessions({
        recordingDir,
        sessionsRoot,
      });

      expect(sessions).toHaveLength(2);
      expect(
        sessions.find((session) => session.threadId === threadA),
      ).toMatchObject({
        title: "Investigate the renderer freeze",
        rpcRecordingCount: 2,
        rpcFrameCount: 2,
        hasTranscript: true,
      });
      expect(
        sessions.find((session) => session.threadId === threadB),
      ).toMatchObject({
        rpcRecordingCount: 1,
        rpcFrameCount: 1,
        hasTranscript: false,
      });
    });
  });

  test("reads the newest complete capture for a selected session", async () => {
    await withTempDir(async (dir) => {
      const recordingDir = join(dir, "recordings");
      const sessionsRoot = join(dir, "sessions");
      await mkdir(recordingDir, { recursive: true });
      await mkdir(sessionsRoot, { recursive: true });
      const threadA = "019ed710-1a0a-7200-98ec-53f8aa8fab6b";
      const threadB = "019f5e34-6ff7-7011-9d75-c7d4eb493c92";
      await writeFile(
        join(sessionsRoot, `rollout-${threadA}.jsonl`),
        [
          JSON.stringify({ type: "session_meta", payload: { id: threadA } }),
          JSON.stringify({
            type: "compacted",
            payload: { replacement_history: ["large ignored replay data"] },
          }),
        ].join("\n"),
      );
      await writeFile(
        join(recordingDir, "one.jsonl"),
        [
          JSON.stringify({
            seq: 1,
            message: {
              method: "item/completed",
              params: { threadId: threadA },
            },
          }),
          JSON.stringify({
            seq: 2,
            message: {
              method: "item/completed",
              params: { threadId: threadB },
            },
          }),
        ].join("\n"),
      );
      await writeFile(
        join(recordingDir, "two.jsonl"),
        [
          JSON.stringify({
            seq: 3,
            direction: "server",
            message: {
              id: 4,
              result: {
                thread: { id: threadA, cwd: "/repo", turns: [] },
                initialTurnsPage: { data: [] },
              },
            },
          }),
          JSON.stringify({
            seq: 4,
            direction: "server",
            message: {
              method: "turn/completed",
              params: { threadId: threadA },
            },
          }),
        ].join("\n"),
      );

      const payload = await readCodexReplaySession({
        recordingDir,
        sessionsRoot,
        threadId: threadA,
      });

      expect(payload.session.threadId).toBe(threadA);
      expect(
        payload.recordingText
          .split("\n")
          .map(JSON.parse)
          .map((row) => row.seq),
      ).toEqual([3, 4]);
      expect(payload.recordingText).not.toContain('"seq":1');
      expect(payload.recordingText).not.toContain(threadB);
      expect(payload.transcriptText).toContain('"type":"compacted"');
      expect(payload.transcriptText).not.toContain("large ignored replay data");
    });
  });

  test("refreshes the session index when a live recording grows", async () => {
    await withTempDir(async (dir) => {
      const recordingDir = join(dir, "recordings");
      const sessionsRoot = join(dir, "sessions");
      await mkdir(recordingDir, { recursive: true });
      await mkdir(sessionsRoot, { recursive: true });
      const threadId = "019ed710-1a0a-7200-98ec-53f8aa8fab6b";
      const recording = join(recordingDir, "live.jsonl");
      const frame = (seq: number) =>
        `${JSON.stringify({ seq, message: { method: "item/completed", params: { threadId } } })}\n`;
      await writeFile(recording, frame(1));

      expect(
        (await listCodexReplaySessions({ recordingDir, sessionsRoot }))[0]
          ?.rpcFrameCount,
      ).toBe(1);
      await appendFile(recording, frame(2));
      expect(
        (await listCodexReplaySessions({ recordingDir, sessionsRoot }))[0]
          ?.rpcFrameCount,
      ).toBe(2);
    });
  });
});
