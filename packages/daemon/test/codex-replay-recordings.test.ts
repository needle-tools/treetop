import { describe, expect, test } from "bun:test";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  extractCodexReplayThreadIds,
  listCodexReplayRecordings,
  readCodexReplayRecording,
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
      await writeFile(transcriptPath, JSON.stringify({ type: "session_meta", payload: { id: threadId } }));
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
      await writeFile(transcriptPath, "{\"type\":\"session_meta\"}\n");
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
      expect(payload.transcripts[0]?.text).toBe("{\"type\":\"session_meta\"}\n");
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
      await writeFile(transcriptPath, "{\"type\":\"session_meta\"}\n");
      const recordingPath = join(recordingDir, "codex-app-test.jsonl");
      await writeFile(
        recordingPath,
        `${JSON.stringify({
          seq: 1,
          message: { result: { thread: { id: threadId, path: transcriptPath } } },
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
});
