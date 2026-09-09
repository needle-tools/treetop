import { describe, expect, test } from "bun:test";
import { resolve } from "node:path";
import {
  replayLabPagePath,
  replayLabDevCommand,
  replayLabPreviewCommand,
  replayLabUrl,
} from "../../../scripts/replay-lab-app";

describe("standalone static Replay Lab", () => {
  test("serves only the dedicated static build with Vite Preview", () => {
    const uiRoot = resolve("packages/ui");
    expect(replayLabPagePath(uiRoot)).toBe(
      resolve(uiRoot, "dist-replay-lab/replay-lab.html"),
    );
    expect(replayLabPreviewCommand("darwin", uiRoot, 17879)).toEqual([
      resolve("node_modules/.bin/vite"),
      "preview",
      "--mode",
      "replay-lab-static",
      "--outDir",
      "dist-replay-lab",
      "--host",
      "127.0.0.1",
      "--port",
      "17879",
      "--strictPort",
    ]);
    expect(replayLabDevCommand("darwin", uiRoot, 17880)).toEqual([
      resolve("node_modules/.bin/vite"),
      "--mode",
      "replay-lab-static",
      "--host",
      "127.0.0.1",
      "--port",
      "17880",
      "--strictPort",
    ]);
  });

  test("uses a separate loopback URL", () => {
    expect(replayLabUrl(17879)).toBe("http://127.0.0.1:17879/replay-lab.html");
  });
});
