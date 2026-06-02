/**
 * Ollama installed-models fetch, extracted from App.svelte so the
 * fetch/parse/error-classification is unit-testable (inject `fetchImpl`).
 *
 * The caller owns the reactive loading/loaded/error flags; this function
 * just performs the request and returns a discriminated result. The
 * `reached` flag preserves App.svelte's original retry semantics:
 *   - success / daemon responded non-OK  -> caller marks "loaded" (no retry)
 *   - the request (or JSON parse) threw   -> `reached:false`, caller leaves
 *     "loaded" false so the next open retries.
 * Mirrors the daemon's `GET /api/ollama/models` contract.
 */

export interface OllamaModel {
  name: string;
  size?: number;
  parameterSize?: string;
}

export type OllamaModelsResult =
  | { ok: true; models: OllamaModel[] }
  | { ok: false; error: string; reached: boolean };

export async function fetchOllamaModels(
  fetchImpl: typeof fetch,
  url: string,
): Promise<OllamaModelsResult> {
  try {
    const res = await fetchImpl(url);
    if (!res.ok) {
      return { ok: false, error: `daemon returned ${res.status}`, reached: true };
    }
    const body = (await res.json()) as { models?: OllamaModel[] };
    return { ok: true, models: body.models ?? [] };
  } catch (e) {
    return {
      ok: false,
      error: e instanceof Error ? e.message : String(e),
      reached: false,
    };
  }
}
