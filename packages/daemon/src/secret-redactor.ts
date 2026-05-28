/**
 * Belt-and-braces secret redactor for the session-share send pipeline.
 * Runs AFTER tool-output stripping; targets the cases stripping
 * doesn't reach: a key the user pasted into a prompt, a Bearer header
 * in a tool-call argument, a PEM blob in an assistant message.
 *
 * High-precision patterns only. We accept false positives (worst case
 * a non-secret string gets redacted) to avoid false negatives on
 * recognisable formats. This is NOT a security guarantee — the plan's
 * privacy story still rests on tool-output stripping + LAN-only
 * transport. This layer just catches the obvious leaks.
 */

export interface Redaction {
  kind: string;
  count: number;
}

export interface RedactResult {
  text: string;
  redactions: Redaction[];
}

interface Pattern {
  kind: string;
  re: RegExp;
}

/** Order matters: more-specific prefixes (sk-ant-, sk-proj-) run
 *  before the generic `sk-<48>` legacy OpenAI shape, otherwise the
 *  generic one swallows the specific ones. */
const PATTERNS: Pattern[] = [
  // Anthropic
  { kind: "anthropic_api_key", re: /sk-ant-api03-[A-Za-z0-9_-]{40,}/g },
  // OpenAI
  { kind: "openai_project_key", re: /sk-proj-[A-Za-z0-9_-]{20,}/g },
  { kind: "openai_legacy_key", re: /sk-[A-Za-z0-9]{48}/g },
  // GitHub
  { kind: "github_pat", re: /github_pat_[A-Za-z0-9_]{22}_[A-Za-z0-9]{59}/g },
  { kind: "github_token", re: /gh[posur]_[A-Za-z0-9]{36,}/g },
  // npm
  { kind: "npm_token", re: /\bnpm_[A-Za-z0-9]{36}\b/g },
  // AWS
  { kind: "aws_access_key_id", re: /\bAKIA[0-9A-Z]{16}\b/g },
  // Slack
  { kind: "slack_token", re: /\bxox[baprs]-[A-Za-z0-9-]{10,}\b/g },
  // Google
  { kind: "google_api_key", re: /\bAIza[0-9A-Za-z_-]{35}\b/g },
  // Stripe
  {
    kind: "stripe_secret_key",
    re: /\b(?:sk|rk)_(?:live|test)_[A-Za-z0-9]{20,}\b/g,
  },
  // JWT (three base64url segments)
  {
    kind: "jwt",
    re: /\beyJ[A-Za-z0-9_-]{8,}\.eyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\b/g,
  },
  // PEM private key (multi-line — single regex with [\s\S])
  {
    kind: "private_key_block",
    re: /-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?-----END [A-Z ]*PRIVATE KEY-----/g,
  },
];

export function redactLikelySecrets(text: string): RedactResult {
  if (!text) return { text: "", redactions: [] };

  const counts = new Map<string, number>();
  let out = text;
  for (const { kind, re } of PATTERNS) {
    out = out.replace(re, () => {
      counts.set(kind, (counts.get(kind) ?? 0) + 1);
      return `[REDACTED:${kind}]`;
    });
  }

  const redactions: Redaction[] = [];
  for (const [kind, count] of counts) {
    redactions.push({ kind, count });
  }
  return { text: out, redactions };
}
