/**
 * Sound-effect system for supergit.
 *
 * Phase 1: UI interaction sounds (hover, click, create, delete, receive).
 * Phase 2: AI-queued sounds (lower priority, attention/gimmick effects).
 *
 * Playback uses Web Audio API. A queue prevents overlap and rapid-fire.
 * Svelte action `use:sound` attaches sounds declaratively to any element.
 */

export type SoundTag =
  | "note-edit-start"
  | "note-edit-end"
  | "folder-add"
  | "folder-add-first"
  | "message-receive"
  | "error"
  | "peer-session"
  | "session-stop"
  | "ai-needs-input"
  | "git-push"
  | "ai-attention"
  | "ai-funny"
  | "ai-disagree"
  | "ai-tired"
  | "ai-uh-oh"
  | "ai-omg"
  | "ai-ascend"
  | "ai-eureka"
  | "ai-confused"
  | "ai-surprised"
  | "ai-wow"
  | "ai-gulp"
  | "ai-applause"
  | "ai-crickets"
  | "ai-boxing-bell"
  | "ai-braam"
  | "ai-crowd-gasp";

export type SoundTrigger = "click" | "hover" | "appear";

export interface SoundMapping {
  files: string[];
  volume?: number;
  /** Min ms before the same tag can be queued again. Default: 300. */
  selfCooldown?: number;
  /** Min ms before ANY other sound can be queued after this one. Default: MIN_INTERVAL_MS (120). */
  globalCooldown?: number;
  /** Max ms a queued sound waits before being dropped as stale. Default: 2000. */
  maxDelay?: number;
  /** If true, plays immediately on top of whatever's active (bypasses queue). */
  overlay?: boolean;
  /** When another sound starts, fade this one out over N ms instead of
   *  letting it finish. 0 = no fade (default for short FX). */
  fadeOutMs?: number;
}

export interface QueueEntry {
  tag: SoundTag;
  addedAt: number;
}

interface ActiveSource {
  tag: SoundTag;
  source: AudioBufferSourceNode;
  gain: GainNode;
  fadeOutMs: number;
  startedAt: number;
}

const DEFAULT_VOLUME = 0.5;
const DEFAULT_SELF_COOLDOWN_MS = 300;
const DEFAULT_MAX_DELAY_MS = 2000;
const MIN_INTERVAL_MS = 120;
const MAX_QUEUE_SIZE = 8;

let soundMappings: Partial<Record<SoundTag, SoundMapping>> = {};
let masterVolume = 1.0;
let audioCtx: AudioContext | null = null;
let bufferCache = new Map<string, AudioBuffer>();
let pending: QueueEntry[] = [];
let playing = false;
let lastPlayEnd = 0;
let lastPlayedAt = new Map<SoundTag, number>();
let lastAnyQueuedAt = 0;
let lastQueuedGlobalCooldown = 0;
let enabled = true;
let drainScheduled = false;
let activeSources: ActiveSource[] = [];

export const DEFAULT_MAPPINGS: Partial<Record<SoundTag, SoundMapping>> = {
  "folder-add-first": {
    files: [
      "/sounds/folder-add-first.mp3",
      "/sounds/folder-add-first-alt1.mp3",
    ],
    volume: 0.3,
    selfCooldown: 20_000,
    globalCooldown: 2000,
    maxDelay: 500,
    fadeOutMs: 3000,
  },
  "folder-add": {
    files: ["/sounds/folder-add.mp3"],
    volume: 0.3,
    selfCooldown: 5000,
    globalCooldown: 1000,
    maxDelay: 1000,
    fadeOutMs: 1500,
  },
  "note-edit-start": {
    files: ["/sounds/note-edit-start.mp3"],
    volume: 0.35,
    overlay: true,
  },
  "note-edit-end": {
    files: ["/sounds/note-edit-end.mp3", "/sounds/note-edit-end-alt1.mp3"],
    volume: 0.5,
    overlay: true,
  },
  "message-receive": {
    files: ["/sounds/message-receive.mp3"],
    volume: 0.5,
    selfCooldown: 2000,
    overlay: true,
  },
  error: {
    files: ["/sounds/error.mp3"],
    volume: 0.4,
    selfCooldown: 1000,
    overlay: true,
  },
  "peer-session": {
    files: ["/sounds/peer-session.mp3"],
    volume: 0.4,
    selfCooldown: 3000,
    maxDelay: 500,
    overlay: true,
    fadeOutMs: 1000,
  },
  // Nudge played when a session has been awaiting user input for
  // ~60s (see attention-chime.ts). selfCooldown keeps it from
  // stacking when several sessions cross the threshold at once.
  "ai-needs-input": {
    files: ["/sounds/ai-needs-input.ogg"],
    volume: 0.4,
    overlay: true,
    selfCooldown: 10_000,
  },
  // Positive "achievement" chime on a successful git push.
  "git-push": {
    files: ["/sounds/git-push.ogg"],
    volume: 0.4,
    overlay: true,
    selfCooldown: 2000,
  },
  // Phase 2: AI-queued sounds (not wired yet — needs daemon WebSocket events)
  "ai-disagree": {
    files: ["/sounds/ai-disagree.mp3"],
    volume: 0.4,
    overlay: true,
    selfCooldown: 30_000,
  },
  "ai-tired": {
    files: ["/sounds/ai-tired.mp3"],
    volume: 0.4,
    overlay: true,
    selfCooldown: 60_000,
  },
  "ai-uh-oh": {
    files: ["/sounds/ai-uh-oh.mp3"],
    volume: 0.4,
    overlay: true,
    selfCooldown: 30_000,
  },
  "session-stop": {
    files: ["/sounds/session-stop.mp3"],
    volume: 0.4,
    overlay: true,
    selfCooldown: 2000,
    fadeOutMs: 1000,
  },
  "ai-funny": {
    files: ["/sounds/ai-howl.mp3"],
    volume: 0.3,
    overlay: true,
    selfCooldown: 60_000,
    fadeOutMs: 1000,
  },
  "ai-omg": {
    files: ["/sounds/ai-omg.mp3"],
    volume: 0.4,
    overlay: true,
    selfCooldown: 30_000,
  },
  "ai-ascend": {
    files: ["/sounds/ai-ascend.mp3", "/sounds/ai-ascend-short.mp3"],
    volume: 0.3,
    overlay: true,
    selfCooldown: 30_000,
    fadeOutMs: 1000,
  },
  "ai-eureka": {
    files: ["/sounds/ai-eureka.mp3"],
    volume: 0.3,
    overlay: true,
    selfCooldown: 30_000,
    fadeOutMs: 1500,
  },
  "ai-confused": {
    files: ["/sounds/ai-confused.mp3"],
    volume: 0.4,
    overlay: true,
    selfCooldown: 30_000,
  },
  "ai-surprised": {
    files: ["/sounds/ai-surprised.mp3"],
    volume: 0.4,
    overlay: true,
    selfCooldown: 30_000,
  },
  "ai-wow": {
    files: ["/sounds/ai-wow.mp3"],
    volume: 0.4,
    overlay: true,
    selfCooldown: 30_000,
  },
  "ai-gulp": {
    files: ["/sounds/ai-gulp.mp3"],
    volume: 0.4,
    overlay: true,
    selfCooldown: 30_000,
  },
  "ai-applause": {
    files: ["/sounds/ai-applause.mp3"],
    volume: 0.3,
    overlay: true,
    selfCooldown: 60_000,
    fadeOutMs: 1500,
  },
  "ai-crickets": {
    files: ["/sounds/ai-crickets.mp3"],
    volume: 0.3,
    overlay: true,
    selfCooldown: 60_000,
    fadeOutMs: 1500,
  },
  "ai-boxing-bell": {
    files: ["/sounds/ai-boxing-bell.mp3"],
    volume: 0.3,
    overlay: true,
    selfCooldown: 60_000,
    fadeOutMs: 2000,
  },
  "ai-braam": {
    files: ["/sounds/ai-braam.mp3"],
    volume: 0.25,
    overlay: true,
    selfCooldown: 60_000,
    fadeOutMs: 3000,
  },
  "ai-crowd-gasp": {
    files: ["/sounds/ai-crowd-gasp.mp3"],
    volume: 0.3,
    overlay: true,
    selfCooldown: 30_000,
    fadeOutMs: 1000,
  },
};

export function getAudioContext(): AudioContext | null {
  return audioCtx;
}

export function isEnabled(): boolean {
  return enabled;
}

export function setEnabled(on: boolean): void {
  enabled = on;
}

export function getMasterVolume(): number {
  return masterVolume;
}

export function setMasterVolume(v: number): void {
  masterVolume = Math.max(0, Math.min(1, v));
}

export function configure(
  mappings: Partial<Record<SoundTag, SoundMapping>>,
): void {
  soundMappings = { ...mappings };
}

export function getMappings(): Readonly<
  Partial<Record<SoundTag, SoundMapping>>
> {
  return soundMappings;
}

function pickFile(mapping: SoundMapping): string {
  const { files } = mapping;
  if (files.length === 1) return files[0]!;
  return files[Math.floor(Math.random() * files.length)]!;
}

export function warmAudioContext(): void {
  if (audioCtx) return;
  audioCtx = new AudioContext();
  if (audioCtx.state === "suspended") audioCtx.resume();
}

let gestureListenerInstalled = false;

export function installGestureListener(): void {
  if (gestureListenerInstalled) return;
  if (typeof document === "undefined") return;
  gestureListenerInstalled = true;
  const handler = () => {
    warmAudioContext();
    document.removeEventListener("click", handler, true);
    document.removeEventListener("keydown", handler, true);
  };
  document.addEventListener("click", handler, { capture: true, once: false });
  document.addEventListener("keydown", handler, { capture: true, once: false });
}

function ensureContext(): AudioContext | null {
  if (!audioCtx) return null;
  if (audioCtx.state === "suspended") audioCtx.resume();
  return audioCtx;
}

async function loadBuffer(
  ctx: AudioContext,
  file: string,
): Promise<AudioBuffer> {
  const cached = bufferCache.get(file);
  if (cached) return cached;
  const res = await fetch(file);
  if (!res.ok) throw new Error(`Failed to load sound: ${file}`);
  const arrayBuf = await res.arrayBuffer();
  const audioBuf = await ctx.decodeAudioData(arrayBuf);
  bufferCache.set(file, audioBuf);
  return audioBuf;
}

function fadeOutActive(): void {
  const now = audioCtx?.currentTime ?? 0;
  const toRemove: ActiveSource[] = [];
  for (const a of activeSources) {
    if (a.fadeOutMs <= 0) continue;
    const fadeSec = a.fadeOutMs / 1000;
    a.gain.gain.cancelScheduledValues(now);
    a.gain.gain.setValueAtTime(a.gain.gain.value, now);
    a.gain.gain.linearRampToValueAtTime(0, now + fadeSec);
    a.source.stop(now + fadeSec + 0.05);
    toRemove.push(a);
  }
  for (const a of toRemove) {
    const idx = activeSources.indexOf(a);
    if (idx >= 0) activeSources.splice(idx, 1);
  }
}

function removeActive(a: ActiveSource): void {
  const idx = activeSources.indexOf(a);
  if (idx >= 0) activeSources.splice(idx, 1);
}

function playBuffer(
  ctx: AudioContext,
  buffer: AudioBuffer,
  mapping: SoundMapping,
  tag: SoundTag,
): { source: AudioBufferSourceNode; gain: GainNode; promise: Promise<void> } {
  const source = ctx.createBufferSource();
  const gain = ctx.createGain();
  gain.gain.value = (mapping.volume ?? DEFAULT_VOLUME) * masterVolume;
  source.buffer = buffer;
  source.connect(gain);
  gain.connect(ctx.destination);

  const active: ActiveSource = {
    tag,
    source,
    gain,
    fadeOutMs: mapping.fadeOutMs ?? 0,
    startedAt: Date.now(),
  };
  activeSources.push(active);

  source.start(0);
  const promise = new Promise<void>((resolve) => {
    source.onended = () => {
      removeActive(active);
      resolve();
    };
  });
  return { source, gain, promise };
}

async function playOverlay(
  tag: SoundTag,
  mapping: SoundMapping,
): Promise<void> {
  try {
    const ctx = ensureContext();
    if (!ctx) {
      console.debug("[sound] no AudioContext for %s", tag);
      return;
    }
    const file = pickFile(mapping);
    console.debug("[sound] loading %s → %s", tag, file);
    const buffer = await loadBuffer(ctx, file);
    console.debug("[sound] playing %s (%ss)", tag, buffer.duration.toFixed(2));
    fadeOutActive();
    playBuffer(ctx, buffer, mapping, tag);
  } catch (e) {
    console.debug("[sound] error playing %s:", tag, e);
  }
  lastPlayedAt.set(tag, Date.now());
}

async function drainQueue(): Promise<void> {
  if (playing) return;
  playing = true;
  drainScheduled = false;
  try {
    while (pending.length > 0) {
      const now = Date.now();
      const wait = MIN_INTERVAL_MS - (now - lastPlayEnd);
      if (wait > 0) {
        await new Promise((r) => setTimeout(r, wait));
      }
      const entry = pending.shift();
      if (!entry) break;
      const mapping = soundMappings[entry.tag];
      if (!mapping) continue;
      const maxDelay = mapping.maxDelay ?? DEFAULT_MAX_DELAY_MS;
      if (Date.now() - entry.addedAt > maxDelay) continue;
      try {
        const ctx = ensureContext();
        if (!ctx) continue;
        const file = pickFile(mapping);
        const buffer = await loadBuffer(ctx, file);
        fadeOutActive();
        const { promise } = playBuffer(ctx, buffer, mapping, entry.tag);
        await promise;
      } catch {
        // sound failed to play — skip silently
      }
      lastPlayEnd = Date.now();
      lastPlayedAt.set(entry.tag, lastPlayEnd);
    }
  } finally {
    playing = false;
  }
}

function scheduleDrain(): void {
  if (drainScheduled) return;
  drainScheduled = true;
  queueMicrotask(() => drainQueue());
}

export function play(tag: SoundTag): void {
  if (!enabled) {
    console.debug("[sound] skip %s (disabled)", tag);
    return;
  }
  const mapping = soundMappings[tag];
  if (!mapping) {
    console.debug("[sound] skip %s (no mapping)", tag);
    return;
  }
  const now = Date.now();
  const selfCd = mapping.selfCooldown ?? DEFAULT_SELF_COOLDOWN_MS;
  const lastSelf = lastPlayedAt.get(tag) ?? 0;
  if (now - lastSelf < selfCd) {
    console.debug("[sound] skip %s (selfCooldown %dms)", tag, selfCd);
    return;
  }

  if (mapping.overlay) {
    console.debug("[sound] play %s (overlay)", tag);
    lastPlayedAt.set(tag, now);
    playOverlay(tag, mapping);
    return;
  }

  if (pending.length >= MAX_QUEUE_SIZE) {
    console.debug("[sound] skip %s (queue full)", tag);
    return;
  }
  if (pending.length > 0 && now - lastAnyQueuedAt < lastQueuedGlobalCooldown) {
    console.debug("[sound] skip %s (globalCooldown)", tag);
    return;
  }
  console.debug("[sound] queue %s", tag);
  lastAnyQueuedAt = now;
  lastQueuedGlobalCooldown = mapping.globalCooldown ?? MIN_INTERVAL_MS;
  pending.push({ tag, addedAt: now });
  scheduleDrain();
}

export function clearQueue(): void {
  pending.length = 0;
}

export function getQueueSnapshot(): readonly QueueEntry[] {
  return [...pending];
}

export function getActiveCount(): number {
  return activeSources.length;
}

export function resetForTesting(): void {
  pending = [];
  playing = false;
  lastPlayEnd = 0;
  lastPlayedAt = new Map();
  lastAnyQueuedAt = 0;
  lastQueuedGlobalCooldown = 0;
  drainScheduled = false;
  bufferCache = new Map();
  audioCtx = null;
  soundMappings = {};
  masterVolume = 1.0;
  enabled = true;
  activeSources = [];
}

export interface SoundActionOptions {
  tag: SoundTag;
  trigger?: SoundTrigger;
}

export function sound(node: HTMLElement, opts: SoundActionOptions) {
  const trigger = opts.trigger ?? "click";

  const handler = () => play(opts.tag);

  const eventName = trigger === "hover" ? "pointerenter" : "click";
  if (trigger !== "appear") {
    node.addEventListener(eventName, handler);
  } else {
    play(opts.tag);
  }

  return {
    update(newOpts: SoundActionOptions) {
      const oldEvent =
        (opts.trigger ?? "click") === "hover" ? "pointerenter" : "click";
      if (opts.trigger !== "appear") {
        node.removeEventListener(oldEvent, handler);
      }
      opts = newOpts;
      const newEvent =
        (opts.trigger ?? "click") === "hover" ? "pointerenter" : "click";
      if (opts.trigger !== "appear") {
        node.addEventListener(newEvent, handler);
      } else {
        play(opts.tag);
      }
    },
    destroy() {
      if (trigger !== "appear") {
        const ev = trigger === "hover" ? "pointerenter" : "click";
        node.removeEventListener(ev, handler);
      }
    },
  };
}
