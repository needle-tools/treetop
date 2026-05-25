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
import { homedir, platform } from "node:os";
import { join } from "node:path";
import { spawn } from "node:child_process";

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
 *  still returns the rest of the report.
 *
 *  Every step in `readAccessToken` used to collapse into `no-credentials`,
 *  which lied when the file existed but failed to parse or had an
 *  unexpected shape. Distinguishing the kinds lets the UI surface a
 *  helpful hint ("file is malformed", "permission denied", etc.) so
 *  diagnosing the macOS path-mismatch / permission cases doesn't
 *  require the user to attach a debugger. */
export type OAuthUsageError =
  | { kind: "no-credentials"; checkedPath: string }
  | { kind: "credentials-unreadable"; checkedPath: string; message: string }
  | { kind: "credentials-malformed"; checkedPath: string; message: string }
  | { kind: "credentials-schema"; checkedPath: string; message: string }
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

/** Known on-disk locations Claude Code may store its OAuth token at.
 *  Windows/Linux land at the first one; older or alternate macOS
 *  installs sometimes use the Library Application Support copy. We
 *  probe each in order until one parses successfully — the first match
 *  wins regardless of platform. */
function candidateCredentialPaths(): string[] {
  const home = homedir();
  const paths = [
    join(home, ".claude", ".credentials.json"),
    join(home, ".claude", "credentials.json"),
    join(home, "Library", "Application Support", "Claude", ".credentials.json"),
    join(home, "Library", "Application Support", "Claude", "credentials.json"),
    join(home, ".config", "claude", ".credentials.json"),
    join(home, ".config", "claude", "credentials.json"),
  ];
  // De-dupe while preserving order (same path can resolve identically
  // on case-insensitive filesystems).
  const seen = new Set<string>();
  return paths.filter((p) => {
    if (seen.has(p)) return false;
    seen.add(p);
    return true;
  });
}

/** macOS Keychain fallback. Claude Code on macOS stores the OAuth
 *  token in the Keychain under the "Claude Code-credentials" service
 *  rather than (or in addition to) a JSON file. CodexBar uses the same
 *  approach via `/usr/bin/security find-generic-password -w`. We only
 *  run this on darwin and only after the file probes turn up empty,
 *  so non-macOS hosts pay nothing for the import.
 *
 *  Output is either:
 *    - a plain token followed by a newline on success
 *    - a non-zero exit with an `errSecItemNotFound`-style message on
 *      a missing item
 *    - non-zero with `user interaction is not allowed` if ACL gating
 *      requires a GUI prompt and the daemon isn't attached to one
 *
 *  The token contents are never logged; only metadata about how the
 *  read went. */
async function readMacOSKeychainToken(): Promise<
  { token: string } | { error: OAuthUsageError }
> {
  return await new Promise((resolve) => {
    let child: ReturnType<typeof spawn>;
    try {
      child = spawn(
        "/usr/bin/security",
        ["find-generic-password", "-s", "Claude Code-credentials", "-w"],
        { stdio: ["ignore", "pipe", "pipe"] },
      );
    } catch (e) {
      resolve({
        error: {
          kind: "credentials-unreadable",
          checkedPath: "keychain://Claude Code-credentials",
          message: e instanceof Error ? e.message : String(e),
        },
      });
      return;
    }
    let out = "";
    let err = "";
    child.stdout?.on("data", (b: Buffer) => {
      out += b.toString("utf-8");
    });
    child.stderr?.on("data", (b: Buffer) => {
      err += b.toString("utf-8");
    });
    child.on("error", (e) => {
      resolve({
        error: {
          kind: "credentials-unreadable",
          checkedPath: "keychain://Claude Code-credentials",
          message: e.message,
        },
      });
    });
    child.on("close", (code) => {
      if (code === 0) {
        const token = out.replace(/\r?\n$/, "").trim();
        if (!token) {
          resolve({
            error: {
              kind: "credentials-schema",
              checkedPath: "keychain://Claude Code-credentials",
              message: "security CLI returned exit 0 but no token",
            },
          });
          return;
        }
        // If the keychain stores the JSON blob (not the raw token),
        // try to parse and extract the OAuth access token. Otherwise
        // pass the value through verbatim.
        if (token.startsWith("{")) {
          try {
            const parsed = JSON.parse(token) as RawCredentials;
            const oauth = parsed.claudeAiOauth;
            if (oauth && typeof oauth.accessToken === "string") {
              if (
                typeof oauth.expiresAt === "number" &&
                oauth.expiresAt < Date.now()
              ) {
                resolve({ error: { kind: "expired" } });
                return;
              }
              resolve({ token: oauth.accessToken });
              return;
            }
            resolve({
              error: {
                kind: "credentials-schema",
                checkedPath: "keychain://Claude Code-credentials",
                message:
                  "Keychain payload parsed as JSON but lacks claudeAiOauth.accessToken",
              },
            });
            return;
          } catch (e) {
            resolve({
              error: {
                kind: "credentials-malformed",
                checkedPath: "keychain://Claude Code-credentials",
                message:
                  "Keychain payload looked like JSON but failed to parse: " +
                  (e instanceof Error ? e.message : String(e)),
              },
            });
            return;
          }
        }
        resolve({ token });
        return;
      }
      const stderrSnippet = err.trim().slice(0, 200);
      if (stderrSnippet.includes("could not be found")) {
        resolve({
          error: {
            kind: "no-credentials",
            checkedPath: "keychain://Claude Code-credentials",
          },
        });
        return;
      }
      resolve({
        error: {
          kind: "credentials-unreadable",
          checkedPath: "keychain://Claude Code-credentials",
          message: stderrSnippet || `security exit ${code}`,
        },
      });
    });
  });
}

async function readAccessToken(): Promise<
  { token: string } | { error: OAuthUsageError }
> {
  const candidates = candidateCredentialPaths();
  const tried: string[] = [];
  let lastFsError: { path: string; message: string } | null = null;
  let lastMalformed: { path: string; message: string } | null = null;
  let lastSchema: { path: string; message: string } | null = null;

  for (const checkedPath of candidates) {
    tried.push(checkedPath);
    let content: string;
    try {
      content = await readFile(checkedPath, "utf-8");
    } catch (e) {
      const err = e as NodeJS.ErrnoException;
      if (err && err.code === "ENOENT") continue; // try next candidate
      lastFsError = {
        path: checkedPath,
        message: err?.message || String(e),
      };
      continue;
    }
    let parsed: RawCredentials;
    try {
      parsed = JSON.parse(content) as RawCredentials;
    } catch (e) {
      lastMalformed = {
        path: checkedPath,
        message: e instanceof Error ? e.message : String(e),
      };
      continue;
    }
    const oauth = parsed.claudeAiOauth;
    if (!oauth || typeof oauth.accessToken !== "string") {
      lastSchema = {
        path: checkedPath,
        message:
          "JSON parsed but `claudeAiOauth.accessToken` is missing — file format may have changed.",
      };
      continue;
    }
    if (typeof oauth.expiresAt === "number" && oauth.expiresAt < Date.now()) {
      // Don't refresh here — CodexBar runs a separate refresh
      // coordinator; that's a follow-up. Report expiry so the UI can
      // prompt re-auth.
      return { error: { kind: "expired" } };
    }
    return { token: oauth.accessToken };
  }

  // On macOS, fall through to the Keychain if no file produced a
  // token. Claude Code there stores the OAuth blob in the Keychain
  // under "Claude Code-credentials"; if the ACL on the item is
  // permissive (the common case for items created by Anthropic's
  // installer), `security find-generic-password -w` reads it without
  // a GUI dialog. Restricted ACLs error with "user interaction not
  // allowed", which we surface via credentials-unreadable.
  if (platform() === "darwin") {
    const keychain = await readMacOSKeychainToken();
    if ("token" in keychain) return keychain;
    // Only return the Keychain error if it's more informative than
    // "no credentials at <paths>". Schema/malformed/unreadable beat
    // a vanilla not-found from the file probes.
    if (
      keychain.error.kind === "credentials-schema" ||
      keychain.error.kind === "credentials-malformed" ||
      keychain.error.kind === "credentials-unreadable" ||
      keychain.error.kind === "expired"
    ) {
      return keychain;
    }
    // Keychain also said not-found → fall through and report the
    // combined no-credentials below (file paths + the keychain).
    tried.push("keychain://Claude Code-credentials");
  }

  // Nothing usable in any candidate path. Prefer reporting the most
  // specific failure mode we saw (schema > malformed > unreadable >
  // no-credentials) so the user has actionable info.
  if (lastSchema) {
    return {
      error: {
        kind: "credentials-schema",
        checkedPath: lastSchema.path,
        message: lastSchema.message,
      },
    };
  }
  if (lastMalformed) {
    return {
      error: {
        kind: "credentials-malformed",
        checkedPath: lastMalformed.path,
        message: lastMalformed.message,
      },
    };
  }
  if (lastFsError) {
    return {
      error: {
        kind: "credentials-unreadable",
        checkedPath: lastFsError.path,
        message: lastFsError.message,
      },
    };
  }
  // All candidates returned ENOENT — surface the full list so a user on
  // a not-yet-supported path can paste it back and we can extend
  // `candidateCredentialPaths()` in one round.
  return {
    error: {
      kind: "no-credentials",
      checkedPath: tried.join(", "),
    },
  };
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
      // `resets_at` can arrive as an ISO string ("2026-05-27T02:00:00Z")
      // OR a unix timestamp number (seconds since epoch). Normalize to
      // an ISO string with explicit UTC suffix so the UI's Date.parse
      // interprets it unambiguously regardless of browser timezone
      // defaults. CodexBar's decoder handles the same ambiguity.
      let resetsAt: string | undefined;
      if (typeof r.resets_at === "number") {
        resetsAt = new Date(r.resets_at * 1000).toISOString();
      } else if (typeof r.resets_at === "string") {
        // Ensure the string has a timezone — if it's bare like
        // "2026-05-26T23:00:00" (no Z, no offset), Date.parse
        // interprets it as local time in some engines and UTC in
        // others. Append Z when no offset marker is present.
        const s = r.resets_at;
        if (/\d{4}-\d{2}-\d{2}T\d{2}:\d{2}/.test(s) && !/[Zz+\-]\d{0,4}$/.test(s)) {
          resetsAt = s + "Z";
        } else {
          resetsAt = s;
        }
      }
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
