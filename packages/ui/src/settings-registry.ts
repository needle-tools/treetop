/**
 * VS Code-style settings contribution registry.
 *
 * Any subsystem declares its settings once — key, type, default,
 * label — and the generic <SettingsDialog /> renders the controls.
 * No per-setting UI work, ever:
 *
 *   registerSettings({
 *     id: "terminal",
 *     title: "Terminal",
 *     settings: [
 *       { key: "terminal.fontSize", label: "Font size",
 *         type: "number", default: 13, min: 8, max: 32 },
 *       { key: "terminal.renderer", label: "Renderer",
 *         type: "enum", default: "webgl",
 *         options: [{ value: "webgl" }, { value: "canvas" }] },
 *     ],
 *   });
 *
 * Reading a value (reactive, falls back to the declared default):
 *
 *   const fontSize = settingValue("terminal.fontSize");
 *   // in a component:  {$fontSize}
 *
 * Values persist as one JSON blob under `supergit:settings` in daemon
 * prefs (rule 11: shared UI state goes through getDaemonKV(), never
 * raw localStorage), so they follow the user across browser + native
 * app. Only overrides are stored — defaults live in the contribution,
 * so changing a default in code applies to everyone who never touched
 * the setting.
 */
import { writable, derived, get, type Readable } from "svelte/store";
import type { KVStore } from "./storage";
import { getDaemonKV } from "./daemon-kv";

export type SettingValue = boolean | string | number;

interface CommonDef {
  /** Dotted, VS Code style: "appearance.showGreeting". Globally unique. */
  key: string;
  label: string;
  description?: string;
}

export interface BooleanSettingDef extends CommonDef {
  type: "boolean";
  default: boolean;
}
export interface StringSettingDef extends CommonDef {
  type: "string";
  default: string;
  placeholder?: string;
}
export interface NumberSettingDef extends CommonDef {
  type: "number";
  default: number;
  min?: number;
  max?: number;
  step?: number;
}
export interface EnumSettingDef extends CommonDef {
  type: "enum";
  default: string;
  /** `label` falls back to `value`. */
  options: Array<{ value: string; label?: string }>;
}
/** A button, not a value — no default, nothing persisted. Use for
 *  "Reset walkthrough", "Clear caches", and the like. */
export interface ActionSettingDef extends CommonDef {
  type: "action";
  /** Text on the button. */
  buttonLabel: string;
  onInvoke: () => void | Promise<void>;
  /** Render the button as a destructive (red) action. */
  danger?: boolean;
}

export type ValueSettingDef =
  | BooleanSettingDef
  | StringSettingDef
  | NumberSettingDef
  | EnumSettingDef;
export type SettingDef = ValueSettingDef | ActionSettingDef;

/** Narrow an action def from a value def. */
export function isActionSetting(def: SettingDef): def is ActionSettingDef {
  return def.type === "action";
}

export interface SettingsSection {
  /** Stable id — re-registering the same id replaces the section. */
  id: string;
  title: string;
  /** Lower sorts first; defaults to 100. Ties sort by title. */
  order?: number;
  settings: SettingDef[];
}

const STORAGE_KEY = "supergit:settings";

const sections = writable<SettingsSection[]>([]);
const overrides = writable<Record<string, SettingValue>>({});
let loaded = false;
let kvOverride: KVStore | null = null;

/** Inject an alternative KVStore (tests). Pass null to restore daemon prefs. */
export function setSettingsKV(kv: KVStore | null): void {
  kvOverride = kv;
}

function kv(): KVStore {
  return kvOverride ?? getDaemonKV();
}

function ensureLoaded(): void {
  if (loaded) return;
  loaded = true;
  try {
    overrides.set(JSON.parse(kv().getItem(STORAGE_KEY) ?? "{}"));
  } catch {
    overrides.set({});
  }
}

function persist(values: Record<string, SettingValue>): void {
  kv().setItem(STORAGE_KEY, JSON.stringify(values));
}

function findDef(all: SettingsSection[], key: string): SettingDef | undefined {
  for (const section of all) {
    const def = section.settings.find((s) => s.key === key);
    if (def) return def;
  }
  return undefined;
}

/** Contribute (or replace, by section id) a group of settings. */
export function registerSettings(section: SettingsSection): void {
  ensureLoaded();
  sections.update((all) =>
    [...all.filter((s) => s.id !== section.id), section].sort(
      (a, b) =>
        (a.order ?? 100) - (b.order ?? 100) || a.title.localeCompare(b.title),
    ),
  );
}

/** Registered sections, sorted — what the dialog renders. */
export const settingsSections: Readable<SettingsSection[]> = {
  subscribe: sections.subscribe,
};

/** Effective value: override if set, else the declared default. Actions
 *  have no value, so this returns undefined for them. */
export function getSetting(key: string): SettingValue | undefined {
  ensureLoaded();
  const stored = get(overrides);
  if (key in stored) return stored[key];
  const def = findDef(get(sections), key);
  if (!def || def.type === "action") return undefined;
  return def.default;
}

export function setSetting(key: string, value: SettingValue): void {
  ensureLoaded();
  const def = findDef(get(sections), key);
  // Actions carry no value — ignore writes so they never pollute the blob.
  if (def?.type === "action") return;
  overrides.update((values) => {
    const next = { ...values };
    // Storing the default is the same as not storing it — keeps the
    // blob minimal and lets future default changes reach this user.
    if (def && def.default === value) delete next[key];
    else next[key] = value;
    persist(next);
    return next;
  });
}

/** Drop the override; the setting falls back to its default. */
export function resetSetting(key: string): void {
  ensureLoaded();
  overrides.update((values) => {
    if (!(key in values)) return values;
    const next = { ...values };
    delete next[key];
    persist(next);
    return next;
  });
}

/** True when the user has overridden the declared default. */
export function isModified(key: string): boolean {
  ensureLoaded();
  return key in get(overrides);
}

/** Reactive effective value — updates on setSetting/resetSetting and
 *  when the owning section registers (late registration is fine). */
export function settingValue(key: string): Readable<SettingValue | undefined> {
  ensureLoaded();
  return derived([sections, overrides], ([all, values]) => {
    if (key in values) return values[key];
    const def = findDef(all, key);
    return !def || def.type === "action" ? undefined : def.default;
  });
}

/** Search filter for the dialog: matches setting label / description /
 *  key, or the section title (a title match keeps the whole section). */
export function filterSections(
  all: SettingsSection[],
  query: string,
): SettingsSection[] {
  const q = query.trim().toLowerCase();
  if (!q) return all;
  const result: SettingsSection[] = [];
  for (const section of all) {
    if (section.title.toLowerCase().includes(q)) {
      result.push(section);
      continue;
    }
    const settings = section.settings.filter(
      (s) =>
        s.label.toLowerCase().includes(q) ||
        s.key.toLowerCase().includes(q) ||
        (s.description?.toLowerCase().includes(q) ?? false),
    );
    if (settings.length > 0) result.push({ ...section, settings });
  }
  return result;
}

/** Test-only: clear registrations, overrides, and the KV injection. */
export function _resetSettingsForTests(): void {
  sections.set([]);
  overrides.set({});
  loaded = false;
  kvOverride = null;
}
