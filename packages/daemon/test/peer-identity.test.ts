/**
 * Identity store for a daemon — the stable `(id, label)` pair other
 * daemons on the LAN see when they discover us via mDNS, and that
 * we send in `originMachine` / `originMachineLabel` on outgoing
 * offers. Persisted under `<workspace>/peer-identity.json` so the id
 * survives restarts (otherwise duplicate peers would appear in every
 * other daemon's list each time we boot).
 */

import { test, expect, describe } from "bun:test";
import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadOrCreatePeerIdentity, setPeerLabel } from "../src/peer-identity";

async function ws(): Promise<string> {
  return mkdtemp(join(tmpdir(), "supergit-identity-"));
}

describe("loadOrCreatePeerIdentity", () => {
  test("creates a new identity on first call and persists it", async () => {
    const w = await ws();
    const a = await loadOrCreatePeerIdentity(w, {
      defaultLabel: "marcel@laptop",
    });
    expect(typeof a.id).toBe("string");
    expect(a.id.length).toBeGreaterThanOrEqual(8);
    expect(a.label).toBe("marcel@laptop");
    // Reading the file directly confirms it landed on disk.
    const raw = await readFile(join(w, "peer-identity.json"), "utf-8");
    const parsed = JSON.parse(raw);
    expect(parsed.id).toBe(a.id);
    expect(parsed.label).toBe(a.label);
  });

  test("returns the same id on subsequent calls (no churn)", async () => {
    const w = await ws();
    const a = await loadOrCreatePeerIdentity(w, { defaultLabel: "x" });
    const b = await loadOrCreatePeerIdentity(w, { defaultLabel: "different" });
    expect(b.id).toBe(a.id);
    // The defaultLabel is only consulted when the file is being created.
    expect(b.label).toBe(a.label);
  });

  test("repairs a malformed identity file by writing a fresh one", async () => {
    const w = await ws();
    await writeFile(join(w, "peer-identity.json"), "not json");
    const a = await loadOrCreatePeerIdentity(w, { defaultLabel: "fresh" });
    expect(a.label).toBe("fresh");
    // The file is now valid JSON again.
    const parsed = JSON.parse(
      await readFile(join(w, "peer-identity.json"), "utf-8"),
    );
    expect(parsed.id).toBe(a.id);
  });

  test("repairs a partial identity file with missing fields", async () => {
    const w = await ws();
    await writeFile(
      join(w, "peer-identity.json"),
      JSON.stringify({ id: "existing-id" }),
    );
    const a = await loadOrCreatePeerIdentity(w, { defaultLabel: "fresh" });
    // Existing id is preserved (otherwise other peers lose track of us).
    expect(a.id).toBe("existing-id");
    // Missing label is filled in from default.
    expect(a.label).toBe("fresh");
  });
});

describe("setPeerLabel", () => {
  test("updates the label without changing the id", async () => {
    const w = await ws();
    const a = await loadOrCreatePeerIdentity(w, { defaultLabel: "first" });
    const b = await setPeerLabel(w, "second");
    expect(b.id).toBe(a.id);
    expect(b.label).toBe("second");

    const reloaded = await loadOrCreatePeerIdentity(w, {
      defaultLabel: "ignored",
    });
    expect(reloaded.label).toBe("second");
  });

  test("trims whitespace and rejects empty labels", async () => {
    const w = await ws();
    await loadOrCreatePeerIdentity(w, { defaultLabel: "ok" });
    const a = await setPeerLabel(w, "  padded  ");
    expect(a.label).toBe("padded");

    await expect(setPeerLabel(w, "   ")).rejects.toThrow(/label/);
    // Disk still holds the last good value.
    const parsed = JSON.parse(
      await readFile(join(w, "peer-identity.json"), "utf-8"),
    );
    expect(parsed.label).toBe("padded");
  });
});
