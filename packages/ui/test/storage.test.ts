import { test, expect, describe } from "bun:test";
import { ExpandedStore, type KVStore } from "../src/storage";

class MemStore implements KVStore {
  data = new Map<string, string>();
  getItem(k: string) {
    return this.data.get(k) ?? null;
  }
  setItem(k: string, v: string) {
    this.data.set(k, v);
  }
}

class ThrowingStore implements KVStore {
  getItem(): string | null {
    throw new Error("storage unavailable");
  }
  setItem(): void {
    throw new Error("quota exceeded");
  }
}

const KEY = "supergit:commitsExpanded";

describe("ExpandedStore", () => {
  test("returns empty set when nothing is stored", () => {
    const s = new ExpandedStore(new MemStore(), KEY);
    expect([...s.load()]).toEqual([]);
  });

  test("save then load round-trips paths in order", () => {
    const m = new MemStore();
    const s = new ExpandedStore(m, KEY);
    s.save(["/a", "/b/c", "/d e"]);
    expect([...s.load()]).toEqual(["/a", "/b/c", "/d e"]);
  });

  test("save replaces, not merges", () => {
    const m = new MemStore();
    const s = new ExpandedStore(m, KEY);
    s.save(["/a", "/b"]);
    s.save(["/c"]);
    expect([...s.load()]).toEqual(["/c"]);
  });

  test("save with empty input clears the set", () => {
    const m = new MemStore();
    const s = new ExpandedStore(m, KEY);
    s.save(["/a"]);
    s.save([]);
    expect([...s.load()]).toEqual([]);
  });

  test("survives across instances pointing at the same storage", () => {
    const m = new MemStore();
    new ExpandedStore(m, KEY).save(["/a", "/b"]);
    const second = new ExpandedStore(m, KEY);
    expect([...second.load()]).toEqual(["/a", "/b"]);
  });

  test("returns empty set when stored value is not JSON", () => {
    const m = new MemStore();
    m.setItem(KEY, "{not json");
    expect([...new ExpandedStore(m, KEY).load()]).toEqual([]);
  });

  test("returns empty set when stored value is not an array", () => {
    const m = new MemStore();
    m.setItem(KEY, JSON.stringify({ a: 1 }));
    expect([...new ExpandedStore(m, KEY).load()]).toEqual([]);
  });

  test("filters out non-string entries from the stored array", () => {
    const m = new MemStore();
    m.setItem(KEY, JSON.stringify(["a", 1, null, "b", { x: 1 }]));
    expect([...new ExpandedStore(m, KEY).load()]).toEqual(["a", "b"]);
  });

  test("swallows storage errors on save", () => {
    const s = new ExpandedStore(new ThrowingStore(), KEY);
    // Should not throw.
    s.save(["/anything"]);
  });

  test("returns empty set when storage throws on read", () => {
    const s = new ExpandedStore(new ThrowingStore(), KEY);
    expect([...s.load()]).toEqual([]);
  });
});
