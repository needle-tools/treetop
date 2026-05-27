import { test, expect, describe } from "bun:test";
import { SoundMarkerScanner } from "../src/sound-marker";

const enc = new TextEncoder();
const dec = new TextDecoder();

function scan(scanner: SoundMarkerScanner, text: string) {
  const result = scanner.scan(enc.encode(text));
  return { text: dec.decode(result.output), tags: result.tags };
}

describe("SoundMarkerScanner", () => {
  test("passes through plain text unchanged", () => {
    const s = new SoundMarkerScanner();
    const r = scan(s, "hello world\n");
    expect(r.text).toBe("hello world\n");
    expect(r.tags).toHaveLength(0);
  });

  test("extracts a single marker", () => {
    const s = new SoundMarkerScanner();
    const r = scan(s, "some output\n§play-sound:ai-applause§\nmore output\n");
    expect(r.tags).toEqual(["ai-applause"]);
    expect(r.text).not.toContain("§play-sound");
    expect(r.text).toContain("some output");
    expect(r.text).toContain("more output");
  });

  test("extracts multiple markers", () => {
    const s = new SoundMarkerScanner();
    const r = scan(s, "§play-sound:ai-wow§\ntext\n§play-sound:ai-gulp§\n");
    expect(r.tags).toEqual(["ai-wow", "ai-gulp"]);
    expect(r.text).not.toContain("§");
  });

  test("handles marker as only content", () => {
    const s = new SoundMarkerScanner();
    const r = scan(s, "§play-sound:ai-braam§");
    expect(r.tags).toEqual(["ai-braam"]);
  });

  test("handles marker inline with other text", () => {
    const s = new SoundMarkerScanner();
    const r = scan(s, "before§play-sound:ai-crickets§after");
    expect(r.tags).toEqual(["ai-crickets"]);
    expect(r.text).toContain("before");
    expect(r.text).toContain("after");
  });

  test("ignores invalid tag characters", () => {
    const s = new SoundMarkerScanner();
    const r = scan(s, "§play-sound:not a valid tag!§\n");
    expect(r.tags).toHaveLength(0);
    expect(r.text).toContain("§play-sound:not a valid tag!§");
  });

  test("handles hyphenated tags", () => {
    const s = new SoundMarkerScanner();
    const r = scan(s, "§play-sound:ai-crowd-gasp§");
    expect(r.tags).toEqual(["ai-crowd-gasp"]);
  });

  test("does not match partial markers", () => {
    const s = new SoundMarkerScanner();
    const r = scan(s, "§play-sound:§\n");
    expect(r.tags).toHaveLength(0);
  });

  test("handles chunk split across marker boundary", () => {
    const s = new SoundMarkerScanner();
    const r1 = scan(s, "output\n§play-sound:ai-app");
    // Residual should be buffered
    const r2 = scan(s, "lause§\nmore\n");
    const allTags = [...r1.tags, ...r2.tags];
    expect(allTags).toContain("ai-applause");
  });

  test("flush returns buffered residual", () => {
    const s = new SoundMarkerScanner();
    scan(s, "§play-sound:ai-app");
    const flushed = s.flush();
    expect(dec.decode(flushed.output)).toContain("§play-sound:ai-app");
    expect(flushed.tags).toHaveLength(0);
  });

  test("does not strip real section signs in normal text", () => {
    const s = new SoundMarkerScanner();
    const r = scan(s, "See §42 of the contract\n");
    expect(r.text).toBe("See §42 of the contract\n");
    expect(r.tags).toHaveLength(0);
  });
});
