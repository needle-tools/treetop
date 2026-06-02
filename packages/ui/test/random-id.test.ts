import { test, expect, describe } from "bun:test";
import { randomUUID } from "../src/random-id";

const V4 =
  /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;

describe("randomUUID", () => {
  test("default (real crypto) returns a valid v4 UUID", () => {
    expect(randomUUID()).toMatch(V4);
  });

  test("returns distinct values across calls", () => {
    const a = randomUUID();
    const b = randomUUID();
    expect(a).not.toBe(b);
  });

  test("falls back to getRandomValues when randomUUID is missing (insecure context)", () => {
    // Simulate a non-secure context: crypto exists, but randomUUID does not.
    const insecure = {
      getRandomValues: (arr: Uint8Array) => {
        for (let i = 0; i < arr.length; i++) arr[i] = (i * 37 + 11) & 0xff;
        return arr;
      },
    } as unknown as Crypto;
    const id = randomUUID(insecure);
    expect(id).toMatch(V4); // valid v4 (version + variant nibbles correct)
  });

  test("last-ditch Math.random path (no Web Crypto at all) still yields a valid v4", () => {
    const id = randomUUID(undefined);
    expect(id).toMatch(V4);
  });
});
