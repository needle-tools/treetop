/**
 * Fetch OpenAI Codex usage from ChatGPT's internal `wham/usage`
 * endpoint. This is the data backing the rate-limit / plan-type
 * surface inside the Codex CLI — same pattern as Claude's
 * `/api/oauth/usage` but on the OpenAI side.
 *
 *   GET https://chatgpt.com/backend-api/wham/usage
 *   Authorization:        Bearer <accessToken>
 *   ChatGPT-Account-Id:   <accountId> (optional but recommended)
 *   User-Agent:           codexbar-compatible
 *
 * The endpoint is undocumented and reverse-engineered from the Codex
 * CLI; treat shape changes as expected. Best-effort: any failure
 * returns null so the chip falls back to local JSONL counts.
 *
 * Token handling: the OAuth token lives in `~/.codex/auth.json`. We
 * read it on each cache miss, use it for one HTTPS call, and let the
 * local binding go out of scope — never persisted, never logged.
 *
 * Reference: steipete/CodexBar
 * (Sources/CodexBarCore/Providers/Codex/CodexOAuth/CodexOAuthUsageFetcher.swift
 * and CodexOAuthCredentials.swift).
 */

import { readFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";

const USAGE_URL = "https://chatgpt.com/backend-api/wham/usage";
const USER_AGENT = "supergit-agent-usage/1.0 (+https://github.com/needle-tools/supergit)";

export interface CodexWindowSnapshot {
  /** Integer 0..100 (NOT 0..1 like Anthropic's). Decoder normalizes to
   *  0..1 so the rest of the codebase has one convention. */
  utilization: number;
  /** ISO timestamp when the window resets. The API ships a unix
   *  seconds-since-epoch; the decoder formats it as ISO. */
  resetsAt?: string;
  /** Width of the rate-limit window in seconds (e.g. 18000 for 5h). */
  windowSeconds?: number;
}

export interface CodexCreditDetails {
  hasCredits: boolean;
  unlimited: boolean;
  balance?: number;
}

export interface CodexOAuthUsage {
  /** Marketing plan name: "free" / "plus" / "pro" / "business" / etc.
   *  Pass-through string — UI can show it as-is. */
  planType?: string;
  /** The 5h-ish primary rate-limit window (mirrors Claude's
   *  `fiveHour`). */
  primaryWindow?: CodexWindowSnapshot;
  /** The longer (typically weekly) secondary window. */
  secondaryWindow?: CodexWindowSnapshot;
  /** API-credit balance (separate from the plan rate limits). */
  credits?: CodexCreditDetails;
  /** ISO timestamp of when the data was fetched. */
  fetchedAt: string;
}

export type CodexOAuthUsageError =
  | { kind: "no-credentials" }
  | { kind: "unauthorized" }
  | { kind: "network"; message: string }
  | { kind: "server"; status: number; body?: string }
  | { kind: "decode"; message: string };

export interface CodexOAuthUsageResult {
  usage: CodexOAuthUsage | null;
  error: CodexOAuthUsageError | null;
}

interface RawAuth {
  OPENAI_API_KEY?: string;
  tokens?: {
    access_token?: string;
    accessToken?: string;
    account_id?: string;
    accountId?: string;
  };
}

interface ReadAuthOk {
  token: string;
  accountId: string | null;
}

async function readAuth(): Promise<ReadAuthOk | { error: CodexOAuthUsageError }> {
  const path = join(homedir(), ".codex", "auth.json");
  let content: string;
  try {
    content = await readFile(path, "utf-8");
  } catch {
    return { error: { kind: "no-credentials" } };
  }
  let parsed: RawAuth;
  try {
    parsed = JSON.parse(content) as RawAuth;
  } catch {
    return { error: { kind: "no-credentials" } };
  }
  // OpenAI API key path — older Codex installs ship a raw API key
  // instead of an OAuth token. We don't currently use this against the
  // wham/usage endpoint (it expects an OAuth Bearer); treat as "no
  // OAuth creds" so the chip falls back to local counts gracefully.
  if (
    typeof parsed.OPENAI_API_KEY === "string" &&
    parsed.OPENAI_API_KEY.trim() &&
    !parsed.tokens
  ) {
    return { error: { kind: "no-credentials" } };
  }
  const tokens = parsed.tokens;
  if (!tokens || typeof tokens !== "object") {
    return { error: { kind: "no-credentials" } };
  }
  const token =
    (typeof tokens.access_token === "string" && tokens.access_token) ||
    (typeof tokens.accessToken === "string" && tokens.accessToken) ||
    null;
  if (!token) return { error: { kind: "no-credentials" } };
  const accountId =
    (typeof tokens.account_id === "string" && tokens.account_id) ||
    (typeof tokens.accountId === "string" && tokens.accountId) ||
    null;
  return { token, accountId };
}

function decodeWindow(raw: unknown): CodexWindowSnapshot | undefined {
  if (!raw || typeof raw !== "object") return undefined;
  const r = raw as Record<string, unknown>;
  const used = r.used_percent;
  if (typeof used !== "number") return undefined;
  const resetUnix = typeof r.reset_at === "number" ? r.reset_at : undefined;
  const windowSeconds =
    typeof r.limit_window_seconds === "number" ? r.limit_window_seconds : undefined;
  // Normalize to 0..1 to match the rest of the codebase's "ratio" idiom.
  return {
    utilization: used / 100,
    resetsAt: resetUnix ? new Date(resetUnix * 1000).toISOString() : undefined,
    windowSeconds,
  };
}

function decodeUsage(json: unknown): CodexOAuthUsage | null {
  if (!json || typeof json !== "object") return null;
  const obj = json as Record<string, unknown>;
  const rl = obj.rate_limit as Record<string, unknown> | undefined;
  const credits = obj.credits as Record<string, unknown> | undefined;
  return {
    planType: typeof obj.plan_type === "string" ? obj.plan_type : undefined,
    primaryWindow: rl ? decodeWindow(rl.primary_window) : undefined,
    secondaryWindow: rl ? decodeWindow(rl.secondary_window) : undefined,
    credits: credits
      ? {
          hasCredits:
            typeof credits.has_credits === "boolean" ? credits.has_credits : false,
          unlimited:
            typeof credits.unlimited === "boolean" ? credits.unlimited : false,
          balance:
            typeof credits.balance === "number"
              ? credits.balance
              : typeof credits.balance === "string"
                ? Number(credits.balance)
                : undefined,
        }
      : undefined,
    fetchedAt: new Date().toISOString(),
  };
}

export interface CodexFetchOptions {
  fetcher?: (url: string, init: RequestInit) => Promise<Response>;
}

export async function fetchCodexOAuthUsage(
  opts: CodexFetchOptions = {},
): Promise<CodexOAuthUsageResult> {
  const auth = await readAuth();
  if ("error" in auth) return { usage: null, error: auth.error };

  const fetchFn = opts.fetcher ?? fetch;
  const headers: Record<string, string> = {
    Authorization: `Bearer ${auth.token}`,
    Accept: "application/json",
    "User-Agent": USER_AGENT,
  };
  if (auth.accountId) headers["ChatGPT-Account-Id"] = auth.accountId;

  let res: Response;
  try {
    res = await fetchFn(USAGE_URL, { method: "GET", headers });
  } catch (e) {
    const message = e instanceof Error ? e.message : String(e);
    return { usage: null, error: { kind: "network", message } };
  }
  if (res.status === 401 || res.status === 403) {
    return { usage: null, error: { kind: "unauthorized" } };
  }
  if (res.status < 200 || res.status >= 300) {
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

export const _internal = { decodeUsage, decodeWindow };
