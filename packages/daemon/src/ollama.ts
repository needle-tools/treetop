/**
 * Ollama support: list installed models so the UI's "+" picker can
 * offer them as spawn targets.
 *
 * Two sources, in order:
 *   1. HTTP API at http://127.0.0.1:11434/api/tags — fast, structured.
 *      The Ollama macOS app starts the server on login; on Linux a
 *      user-installed `ollama serve` may or may not be running.
 *   2. Shell-out to `ollama list` — works without a running server
 *      because the CLI talks to the local model store directly. Slow
 *      first call, but reliable.
 *
 * We never auto-start `ollama serve`. If neither path returns models,
 * the picker shows an empty submenu with an inline hint.
 */

import { resolveAgentBinary } from "./procs";

export interface OllamaModel {
  /** Full tag, e.g. "llama3.2:3b" — pass verbatim to `ollama run`. */
  name: string;
  /** Bytes on disk. May be 0 for cloud-hosted models. */
  size?: number;
  /** Parameter-size string from the model metadata, e.g. "8.0B". */
  parameterSize?: string;
}

export const OLLAMA_HOST =
  process.env.OLLAMA_HOST?.replace(/\/+$/, "") || "http://127.0.0.1:11434";

/**
 * Fetch installed Ollama models via the HTTP API.
 * Returns null if the server is unreachable so the caller can fall
 * back to the CLI; throws only on unexpected JSON shape.
 */
export async function fetchModelsFromApi(): Promise<OllamaModel[] | null> {
  try {
    const res = await fetch(`${OLLAMA_HOST}/api/tags`, {
      signal: AbortSignal.timeout(1500),
    });
    if (!res.ok) return null;
    const body = (await res.json()) as { models?: unknown };
    return normalizeApiModels(body);
  } catch {
    return null;
  }
}

/** Parser for the `/api/tags` payload. Exported for tests. */
export function normalizeApiModels(body: unknown): OllamaModel[] {
  if (!body || typeof body !== "object") return [];
  const raw = (body as { models?: unknown }).models;
  if (!Array.isArray(raw)) return [];
  const out: OllamaModel[] = [];
  for (const m of raw) {
    if (!m || typeof m !== "object") continue;
    const rec = m as Record<string, unknown>;
    const name = typeof rec.name === "string" ? rec.name : typeof rec.model === "string" ? rec.model : null;
    if (!name) continue;
    const details = rec.details as Record<string, unknown> | undefined;
    out.push({
      name,
      size: typeof rec.size === "number" ? rec.size : undefined,
      parameterSize:
        details && typeof details.parameter_size === "string" ? details.parameter_size : undefined,
    });
  }
  return out;
}

/**
 * Fall back to parsing `ollama list` output. Columns:
 *   NAME                ID              SIZE    MODIFIED
 *   llama3.2:3b         abc123          2.0 GB  2 days ago
 * We only need NAME and SIZE; everything else is ignored.
 */
export async function fetchModelsFromCli(): Promise<OllamaModel[]> {
  const bin = await resolveAgentBinary("ollama");
  if (!bin) return [];
  try {
    const proc = Bun.spawn([bin, "list"], { stdout: "pipe", stderr: "pipe" });
    const stdout = await new Response(proc.stdout).text();
    const exit = await proc.exited;
    if (exit !== 0) return [];
    return parseOllamaListOutput(stdout);
  } catch {
    return [];
  }
}

/** Parse `ollama list` table output. Exported for tests. */
export function parseOllamaListOutput(text: string): OllamaModel[] {
  const lines = text.split(/\r?\n/).filter((l) => l.trim().length > 0);
  if (lines.length === 0) return [];
  // First non-empty line is the header (NAME ID SIZE MODIFIED). Skip if
  // it starts with "NAME" (case-insensitive, allowing spaces).
  const startIdx = /^\s*NAME\b/i.test(lines[0]!) ? 1 : 0;
  const out: OllamaModel[] = [];
  for (let i = startIdx; i < lines.length; i++) {
    const line = lines[i]!;
    const parts = line.trim().split(/\s{2,}|\t+/);
    const name = parts[0]?.trim();
    if (!name) continue;
    // SIZE column is typically "2.0 GB" / "350 MB". Parse if present.
    const sizeStr = parts[2]?.trim();
    out.push({ name, size: parseHumanSize(sizeStr) });
  }
  return out;
}

function parseHumanSize(s: string | undefined): number | undefined {
  if (!s) return undefined;
  const m = /^([\d.]+)\s*([KMGT]?B)$/i.exec(s.trim());
  if (!m) return undefined;
  const n = Number(m[1]);
  if (!Number.isFinite(n)) return undefined;
  const unit = m[2]!.toUpperCase();
  const mult: Record<string, number> = {
    B: 1,
    KB: 1024,
    MB: 1024 ** 2,
    GB: 1024 ** 3,
    TB: 1024 ** 4,
  };
  return n * (mult[unit] ?? 1);
}

/**
 * Public entry: returns the merged set of available models. Tries the
 * HTTP API first (fast, structured), then falls back to the CLI.
 */
export async function listOllamaModels(): Promise<OllamaModel[]> {
  const fromApi = await fetchModelsFromApi();
  if (fromApi && fromApi.length > 0) return fromApi;
  const fromCli = await fetchModelsFromCli();
  return fromCli;
}
