/**
 * Tests for the small app-wide dialog controller stores. Each one is a
 * single-slot `writable` plus open/close helpers that a once-mounted
 * dialog component subscribes to. They're tiny, but they're the
 * cross-component channel every burger-menu action flows through — a
 * regression here means "clicking Share does nothing" with no error.
 *
 * `confirmDialog` is the interesting one: it's promise-based and queues
 * concurrent calls, so it gets the bulk of the coverage.
 */

import { test, expect, describe, beforeEach, afterEach } from "bun:test";
import { get } from "svelte/store";
import {
  activeConfirm,
  choiceDialog,
  confirmDialog,
} from "../src/confirm-dialog";
import { activeCopy, openCopy, closeCopy } from "../src/copy-session-dialog";
import {
  activeShare,
  openShare,
  closeShare,
  rememberPeer,
  recallPeer,
} from "../src/share-session-dialog";
import {
  activeRepair,
  openRepair,
  closeRepair,
} from "../src/repair-session-dialog";
import {
  activeInvite,
  openInvite,
  closeInvite,
} from "../src/receive-invite-dialog";
import { activeSummarize, openSummarize } from "../src/summarize-dialog";

describe("confirmDialog", () => {
  beforeEach(() => activeConfirm.set(null));

  test("opening publishes a request carrying the options", () => {
    const p = confirmDialog({
      title: "Remove the link?",
      message: "https://x",
      danger: true,
    });
    const req = get(activeConfirm);
    expect(req?.title).toBe("Remove the link?");
    expect(req?.message).toBe("https://x");
    expect(req?.danger).toBe(true);
    // Resolve so we don't leave the controller busy for the next test.
    req!.resolve(false);
    return p;
  });

  test("resolving with true settles the promise and clears the slot", async () => {
    const p = confirmDialog({ title: "ok?" });
    get(activeConfirm)!.resolve(true);
    expect(await p).toBe(true);
    expect(get(activeConfirm)).toBeNull();
  });

  test("resolving with false settles false", async () => {
    const p = confirmDialog({ title: "ok?" });
    get(activeConfirm)!.resolve(false);
    expect(await p).toBe(false);
  });

  test("a second concurrent confirm queues until the first resolves", async () => {
    const pA = confirmDialog({ title: "A" });
    const pB = confirmDialog({ title: "B" });

    // Only A is shown while it's pending.
    expect(get(activeConfirm)?.title).toBe("A");

    get(activeConfirm)!.resolve(true);
    expect(await pA).toBe(true);

    // Now B takes the slot.
    expect(get(activeConfirm)?.title).toBe("B");
    get(activeConfirm)!.resolve(false);
    expect(await pB).toBe(false);
    expect(get(activeConfirm)).toBeNull();
  });

  test("each request gets a distinct incrementing id", async () => {
    const pA = confirmDialog({ title: "A" });
    const idA = get(activeConfirm)!.id;
    get(activeConfirm)!.resolve(true);
    await pA;
    const pB = confirmDialog({ title: "B" });
    const idB = get(activeConfirm)!.id;
    get(activeConfirm)!.resolve(true);
    await pB;
    expect(idB).toBeGreaterThan(idA);
  });

  test("choiceDialog publishes multiple explicit actions and resolves the selected value", async () => {
    const p = choiceDialog({
      title: "Worktree has uncommitted changes",
      message: "Pick how to handle local changes.",
      choices: [
        { value: "stash", label: "Stash & switch", recommended: true },
        { value: "force", label: "Force & switch", danger: true },
        { value: "cancel", label: "Cancel" },
      ],
      cancelValue: "cancel",
    });

    const req = get(activeConfirm);
    expect(req?.mode).toBe("choice");
    expect(req?.choices?.map((choice) => choice.value)).toEqual([
      "stash",
      "force",
      "cancel",
    ]);

    req!.resolve("force");
    expect(await p).toBe("force");
    expect(get(activeConfirm)).toBeNull();
  });

  test("choiceDialog overlay cancel resolves the configured cancel value", async () => {
    const p = choiceDialog({
      title: "Pull would clobber changes",
      choices: [{ value: "stash", label: "Stash & pull" }],
      cancelValue: "cancel",
    });

    get(activeConfirm)!.resolve(null);
    expect(await p).toBe("cancel");
    expect(get(activeConfirm)).toBeNull();
  });
});

describe("single-slot dialog stores", () => {
  test("copy-session: open sets the request, close clears it", () => {
    expect(get(activeCopy)).toBeNull();
    openCopy("/agents/a.jsonl");
    expect(get(activeCopy)).toEqual({ source: "/agents/a.jsonl" });
    closeCopy();
    expect(get(activeCopy)).toBeNull();
  });

  test("share-session: open replaces a prior open (single slot)", () => {
    openShare("/a.jsonl");
    openShare("/b.jsonl");
    expect(get(activeShare)).toEqual({ source: "/b.jsonl" });
    closeShare();
    expect(get(activeShare)).toBeNull();
  });

  test("repair-session: open/close round-trips", () => {
    openRepair("/c.jsonl");
    expect(get(activeRepair)).toEqual({ source: "/c.jsonl" });
    closeRepair();
    expect(get(activeRepair)).toBeNull();
  });

  test("receive-invite: carries the offerId", () => {
    openInvite("offer-123");
    expect(get(activeInvite)).toEqual({ offerId: "offer-123" });
    closeInvite();
    expect(get(activeInvite)).toBeNull();
  });

  test("summarize: open sets the request", () => {
    activeSummarize.set(null);
    openSummarize("/d.jsonl");
    expect(get(activeSummarize)).toEqual({ source: "/d.jsonl" });
  });
});

describe("share peer recall", () => {
  // rememberPeer/recallPeer touch the bare global `localStorage`, absent
  // under Bun. We inject one to drive the round-trip and clean up after.
  afterEach(() => {
    delete (globalThis as { localStorage?: unknown }).localStorage;
  });

  test("recallPeer returns '' when storage is unavailable", () => {
    expect(recallPeer()).toBe("");
  });

  test("rememberPeer does not throw when storage is unavailable", () => {
    expect(() => rememberPeer("host:7777")).not.toThrow();
  });

  test("rememberPeer → recallPeer round-trips the last-used host:port", () => {
    const mem = new Map<string, string>();
    (globalThis as { localStorage?: unknown }).localStorage = {
      getItem: (k: string) => mem.get(k) ?? null,
      setItem: (k: string, v: string) => void mem.set(k, v),
    };
    rememberPeer("192.168.0.5:27787");
    expect(recallPeer()).toBe("192.168.0.5:27787");
  });
});
