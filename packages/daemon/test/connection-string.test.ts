import { test, expect, describe } from "bun:test";
import {
  encodeConnectionString,
  decodeConnectionString,
  CONNECTION_STRING_PREFIX,
  type ConnectionPayload,
} from "../src/connection-string";

/**
 * The one-paste onboarding token. Encode/decode must round-trip exactly,
 * reject junk with a clear message (never throw on decode — the dialog
 * shows the error), and mirror the daemon's addRemoteDaemon contract
 * (host required, port defaults to 7777, blank optionals dropped).
 */

const KEY = "-----BEGIN OPENSSH PRIVATE KEY-----\nabc+def/ghi=\n-----END OPENSSH PRIVATE KEY-----";

describe("encode/decode round-trip", () => {
  test("round-trips a full payload exactly", () => {
    const p: ConnectionPayload = {
      host: "91.99.11.236",
      port: 7777,
      user: "supergit",
      sshPort: 22,
      privateKey: KEY,
      label: "hetzner",
    };
    const s = encodeConnectionString(p);
    const r = decodeConnectionString(s);
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.payload).toEqual(p);
  });

  test("starts with the versioned prefix and is a single token", () => {
    const s = encodeConnectionString({ host: "h", port: 7777 });
    expect(s.startsWith(CONNECTION_STRING_PREFIX)).toBe(true);
    expect(s).not.toMatch(/\s/); // no whitespace — survives copy/paste
  });

  test("base64url alphabet only (no +, /, = that mangle in URLs/shells)", () => {
    // A key with + / = in it must not leak those into the token body.
    const s = encodeConnectionString({ host: "h", port: 7777, privateKey: KEY });
    const body = s.slice(CONNECTION_STRING_PREFIX.length);
    expect(body).not.toMatch(/[+/=]/);
  });

  test("preserves the private key's newlines + special chars", () => {
    const s = encodeConnectionString({ host: "h", port: 7777, privateKey: KEY });
    const r = decodeConnectionString(s);
    if (r.ok) expect(r.payload.privateKey).toBe(KEY);
  });
});

describe("encode validation", () => {
  test("throws on a blank host", () => {
    expect(() => encodeConnectionString({ host: "  ", port: 7777 })).toThrow(/host/);
  });

  test("drops blank optionals", () => {
    const s = encodeConnectionString({
      host: "h",
      port: 7777,
      user: "  ",
      label: "",
      privateKey: "   ",
    });
    const r = decodeConnectionString(s);
    if (r.ok) {
      expect("user" in r.payload).toBe(false);
      expect("label" in r.payload).toBe(false);
      expect("privateKey" in r.payload).toBe(false);
    }
  });

  test("trims host + label", () => {
    const r = decodeConnectionString(
      encodeConnectionString({ host: "  h  ", port: 7777, label: "  L  " }),
    );
    if (r.ok) {
      expect(r.payload.host).toBe("h");
      expect(r.payload.label).toBe("L");
    }
  });
});

describe("decode error handling (never throws)", () => {
  test("rejects a string without the prefix", () => {
    const r = decodeConnectionString("ssh://whatever");
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toMatch(/connection string/);
  });

  test("rejects non-base64 body", () => {
    const r = decodeConnectionString(CONNECTION_STRING_PREFIX + "!!!not base64!!!");
    expect(r.ok).toBe(false);
  });

  test("rejects valid base64 that isn't JSON", () => {
    const notJson = btoa("hello world").replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
    const r = decodeConnectionString(CONNECTION_STRING_PREFIX + notJson);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toMatch(/JSON/);
  });

  test("rejects a JSON array payload", () => {
    const arr = btoa("[1,2,3]").replace(/=+$/, "");
    const r = decodeConnectionString(CONNECTION_STRING_PREFIX + arr);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toMatch(/object/);
  });

  test("rejects a payload missing host", () => {
    const noHost = encodeButRaw({ port: 7777 });
    const r = decodeConnectionString(noHost);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toMatch(/host/);
  });

  test("defaults port to 7777 when omitted", () => {
    const r = decodeConnectionString(encodeButRaw({ host: "h" }));
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.payload.port).toBe(7777);
  });

  test("tolerates leading/trailing whitespace around the token", () => {
    const s = encodeConnectionString({ host: "h", port: 7777 });
    const r = decodeConnectionString(`  \n ${s} \n `);
    expect(r.ok).toBe(true);
  });
});

/** Build a token from an arbitrary object (bypassing encode's validation)
 *  so we can test the decoder against payloads encode would refuse. */
function encodeButRaw(obj: Record<string, unknown>): string {
  const b64 = btoa(unescape(encodeURIComponent(JSON.stringify(obj))))
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=+$/, "");
  return CONNECTION_STRING_PREFIX + b64;
}
