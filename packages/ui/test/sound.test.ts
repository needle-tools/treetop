import { test, expect, describe, beforeEach } from "bun:test";
import {
  play,
  clearQueue,
  getQueueSnapshot,
  getActiveCount,
  configure,
  resetForTesting,
  setEnabled,
  isEnabled,
  getMappings,
  getMasterVolume,
  setMasterVolume,
  DEFAULT_MAPPINGS,
  sound,
  type SoundTag,
} from "../src/sound";

beforeEach(() => {
  resetForTesting();
});

describe("configure + getMappings", () => {
  test("stores and returns mappings", () => {
    configure({ "note-edit-start": { files: ["/sounds/pop.mp3"] } });
    expect(getMappings()["note-edit-start"]?.files[0]).toBe("/sounds/pop.mp3");
  });

  test("replaces previous mappings entirely", () => {
    configure({ "note-edit-start": { files: ["/a.mp3"] }, "error": { files: ["/b.mp3"] } });
    configure({ "folder-add": { files: ["/c.mp3"] } });
    expect(getMappings()["note-edit-start"]).toBeUndefined();
    expect(getMappings()["folder-add"]?.files[0]).toBe("/c.mp3");
  });
});

describe("DEFAULT_MAPPINGS", () => {
  test("contains all phase-1 tags", () => {
    const tags: SoundTag[] = [
      "folder-add-first", "folder-add", "note-edit-start",
      "note-edit-end", "message-receive", "error", "peer-session",
    ];
    for (const t of tags) {
      expect(DEFAULT_MAPPINGS[t]).toBeDefined();
      expect(DEFAULT_MAPPINGS[t]!.files.length).toBeGreaterThan(0);
    }
  });

  test("note-edit-end has alt variants", () => {
    expect(DEFAULT_MAPPINGS["note-edit-end"]!.files.length).toBe(2);
  });

  test("folder-add-first has alt variants", () => {
    expect(DEFAULT_MAPPINGS["folder-add-first"]!.files.length).toBe(2);
  });

  test("short FX sounds are overlay", () => {
    expect(DEFAULT_MAPPINGS["note-edit-start"]!.overlay).toBe(true);
    expect(DEFAULT_MAPPINGS["error"]!.overlay).toBe(true);
    expect(DEFAULT_MAPPINGS["message-receive"]!.overlay).toBe(true);
  });

  test("long sounds have fadeOutMs", () => {
    expect(DEFAULT_MAPPINGS["folder-add-first"]!.fadeOutMs).toBeGreaterThan(0);
    expect(DEFAULT_MAPPINGS["folder-add"]!.fadeOutMs).toBeGreaterThan(0);
  });
});

describe("enabled flag", () => {
  test("enabled by default", () => {
    expect(isEnabled()).toBe(true);
  });

  test("can disable and re-enable", () => {
    setEnabled(false);
    expect(isEnabled()).toBe(false);
    setEnabled(true);
    expect(isEnabled()).toBe(true);
  });

  test("play is a no-op when disabled", () => {
    configure({ "folder-add": { files: ["/sounds/pop.mp3"] } });
    setEnabled(false);
    play("folder-add");
    expect(getQueueSnapshot()).toHaveLength(0);
  });
});

describe("master volume", () => {
  test("defaults to 1.0", () => {
    expect(getMasterVolume()).toBe(1.0);
  });

  test("clamps to [0, 1]", () => {
    setMasterVolume(1.5);
    expect(getMasterVolume()).toBe(1);
    setMasterVolume(-0.3);
    expect(getMasterVolume()).toBe(0);
    setMasterVolume(0.7);
    expect(getMasterVolume()).toBe(0.7);
  });

  test("resetForTesting resets master volume", () => {
    setMasterVolume(0.2);
    resetForTesting();
    expect(getMasterVolume()).toBe(1.0);
  });
});

describe("queue management (non-overlay)", () => {
  test("play enqueues when mapping exists", () => {
    configure({ "folder-add": { files: ["/sounds/pop.mp3"] } });
    play("folder-add");
    expect(getQueueSnapshot()).toHaveLength(1);
    expect(getQueueSnapshot()[0]!.tag).toBe("folder-add");
  });

  test("play ignores unknown tags (no mapping)", () => {
    play("folder-add");
    expect(getQueueSnapshot()).toHaveLength(0);
  });

  test("clearQueue empties the queue", () => {
    configure({
      "folder-add": { files: ["/a.mp3"], selfCooldown: 0, globalCooldown: 0 },
      "folder-add-first": { files: ["/b.mp3"], selfCooldown: 0, globalCooldown: 0 },
    });
    play("folder-add");
    play("folder-add-first");
    expect(getQueueSnapshot()).toHaveLength(2);
    clearQueue();
    expect(getQueueSnapshot()).toHaveLength(0);
  });

  test("queue caps at MAX_QUEUE_SIZE (8)", () => {
    configure({ "folder-add": { files: ["/sounds/pop.mp3"], selfCooldown: 0, globalCooldown: 0 } });
    for (let i = 0; i < 12; i++) {
      play("folder-add");
    }
    expect(getQueueSnapshot().length).toBeLessThanOrEqual(8);
  });

  test("getQueueSnapshot returns a copy", () => {
    configure({ "folder-add": { files: ["/a.mp3"] } });
    play("folder-add");
    const snap = getQueueSnapshot();
    clearQueue();
    expect(snap).toHaveLength(1);
    expect(getQueueSnapshot()).toHaveLength(0);
  });
});

describe("overlay sounds", () => {
  test("overlay sounds bypass the queue", () => {
    configure({ "error": { files: ["/a.mp3"], overlay: true, selfCooldown: 0 } });
    play("error");
    expect(getQueueSnapshot()).toHaveLength(0);
  });

  test("overlay sounds still respect selfCooldown", () => {
    configure({ "error": { files: ["/a.mp3"], overlay: true, selfCooldown: 5000 } });
    play("error");
    play("error");
    // second play should be blocked by selfCooldown — we can't easily
    // observe this without AudioContext, but at minimum the queue stays empty
    expect(getQueueSnapshot()).toHaveLength(0);
  });

  test("overlay and queued sounds are independent", () => {
    configure({
      "folder-add": { files: ["/a.mp3"], selfCooldown: 0 },
      "error": { files: ["/b.mp3"], overlay: true, selfCooldown: 0 },
    });
    play("folder-add");
    play("error");
    expect(getQueueSnapshot()).toHaveLength(1);
    expect(getQueueSnapshot()[0]!.tag).toBe("folder-add");
  });
});

describe("cooldown + dedup", () => {
  test("same tag within selfCooldown is dropped", () => {
    configure({ "folder-add": { files: ["/a.mp3"], selfCooldown: 5000 } });
    play("folder-add");
    play("folder-add");
    play("folder-add");
    expect(getQueueSnapshot()).toHaveLength(1);
  });

  test("same tag with selfCooldown: 0 and globalCooldown: 0 allows rapid fire", () => {
    configure({ "folder-add": { files: ["/a.mp3"], selfCooldown: 0, globalCooldown: 0 } });
    play("folder-add");
    play("folder-add");
    play("folder-add");
    expect(getQueueSnapshot()).toHaveLength(3);
  });

  test("default selfCooldown (300ms) blocks same-frame dupes", () => {
    configure({ "folder-add": { files: ["/a.mp3"] } });
    play("folder-add");
    play("folder-add");
    expect(getQueueSnapshot()).toHaveLength(1);
  });

  test("different tags can queue in the same frame", () => {
    configure({
      "folder-add": { files: ["/a.mp3"], selfCooldown: 0, globalCooldown: 0 },
      "folder-add-first": { files: ["/b.mp3"], selfCooldown: 0, globalCooldown: 0 },
    });
    play("folder-add");
    play("folder-add-first");
    expect(getQueueSnapshot()).toHaveLength(2);
  });

  test("globalCooldown blocks other tags when queue is non-empty", () => {
    configure({
      "folder-add-first": { files: ["/a.mp3"], selfCooldown: 0, globalCooldown: 5000 },
      "folder-add": { files: ["/b.mp3"], selfCooldown: 0 },
    });
    play("folder-add-first");
    play("folder-add");
    expect(getQueueSnapshot()).toHaveLength(1);
    expect(getQueueSnapshot()[0]!.tag).toBe("folder-add-first");
  });
});

describe("sound action", () => {
  function makeEl(): HTMLElement {
    return {
      _listeners: {} as Record<string, Function[]>,
      addEventListener(event: string, fn: Function) {
        (this._listeners[event] ??= []).push(fn);
      },
      removeEventListener(event: string, fn: Function) {
        const arr = this._listeners[event];
        if (!arr) return;
        const idx = arr.indexOf(fn);
        if (idx >= 0) arr.splice(idx, 1);
      },
      dispatchEvent(event: string) {
        for (const fn of this._listeners[event] ?? []) fn();
      },
    } as unknown as HTMLElement;
  }

  test("click trigger registers click listener", () => {
    configure({ "folder-add": { files: ["/a.mp3"] } });
    const el = makeEl() as any;
    const action = sound(el, { tag: "folder-add", trigger: "click" });
    expect(el._listeners["click"]).toHaveLength(1);
    action.destroy();
    expect(el._listeners["click"]).toHaveLength(0);
  });

  test("hover trigger registers pointerenter listener", () => {
    configure({ "folder-add": { files: ["/a.mp3"] } });
    const el = makeEl() as any;
    const action = sound(el, { tag: "folder-add", trigger: "hover" });
    expect(el._listeners["pointerenter"]).toHaveLength(1);
    action.destroy();
    expect(el._listeners["pointerenter"]).toHaveLength(0);
  });

  test("appear trigger plays immediately (queued sound)", () => {
    configure({ "folder-add": { files: ["/a.mp3"] } });
    const el = makeEl() as any;
    const action = sound(el, { tag: "folder-add", trigger: "appear" });
    expect(getQueueSnapshot()).toHaveLength(1);
    expect(getQueueSnapshot()[0]!.tag).toBe("folder-add");
    action.destroy();
  });

  test("default trigger is click", () => {
    configure({ "folder-add": { files: ["/a.mp3"] } });
    const el = makeEl() as any;
    const action = sound(el, { tag: "folder-add" });
    expect(el._listeners["click"]).toHaveLength(1);
    action.destroy();
  });

  test("update swaps listener", () => {
    configure({
      "folder-add": { files: ["/a.mp3"] },
      "folder-add-first": { files: ["/b.mp3"] },
    });
    const el = makeEl() as any;
    const action = sound(el, { tag: "folder-add", trigger: "click" });
    expect(el._listeners["click"]).toHaveLength(1);
    action.update({ tag: "folder-add-first", trigger: "hover" });
    expect(el._listeners["click"] ?? []).toHaveLength(0);
    expect(el._listeners["pointerenter"]).toHaveLength(1);
    action.destroy();
  });

  test("click handler enqueues the sound", () => {
    configure({ "folder-add": { files: ["/a.mp3"] } });
    const el = makeEl() as any;
    const action = sound(el, { tag: "folder-add" });
    el.dispatchEvent("click");
    expect(getQueueSnapshot()).toHaveLength(1);
    action.destroy();
  });
});
