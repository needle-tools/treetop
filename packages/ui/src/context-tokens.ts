/**
 * Format the "context size" chip rendered in each SessionView header.
 *
 * Inputs come from the daemon's pre-scanned agent metadata:
 *   - `tokens`   — number of tokens currently in the agent's context
 *   - `exact`    — true if `tokens` came from a real `usage` block
 *                  (Claude); false if it's a chars/4 estimate (Codex)
 *   - `model`    — model id, used to pick a context-window cap
 *
 * The chip reads like `42.1k / 200k ctx (21%)` for Claude, or
 * `~42.1k / 200k ctx (21%)` for Codex (note the leading `~` to flag
 * that the absolute number is approximate). When we can't infer a cap
 * for the model we fall back to absolute-only: `42.1k ctx`.
 */

export interface ContextChipInput {
  tokens: number | undefined;
  exact: boolean | undefined;
  model: string | undefined;
  /** Used when `model` is undefined — lets the UI fall back to a sensible
   *  per-agent default cap (Claude → 200k, Codex → 200k). */
  agent?: "claude" | "codex" | "copilot";
}

export interface ContextChip {
  text: string;
  /** 0..1, undefined when no cap is known. The header colors the chip
   *  amber past 0.75 and red past 0.9. */
  ratio: number | undefined;
  exact: boolean;
}

/** Pick a context-window cap (in tokens) for the given model id. Returns
 *  undefined for unknown models so the chip can fall back to absolute-only.
 *
 *  Claude:
 *    - any id with `1m` / `[1m]` → 1,000,000
 *    - everything else (Sonnet, Opus, Haiku) → 200,000
 *  Codex / OpenAI: default to 200,000 — gpt-5-codex and gpt-4.1 are both
 *  in that ballpark; we don't try to be exact here since the absolute
 *  number is already a chars/4 estimate. */
export function modelContextCap(
  model: string | undefined,
  agent: "claude" | "codex" | "copilot" | undefined,
): number | undefined {
  const id = (model ?? "").toLowerCase();
  if (id.includes("1m") || id.includes("[1m]")) return 1_000_000;
  if (id.startsWith("claude")) return 200_000;
  if (id.startsWith("gpt-") || id.startsWith("o1") || id.startsWith("o3"))
    return 200_000;
  if (agent === "claude") return 200_000;
  if (agent === "codex") return 200_000;
  return undefined;
}

/** Format a token count as a compact label: 952 → "952", 4 321 → "4.3k",
 *  152 000 → "152k", 1 050 000 → "1.05M". Drops trailing zeros so we don't
 *  get "42.0k". */
export function formatTokens(n: number): string {
  if (!Number.isFinite(n) || n < 0) return "0";
  if (n < 1000) return String(Math.round(n));
  if (n < 1_000_000) {
    const k = n / 1000;
    // 1 decimal under 100k for precision (42.1k), drop it above for density (152k).
    const s = k < 100 ? k.toFixed(1) : Math.round(k).toString();
    return `${s.replace(/\.0$/, "")}k`;
  }
  const m = n / 1_000_000;
  const s = m < 10 ? m.toFixed(2) : m.toFixed(1);
  return `${s.replace(/\.?0+$/, "")}M`;
}

/** Build the chip. Returns null when there's nothing useful to show
 *  (no token count). The caller renders `.text` as-is and uses `.ratio`
 *  for color thresholding. */
export function contextChip(input: ContextChipInput): ContextChip | null {
  const { tokens, exact, model, agent } = input;
  if (tokens === undefined || tokens <= 0) return null;
  const cap = modelContextCap(model, agent);
  const prefix = exact === false ? "~" : "";
  const absolute = `${prefix}${formatTokens(tokens)}`;
  if (cap === undefined) {
    return { text: `${absolute} ctx`, ratio: undefined, exact: exact !== false };
  }
  const ratio = tokens / cap;
  const pct = Math.round(ratio * 100);
  return {
    text: `${absolute} / ${formatTokens(cap)} ctx (${pct}%)`,
    ratio,
    exact: exact !== false,
  };
}
