import { apiUrl } from "./api";
import type { CodexModelInfo } from "./claude-session-menu";

export interface CodexModelsResult {
  models: CodexModelInfo[];
  error: string;
}

const codexModelsCache = new Map<string, CodexModelsResult>();
const codexModelsInFlight = new Map<string, Promise<CodexModelsResult>>();

export function codexModelsCacheKey(
  daemonId: string | undefined,
  cwd: string,
): string {
  return `${daemonId ?? ""}\0${cwd}`;
}

export async function loadSharedCodexModels(
  daemonId: string | undefined,
  cwd: string,
): Promise<CodexModelsResult> {
  const key = codexModelsCacheKey(daemonId, cwd);
  const cached = codexModelsCache.get(key);
  if (cached) return cached;
  const inFlight = codexModelsInFlight.get(key);
  if (inFlight) return inFlight;
  const promise = (async () => {
    try {
      const qs = new URLSearchParams({ cwd });
      const res = await fetch(
        apiUrl(`/api/codex-app/models?${qs.toString()}`, daemonId),
      );
      const body = (await res.json().catch(() => null)) as {
        models?: CodexModelInfo[];
        error?: string;
      } | null;
      if (!res.ok) throw new Error(body?.error ?? `HTTP ${res.status}`);
      const result = {
        models: Array.isArray(body?.models) ? body.models : [],
        error: "",
      };
      codexModelsCache.set(key, result);
      return result;
    } catch (e) {
      return {
        models: [],
        error: e instanceof Error ? e.message : String(e),
      };
    } finally {
      codexModelsInFlight.delete(key);
    }
  })();
  codexModelsInFlight.set(key, promise);
  return promise;
}
