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
  /** Authoritative cap if the JSONL itself shipped one (Codex 0.130+
   *  writes `info.model_context_window`). Takes precedence over the
   *  model-id heuristic — the file knows better than we do. */
  cap?: number | undefined;
}

export interface ContextChip {
  text: string;
  /** The "current size" part of `text`, on its own. Lets the header
   *  render it as an always-visible label while keeping the cap +
   *  percent in a hover-revealed suffix. Empty when there's no count
   *  yet (e.g., a brand-new TUI column). */
  absolute: string;
  /** The cap, formatted like `1M` / `200k`, or undefined when the model
   *  is unrecognised. Consumers render `???` themselves in that case so
   *  they can style the placeholder distinctly. */
  capText: string | undefined;
  /** 0..1, undefined when no cap is known. The header colors the chip
   *  amber past 0.75 and red past 0.9. */
  ratio: number | undefined;
  exact: boolean;
}

/** Pick a context-window cap (in tokens) for the given model id. Returns
 *  undefined for unknown models so the chip can fall back to absolute-only.
 *
 *  Source: https://platform.claude.com/docs/en/about-claude/models/overview
 *  (verified May 2026). Caps are tied to the Claude generation, not to a
 *  beta flag:
 *    - Opus / Sonnet 4.6 and 4.7 (current) → 1,000,000
 *    - Haiku 4.5 (current) → 200,000
 *    - Opus / Sonnet ≤ 4.5 (legacy) → 200,000
 *    - Older Opus 4.6 also got 1M per Anthropic's "legacy models" table
 *  An explicit `1m` / `[1m]` substring still overrides up to 1M for any
 *  hypothetical future beta variant.
 *  Codex / OpenAI: default to 200,000 — gpt-5-codex and gpt-4.1 are both
 *  in that ballpark; we don't try to be exact here since the absolute
 *  number is already a chars/4 estimate. */
export function modelContextCap(
  model: string | undefined,
  agent: "claude" | "codex" | "copilot" | undefined,
): number | undefined {
  const id = (model ?? "").toLowerCase();
  if (id.includes("1m") || id.includes("[1m]")) return 1_000_000;
  // Strip a trailing `-YYYYMMDD` date suffix so we don't confuse it
  // with a minor version. `claude-sonnet-4-20250514` is legacy Sonnet
  // 4 (no minor), not Sonnet 4.20250514.
  const stripped = id.replace(/-\d{8}$/, "");
  // claude-(opus|sonnet|haiku)-<major>(-<minor>)?
  const m = stripped.match(/^claude-(opus|sonnet|haiku)-(\d+)(?:-(\d+))?$/);
  if (m) {
    const family = m[1];
    const major = Number(m[2]);
    const minor = m[3] !== undefined ? Number(m[3]) : 0;
    if (family === "haiku") return 200_000;
    // Opus / Sonnet: 1M starting at the 4.6 generation, 200k below.
    if (major > 4 || (major === 4 && minor >= 6)) return 1_000_000;
    return 200_000;
  }
  // Unknown model id (and unknown provider): refuse to guess. The
  // chip renders `… / ??? ctx` in this case rather than fabricating a
  // denominator and a misleading percentage. Specifically we don't
  // default unknown Claude / Codex agents either — the rule is "we
  // know the cap or we don't."
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

/** Build the chip. The caller renders `.text` as-is and uses `.ratio`
 *  for color thresholding.
 *
 *  When `tokens` is undefined or 0 we still emit a zero-state chip
 *  (`0 / 200k ctx (0%)`) as long as a cap can be inferred — that's
 *  how brand-new TUI columns show a placeholder before the agent
 *  writes its first JSONL line. With neither a count nor a cap we
 *  truly have nothing to draw, so return null. */
export function contextChip(input: ContextChipInput): ContextChip | null {
  const { tokens, exact, model, agent, cap: explicitCap } = input;
  // Explicit cap from the JSONL trumps any model-id heuristic. We
  // accept it only when it's a positive finite number — a stray 0
  // or NaN slipping in must NOT silently turn into "unknown cap."
  const cap =
    typeof explicitCap === "number" && explicitCap > 0
      ? explicitCap
      : modelContextCap(model, agent);
  const empty = tokens === undefined || tokens <= 0;
  if (empty && cap === undefined) return null;
  const isExact = exact !== false;
  const prefix = !empty && exact === false ? "~" : "";
  const absolute = `${prefix}${formatTokens(empty ? 0 : tokens!)}`;
  if (cap === undefined) {
    // Unknown model AND unknown provider — don't fabricate a cap.
    // The chip shows `42.1k / ??? ctx`; ratio stays undefined so the
    // warn/hot color escalation is skipped.
    return {
      text: `${absolute} / ??? ctx`,
      absolute,
      capText: undefined,
      ratio: undefined,
      exact: isExact,
    };
  }
  const ratio = empty ? 0 : tokens! / cap;
  const pct = Math.round(ratio * 100);
  const capText = formatTokens(cap);
  return {
    text: `${absolute} / ${capText} ctx (${pct}%)`,
    absolute,
    capText,
    ratio,
    exact: isExact,
  };
}
