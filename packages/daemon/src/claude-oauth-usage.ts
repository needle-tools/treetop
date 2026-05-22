/**
 * Fetch Claude plan usage straight from Anthropic's undocumented OAuth
 * usage endpoint. This is the same data backing the
 * "Plan-Nutzungslimits" page at https://claude.ai — five-hour session
 * % + reset, weekly % + reset, plus per-model breakdowns (Sonnet,
 * Opus, Design, Routines) and the optional extra-usage credit pool.
 *
 *   GET https://api.anthropic.com/api/oauth/usage
 *   Authorization: Bearer <accessToken>
 *   anthropic-beta:  oauth-2025-04-20
 *   User-Agent:      claude-code/<version>
 *
 * The endpoint is undocumented and gated by the beta header — Anthropic
 * could change shape or drop it without notice. We treat the call as
 * best-effort: any failure returns null so the chip falls back to the
 * local JSONL counts. Reference: steipete/CodexBar
 * (Sources/CodexBarCore/Providers/Claude/ClaudeOAuth/ClaudeOAuthUsageFetcher.swift).
 *
 * Token handling: the OAuth token lives in `~/.claude/.credentials.json`.
 * We read it on each cache miss, use it for one HTTPS call, and let
 * the local binding go out of scope — never persisted, never logged.
 */

import { readFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";

const BASE_URL = "https://api.anthropic.com";
const USAGE_PATH = "/api/oauth/usage";
const BETA_HEADER = "oauth-2025-04-20";
/** Pinned fallback when we can't detect the installed claude version.
 *  Anthropic uses the UA to identify clients but doesn't gate on it. */
const FALLBACK_VERSION = "2.1.0";

export interface OAuthUsageWindow {
  /** 0..1; 0.41 means 41% of the window's budget consumed. */
  utilization: number;
  /** ISO timestamp when the window resets. Optional in older payloads. */
  resetsAt?: string;
}

export interface OAuthExtraUsage {
  isEnabled?: boolean;
  monthlyLimit?: number;
  usedCredits?: number;
  utilization?: number;
  currency?: string;
}

export interface ClaudeOAuthUsage {
  /** Current 5-hour session bar. Matches claude.ai "Aktuelle Sitzung". */
  fiveHour?: OAuthUsageWindow;
  /** Rolling 7-day, all models. Matches "Wöchentliche Limits — Alle Modelle". */
  sevenDay?: OAuthUsageWindow;
  /** Rolling 7-day, Sonnet only. Matches "Nur Sonnet". */
  sevenDaySonnet?: OAuthUsageWindow;
  /** Rolling 7-day, Opus only. */
  sevenDayOpus?: OAuthUsageWindow;
  /** Rolling 7-day, "Claude Design" (a feature-flag bucket; shown only
   *  for accounts that have access). */
  sevenDayDesign?: OAuthUsageWindow;
  /** Rolling 7-day, "Claude Routines" (same caveat). */
  sevenDayRoutines?: OAuthUsageWindow;
  /** Extra-usage credit pool (paid overage above plan limits). */
  extraUsage?: OAuthExtraUsage;
  /** ISO timestamp the data was fetched at — surfaced in the UI footer
   *  so a stale cached value can be distinguished from a fresh one. */
  fetchedAt: string;
}

/** What the fetcher reports back on failure. The route logs this but
 *  still returns the rest of the report. */
export type OAuthUsageError =
  | { kind: "no-credentials" }
  | { kind: "unauthorized" }
  | { kind: "expired" }
  | { kind: "network"; message: string }
  | { kind: "server"; status: number; body?: string }
  | { kind: "decode"; message: string };

export interface OAuthUsageResult {
  usage: ClaudeOAuthUsage | null;
  error: OAuthUsageError | null;
}

interface RawCredentials {
  claudeAiOauth?: {
    accessToken?: string;
    expiresAt?: number;
  };
}

async function readAccessToken(): Promise<
  { token: string } | { error: OAuthUsageError }
> {
  const path = join(homedir(), ".claude", ".credentials.json");
  let content: string;
  try {
    content = await readFile(path, "utf-8");
  } catch {
    return { error: { kind: "no-credentials" } };
  }
  let parsed: RawCredentials;
  try {
    parsed = JSON.parse(content) as RawCredentials;
  } catch {
    return { error: { kind: "no-credentials" } };
  }
  const oauth = parsed.claudeAiOauth;
  if (!oauth || typeof oauth.accessToken !== "string") {
    return { error: { kind: "no-credentials" } };
  }
  if (typeof oauth.expiresAt === "number" && oauth.expiresAt < Date.now()) {
    // Don't refresh here — CodexBar runs a separate refresh coordinator;
    // that's a follow-up. Report expiry so the UI can prompt re-auth.
    return { error: { kind: "expired" } };
  }
  return { token: oauth.accessToken };
}

/** Shape-tolerant decoder. Mirrors CodexBar's `DynamicCodingKey` walk:
 *  the API returns snake_case keys plus a few historical aliases for
 *  "design" and "routines". We try each candidate in order. */
function decodeUsage(json: unknown): ClaudeOAuthUsage | null {
  if (!json || typeof json !== "object") return null;
  const obj = json as Record<string, unknown>;
  const win = (...keys: string[]): OAuthUsageWindow | undefined => {
    for (const k of keys) {
      const raw = obj[k];
      if (!raw || typeof raw !== "object") continue;
      const r = raw as Record<string, unknown>;
      const util = r.utilization;
      if (typeof util !== "number") continue;
      const resetsAt = typeof r.resets_at === "string" ? r.resets_at : undefined;
      // Anthropic returns utilization as 0..100 (a percentage point,
      // not a fraction). Normalize here so every consumer can treat
      // `utilization` as 0..1 and the UI's "× 100 → %" is consistent
      // with every other ratio in the codebase.
      return { utilization: util / 100, resetsAt };
    }
    return undefined;
  };
  const extraRaw = obj["extra_usage"];
  const extra: OAuthExtraUsage | undefined =
    extraRaw && typeof extraRaw === "object"
      ? (() => {
          const r = extraRaw as Record<string, unknown>;
          const out: OAuthExtraUsage = {};
          if (typeof r.is_enabled === "boolean") out.isEnabled = r.is_enabled;
          if (typeof r.monthly_limit === "number") out.monthlyLimit = r.monthly_limit;
          if (typeof r.used_credits === "number") out.usedCredits = r.used_credits;
          // Same 0..100 → 0..1 normalization as the window decoder.
          if (typeof r.utilization === "number") out.utilization = r.utilization / 100;
          if (typeof r.currency === "string") out.currency = r.currency;
          return Object.keys(out).length > 0 ? out : undefined;
        })()
      : undefined;
  return {
    fiveHour: win("five_hour"),
    sevenDay: win("seven_day"),
    sevenDaySonnet: win("seven_day_sonnet"),
    sevenDayOpus: win("seven_day_opus"),
    sevenDayDesign: win(
      "seven_day_design",
      "seven_day_claude_design",
      "claude_design",
      "design",
    ),
    sevenDayRoutines: win(
      "seven_day_routines",
      "seven_day_claude_routines",
      "claude_routines",
      "routines",
      "routine",
    ),
    extraUsage: extra,
    fetchedAt: new Date().toISOString(),
  };
}

export interface FetchOptions {
  /** Override the fetcher in tests so we don't hit Anthropic. */
  fetcher?: (url: string, init: RequestInit) => Promise<Response>;
  /** Override the version reported in the User-Agent. */
  versionString?: string;
}

export async function fetchClaudeOAuthUsage(
  opts: FetchOptions = {},
): Promise<OAuthUsageResult> {
  const auth = await readAccessToken();
  if ("error" in auth) return { usage: null, error: auth.error };

  const fetchFn = opts.fetcher ?? fetch;
  const ua = `claude-code/${(opts.versionString ?? FALLBACK_VERSION).trim() || FALLBACK_VERSION}`;
  let res: Response;
  try {
    res = await fetchFn(BASE_URL + USAGE_PATH, {
      method: "GET",
      headers: {
        Authorization: `Bearer ${auth.token}`,
        Accept: "application/json",
        "Content-Type": "application/json",
        "anthropic-beta": BETA_HEADER,
        "User-Agent": ua,
      },
    });
  } catch (e) {
    const message = e instanceof Error ? e.message : String(e);
    return { usage: null, error: { kind: "network", message } };
  }
  if (res.status === 401) return { usage: null, error: { kind: "unauthorized" } };
  if (res.status !== 200) {
    const body = await res.text().catch(() => undefined);
    return {
      usage: null,
      error: { kind: "server", status: res.status, body },
    };
  }
  let data: unknown;
  try {
    data = await res.json();
  } catch (e) {
    const message = e instanceof Error ? e.message : String(e);
    return { usage: null, error: { kind: "decode", message } };
  }
  const decoded = decodeUsage(data);
  if (!decoded) {
    return {
      usage: null,
      error: { kind: "decode", message: "Unexpected payload shape" },
    };
  }
  return { usage: decoded, error: null };
}

// Exposed for tests.
export const _internal = { decodeUsage };
