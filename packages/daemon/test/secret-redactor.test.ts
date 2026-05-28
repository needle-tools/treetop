/**
 * Secret-redaction layer. Pure function over a JSONL string. Runs
 * AFTER tool-output stripping on the send pipeline as belt-and-braces
 * cover for secrets that ended up in text / thinking / tool_use blocks
 * (where stripping doesn't reach).
 *
 * High-precision patterns only — false positives are tolerable (worst
 * case we redact a non-secret), but false negatives on common,
 * unambiguous key formats are what we're trying to prevent.
 *
 * This is NOT a security guarantee. Documented as such in the plan.
 */

import { test, expect, describe } from "bun:test";
import { redactLikelySecrets } from "../src/secret-redactor";

function totalCount(out: ReturnType<typeof redactLikelySecrets>): number {
  return out.redactions.reduce((n, r) => n + r.count, 0);
}

describe("redactLikelySecrets — covered key formats", () => {
  test("Anthropic API key (sk-ant-api03-...)", () => {
    const k = "sk-ant-api03-" + "a".repeat(95);
    const r = redactLikelySecrets(`hello ${k} world`);
    expect(r.text.includes(k)).toBe(false);
    expect(r.text.includes("[REDACTED:anthropic_api_key]")).toBe(true);
    expect(totalCount(r)).toBe(1);
  });

  test("OpenAI project key (sk-proj-...)", () => {
    const k = "sk-proj-" + "b".repeat(60);
    const r = redactLikelySecrets(k);
    expect(r.text).toBe("[REDACTED:openai_project_key]");
  });

  test("OpenAI legacy key (sk- + 48 alphanumerics)", () => {
    const k = "sk-" + "C".repeat(48);
    const r = redactLikelySecrets(k);
    expect(r.text).toBe("[REDACTED:openai_legacy_key]");
  });

  test("GitHub personal access token (ghp_...)", () => {
    const k = "ghp_" + "x".repeat(36);
    const r = redactLikelySecrets(k);
    expect(r.text).toBe("[REDACTED:github_token]");
  });

  test("npm token (npm_ + 36 alphanumerics)", () => {
    const k = "npm_" + "Q".repeat(36);
    const r = redactLikelySecrets(k);
    expect(r.text).toBe("[REDACTED:npm_token]");
  });

  test("GitHub fine-grained PAT (github_pat_...)", () => {
    const k = "github_pat_" + "A".repeat(22) + "_" + "B".repeat(59);
    const r = redactLikelySecrets(k);
    expect(r.text).toBe("[REDACTED:github_pat]");
  });

  test("AWS access key id (AKIA + 16)", () => {
    const k = "AKIAIOSFODNN7EXAMPLE";
    const r = redactLikelySecrets(k);
    expect(r.text).toBe("[REDACTED:aws_access_key_id]");
  });

  test("Slack tokens (xoxb-, xoxp-, xoxa-)", () => {
    const cases = [
      "xoxb-" + "1".repeat(10) + "-abc",
      "xoxp-" + "2".repeat(10) + "-def",
      "xoxa-" + "3".repeat(10) + "-ghi",
    ];
    for (const k of cases) {
      const r = redactLikelySecrets(k);
      expect(r.text).toBe("[REDACTED:slack_token]");
    }
  });

  test("Google API key (AIza...)", () => {
    const k = "AIza" + "Z".repeat(35);
    const r = redactLikelySecrets(k);
    expect(r.text).toBe("[REDACTED:google_api_key]");
  });

  test("Stripe live + test keys", () => {
    const live = "sk_live_" + "A".repeat(30);
    const testk = "sk_test_" + "B".repeat(30);
    expect(redactLikelySecrets(live).text).toBe("[REDACTED:stripe_secret_key]");
    expect(redactLikelySecrets(testk).text).toBe(
      "[REDACTED:stripe_secret_key]",
    );
  });

  test("JWT (three base64url segments separated by dots)", () => {
    const jwt =
      "eyJhbGciOiJIUzI1NiJ9." +
      "eyJzdWIiOiIxMjM0NTY3ODkwIiwiaWF0IjoxNTE2MjM5MDIyfQ." +
      "SflKxwRJSMeKKF2QT4fwpMeJf36POk6yJV_adQssw5c";
    const r = redactLikelySecrets(`token=${jwt}`);
    expect(r.text.includes(jwt)).toBe(false);
    expect(r.text.includes("[REDACTED:jwt]")).toBe(true);
  });

  test("PEM private key block", () => {
    const pem =
      "-----BEGIN RSA PRIVATE KEY-----\n" +
      "MIIEpAIBAAKCAQEA1234567890...\n" +
      "-----END RSA PRIVATE KEY-----";
    const r = redactLikelySecrets(`before\n${pem}\nafter`);
    expect(r.text.includes("MIIEpAIBA")).toBe(false);
    expect(r.text.includes("[REDACTED:private_key_block]")).toBe(true);
    expect(r.text.includes("before")).toBe(true);
    expect(r.text.includes("after")).toBe(true);
  });
});

describe("redactLikelySecrets — counts and reporting", () => {
  test("reports per-kind counts", () => {
    const input = [
      "sk-ant-api03-" + "a".repeat(95),
      "ghp_" + "x".repeat(36),
      "ghp_" + "y".repeat(36),
    ].join("\n");
    const r = redactLikelySecrets(input);
    const byKind = Object.fromEntries(
      r.redactions.map((x) => [x.kind, x.count]),
    );
    expect(byKind.anthropic_api_key).toBe(1);
    expect(byKind.github_token).toBe(2);
  });

  test("input with no secrets returns text unchanged and empty report", () => {
    const input = "hello world\nthe quick brown fox jumps over the lazy dog";
    const r = redactLikelySecrets(input);
    expect(r.text).toBe(input);
    expect(r.redactions).toEqual([]);
  });

  test("empty input → empty output", () => {
    const r = redactLikelySecrets("");
    expect(r.text).toBe("");
    expect(r.redactions).toEqual([]);
  });
});

describe("redactLikelySecrets — false-positive guards", () => {
  test("`sk-` without 48-char body is NOT redacted (avoids prose hits)", () => {
    const r = redactLikelySecrets("sk- letter and the abbreviation sk-do");
    expect(r.text.includes("[REDACTED")).toBe(false);
  });

  test("`AKIA` not followed by exactly 16 caps+digits is NOT redacted", () => {
    const r = redactLikelySecrets("AKIA is the prefix; AKIAshort");
    expect(r.text.includes("[REDACTED")).toBe(false);
  });

  test("`eyJ...` alone (one segment) is not enough — JWT needs three", () => {
    const r = redactLikelySecrets("eyJhbGciOiJIUzI1NiJ9 by itself");
    expect(r.text.includes("[REDACTED")).toBe(false);
  });

  test("the word 'token' alone is not redacted", () => {
    const r = redactLikelySecrets(
      "authentication tokens are issued per request",
    );
    expect(r.text.includes("[REDACTED")).toBe(false);
  });
});

describe("redactLikelySecrets — JSON safety", () => {
  test("redactions don't break surrounding JSON shape (string-level only)", () => {
    const k = "ghp_" + "Z".repeat(36);
    const input = JSON.stringify({ env: { GITHUB_TOKEN: k } });
    const r = redactLikelySecrets(input);
    // Still parseable as JSON
    const parsed = JSON.parse(r.text);
    expect(parsed.env.GITHUB_TOKEN).toBe("[REDACTED:github_token]");
  });
});
