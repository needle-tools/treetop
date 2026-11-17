import {
  mkdir,
  readFile,
  readdir,
  writeFile,
  rename,
  unlink,
  chmod,
} from "node:fs/promises";
import { existsSync } from "node:fs";
import { join, dirname, resolve } from "node:path";

import { createHash } from "node:crypto";
import { gunzipSync } from "node:zlib";

const ENCODER_RELEASE = "b6.1.1";
interface EncoderAsset {
  target: string;
  sha256: string;
  size: number;
}
const ENCODER_ASSETS: Record<string, EncoderAsset> = {
  "win32-x64": {
    target: "win32-x64",
    size: 29581307,
    sha256: "8883a3dffbd0a16cf4ef95206ea05283f78908dbfb118f73c83f4951dcc06d77",
  },
  "darwin-arm64": {
    target: "darwin-arm64",
    size: 19246198,
    sha256: "8923876afa8db5585022d7860ec7e589af192f441c56793971276d450ed3bbfa",
  },
  "darwin-x64": {
    target: "darwin-x64",
    size: 25296431,
    sha256: "929b375c1182d956c51f7ac25e0b2b0411fb01f6f407aa15c9758efeb4242106",
  },
};
let cachedEncoder: string | undefined;
export function configureTimelapseEncoder(path: string) {
  cachedEncoder = path;
}

export class TimelapseEncoderInstaller {
  readonly asset: EncoderAsset | undefined;
  readonly path: string;
  private pending?: Promise<string>;
  private controller?: AbortController;
  private state: "idle" | "downloading" | "ready" | "error" | "cancelled" =
    "idle";
  private received = 0;
  private error = "";
  constructor(
    private root: string,
    private options: {
      asset?: EncoderAsset;
      download?: (url: string, init?: RequestInit) => Promise<Response>;
    } = {},
  ) {
    this.asset =
      options.asset ?? ENCODER_ASSETS[`${process.platform}-${process.arch}`];
    this.path = join(
      root,
      `ffmpeg-${ENCODER_RELEASE}-${this.asset?.target ?? "unsupported"}${process.platform === "win32" ? ".exe" : ""}`,
    );
  }
  status() {
    return {
      state: existsSync(this.path) ? "ready" : this.state,
      received: this.received,
      total: this.asset?.size ?? 0,
      error: this.error,
      supported: !!this.asset,
    };
  }
  install(): Promise<string> {
    if (existsSync(this.path)) return Promise.resolve(this.path);
    if (this.pending) return this.pending;
    this.pending = this.download().finally(() => {
      this.pending = undefined;
      this.controller = undefined;
    });
    return this.pending;
  }
  async cancel() {
    if (!this.pending || existsSync(this.path)) return;
    this.controller?.abort(new Error("Encoder installation cancelled"));
    await this.pending.catch(() => {}); // download records the terminal state and cleans its partial file.
  }
  private async download() {
    if (!this.asset)
      throw new Error(
        "One-click encoder installation is supported on Windows x64 and macOS",
      );
    this.controller = new AbortController();
    const signal = AbortSignal.any([
      this.controller.signal,
      AbortSignal.timeout(10 * 60_000),
    ]);
    this.state = "downloading";
    this.received = 0;
    this.error = "";
    const base = `https://github.com/eugeneware/ffmpeg-static/releases/download/${ENCODER_RELEASE}`;
    const download = this.options.download ?? fetch;
    const get = async (name: string) => {
      const response = await download(`${base}/${name}`, {
        signal,
      });
      if (!response.ok)
        throw new Error(`Encoder download failed (HTTP ${response.status})`);
      return response;
    };
    try {
      const response = await get(`ffmpeg-${this.asset.target}.gz`);
      const chunks: Uint8Array[] = [];
      if (!response.body) throw new Error("Encoder download was empty");
      for await (const chunk of response.body) {
        this.received += chunk.length;
        if (this.received > this.asset.size)
          throw new Error("Encoder checksum mismatch (unexpected size)");
        chunks.push(chunk);
      }
      signal.throwIfAborted();
      const compressed = Buffer.concat(chunks);
      if (
        createHash("sha256").update(compressed).digest("hex") !==
        this.asset.sha256
      )
        throw new Error("Encoder checksum mismatch; please retry");
      const binary = gunzipSync(compressed, {
        maxOutputLength: 256 * 1024 * 1024,
      });
      await mkdir(this.root, { recursive: true });
      // Keep the upstream license and source/build notices beside the executable.
      for (const suffix of ["LICENSE", "README"]) {
        const notice = await (
          await get(`${this.asset.target}.${suffix}`)
        ).text();
        await writeFile(
          join(
            this.root,
            `ffmpeg-${ENCODER_RELEASE}-${this.asset.target}.${suffix}`,
          ),
          notice,
        );
      }
      signal.throwIfAborted();
      await writeFile(this.path + ".part", binary);
      await chmod(this.path + ".part", 0o755);
      signal.throwIfAborted();
      await rename(this.path + ".part", this.path);
      this.state = "ready";
      return this.path;
    } catch (error) {
      this.state = this.controller?.signal.aborted ? "cancelled" : "error";
      this.error = this.state === "cancelled" ? "" : String(error);
      await unlink(this.path + ".part").catch((e) => {
        if (e.code !== "ENOENT") throw e;
      });
      throw error;
    }
  }
}

const EXPORT_IDLE_MS = 8 * 3600_000;
const encoders = new Set<ReturnType<typeof Bun.spawn>>();
let shuttingDown = false;
export function stopTimelapseEncoders() {
  shuttingDown = true;
  for (const encoder of encoders) encoder.kill();
}
const dayKey = (time: number) => {
  const d = new Date(time);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
};
export interface TimelapseDay {
  day: string;
  firstAt: number;
  lastAt?: number;
  frames: string[];
  complete?: boolean;
  error?: string;
  retryAt?: number;
}
export function findTimelapseEncoder(): string | null {
  const name = process.platform === "win32" ? "ffmpeg.exe" : "ffmpeg";
  const paths = [
    process.env.TREETOP_FFMPEG,
    cachedEncoder,
    join(dirname(process.execPath), name),
    resolve(import.meta.dir, "../../../node_modules/ffmpeg-static", name),
    Bun.which("ffmpeg"),
  ];
  return (
    paths.find((path): path is string => !!path && existsSync(path)) ?? null
  );
}
async function runEncoder(args: string[], cwd: string) {
  const binary = findTimelapseEncoder();
  if (!binary)
    throw new Error(
      "FFmpeg is unavailable; install the timelapse encoder in Settings; existing JPEGs are retained",
    );
  const p = Bun.spawn(
    [binary, "-hide_banner", "-loglevel", "error", "-nostdin", ...args],
    {
      cwd,
      windowsHide: true,
      stdin: "ignore",
      stdout: "ignore",
      stderr: "pipe",
    },
  );
  encoders.add(p);
  const timeout = setTimeout(() => p.kill(), 20 * 60_000);
  try {
    const error = await new Response(p.stderr).text();
    if ((await p.exited) !== 0)
      throw new Error(
        shuttingDown
          ? "Timelapse export interrupted"
          : "Timelapse export failed: " + error.slice(-1500),
      );
  } finally {
    clearTimeout(timeout);
    encoders.delete(p);
  }
}
export async function encodeTimelapse(
  folder: string,
  frames: string[],
): Promise<void> {
  if (!frames.length || frames.some((f) => !/^frame-\d+\.jpg$/.test(f)))
    throw new Error("Invalid timelapse frames");
  const list = join(folder, "frames.ffconcat");
  await writeFile(
    list,
    "ffconcat version 1.0\n" + frames.map((f) => `file '${f}'`).join("\n"),
  );
  const normalize =
    "scale=1920:1080:force_original_aspect_ratio=decrease,pad=1920:1080:(ow-iw)/2:(oh-ih)/2,setsar=1";
  for (const [name, filter] of [
    ["crisp", normalize],
    ["motion-blur", normalize + ",tmix=frames=3:weights='1 2 1'"],
  ]) {
    const output = `${name}.part.mp4`;
    await runEncoder(
      [
        "-y",
        "-r",
        "30",
        "-f",
        "concat",
        "-safe",
        "1",
        "-i",
        "frames.ffconcat",
        "-filter_threads",
        "1",
        "-vf",
        filter,
        "-an",
        "-c:v",
        "libx264",
        "-threads",
        "2",
        "-preset",
        "veryfast",
        "-crf",
        "23",
        "-pix_fmt",
        "yuv420p",
        "-movflags",
        "+faststart",
        output,
      ],
      folder,
    );
    const bytes = await readFile(join(folder, output));
    if (bytes.length < 100 || bytes.subarray(4, 8).toString() !== "ftyp")
      throw new Error("Timelapse export did not produce a valid MP4");
  }
  // Promote neither variant until both encodes have succeeded.
  for (const name of ["crisp", "motion-blur"])
    await rename(join(folder, `${name}.part.mp4`), join(folder, `${name}.mp4`));
  await unlink(list).catch(() => {});
}

export class TimelapseStore {
  private capturing = false;
  private exporting = false;
  private lastCapture = -Infinity;
  constructor(
    readonly root: string,
    private options: {
      enabled: () => Promise<boolean>;
      capture: () => Promise<Uint8Array | null>;
      now?: () => number;
      encode?: (folder: string, frames: string[]) => Promise<void>;
    },
  ) {}
  private now() {
    return this.options.now?.() ?? Date.now();
  }
  async list(): Promise<TimelapseDay[]> {
    let entries: string[];
    try {
      entries = await readdir(this.root);
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code === "ENOENT") return [];
      throw e;
    }
    const days: TimelapseDay[] = [];
    for (const day of entries.filter((d) => /^\d{4}-\d{2}-\d{2}$/.test(d))) {
      try {
        const value = JSON.parse(
          await readFile(join(this.root, day, "day.json"), "utf8"),
        ) as TimelapseDay;
        if (
          value.day !== day ||
          !Number.isFinite(value.firstAt) ||
          !Array.isArray(value.frames) ||
          value.frames.some(
            (f) => typeof f !== "string" || !/^frame-\d+\.jpg$/.test(f),
          )
        )
          throw new Error(`Invalid timelapse manifest: ${day}`);
        days.push(value);
      } catch (e) {
        if ((e as NodeJS.ErrnoException).code !== "ENOENT") throw e;
      }
    }
    return days.sort((a, b) => b.day.localeCompare(a.day));
  }
  private async save(value: TimelapseDay) {
    const folder = join(this.root, value.day);
    await mkdir(folder, { recursive: true });
    await writeFile(join(folder, "day.json.tmp"), JSON.stringify(value));
    await rename(join(folder, "day.json.tmp"), join(folder, "day.json"));
  }
  async capture(): Promise<{ captured: boolean; reason?: string }> {
    if (!(await this.options.enabled()))
      return { captured: false, reason: "disabled" };
    const now = this.now();
    if (this.capturing || now - this.lastCapture < 10_000)
      return { captured: false, reason: "interval" };
    this.capturing = true;
    this.lastCapture = now;
    try {
      const jpeg = await this.options.capture();
      if (!jpeg)
        return {
          captured: false,
          reason: "Treetop must be the foreground native window",
        };
      if (!(await this.options.enabled()))
        return { captured: false, reason: "disabled" };
      if (jpeg[0] !== 255 || jpeg[1] !== 216 || jpeg.length < 4)
        throw new Error("Capture did not return a JPEG");
      const day = dayKey(now),
        folder = join(this.root, day);
      const record: TimelapseDay = (await this.list()).find(
        (d) => d.day === day,
      ) ?? {
        day,
        firstAt: now,
        frames: [],
      };
      if (record.complete)
        return { captured: false, reason: "Day already exported" };
      await mkdir(folder, { recursive: true });
      const name = `frame-${now}.jpg`;
      await writeFile(join(folder, name), jpeg);
      record.frames.push(name);
      record.lastAt = now;
      await this.save(record);
      return { captured: true };
    } finally {
      this.capturing = false;
    }
  }
  private async cleanup(day: string) {
    const folder = join(this.root, day);
    for (const name of await readdir(folder))
      if (/^frame-\d+\.jpg$/.test(name)) await unlink(join(folder, name));
  }
  async finalize(): Promise<void> {
    if (this.exporting) return;
    this.exporting = true;
    try {
      for (const day of await this.list()) {
        if (day.complete) {
          await this.cleanup(day.day);
          continue;
        }
        if (
          day.day === dayKey(this.now()) ||
          this.now() - (day.lastAt ?? day.firstAt) < EXPORT_IDLE_MS ||
          !day.frames.length ||
          (day.retryAt ?? 0) > this.now()
        )
          continue;
        try {
          await (this.options.encode ?? encodeTimelapse)(
            join(this.root, day.day),
            day.frames,
          );
          day.complete = true;
          delete day.error;
          delete day.retryAt;
          await this.save(day);
          await this.cleanup(day.day);
        } catch (e) {
          day.error = e instanceof Error ? e.message : String(e);
          day.retryAt = this.now() + (shuttingDown ? 0 : 3600_000);
          await this.save(day);
        }
      }
    } finally {
      this.exporting = false;
    }
  }
}
