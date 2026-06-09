/**
 * Tests for the VS Code-style settings contribution registry
 * (src/settings-registry.ts). Any subsystem registers declarative
 * setting definitions; the generic SettingsDialog renders them without
 * per-setting UI work. Persistence goes through an injected KVStore
 * (daemon prefs in the app, an in-memory store here).
 */
import { describe, test, expect, beforeEach, mock } from "bun:test";
import { get } from "svelte/store";
import type { KVStore } from "../src/storage";
import {
  registerSettings,
  settingsSections,
  getSetting,
  setSetting,
  resetSetting,
  resetAllSettings,
  isModified,
  settingValue,
  filterSections,
  isActionSetting,
  setSettingsKV,
  _resetSettingsForTests,
} from "../src/settings-registry";

function memKV(): KVStore & { data: Record<string, string> } {
  const data: Record<string, string> = {};
  return {
    data,
    getItem: (k) => data[k] ?? null,
    setItem: (k, v) => {
      data[k] = v;
    },
  };
}

let kv: ReturnType<typeof memKV>;

beforeEach(() => {
  _resetSettingsForTests();
  kv = memKV();
  setSettingsKV(kv);
});

const appearance = {
  id: "appearance",
  title: "Appearance",
  settings: [
    {
      key: "appearance.showGreeting",
      label: "Show build greeting",
      type: "boolean" as const,
      default: true,
    },
    {
      key: "appearance.density",
      label: "Row density",
      type: "enum" as const,
      default: "comfortable",
      options: [{ value: "comfortable" }, { value: "compact" }],
    },
  ],
};

describe("registerSettings", () => {
  test("registered sections appear in the settingsSections store", () => {
    registerSettings(appearance);
    const sections = get(settingsSections);
    expect(sections.length).toBe(1);
    expect(sections[0].id).toBe("appearance");
    expect(sections[0].settings.map((s) => s.key)).toEqual([
      "appearance.showGreeting",
      "appearance.density",
    ]);
  });

  test("re-registering the same section id replaces it (HMR-safe)", () => {
    registerSettings(appearance);
    registerSettings({
      ...appearance,
      settings: [appearance.settings[0]],
    });
    const sections = get(settingsSections);
    expect(sections.length).toBe(1);
    expect(sections[0].settings.length).toBe(1);
  });

  test("sections sort by order, then title", () => {
    registerSettings({ id: "z", title: "Zulu", settings: [] });
    registerSettings({ id: "a", title: "Alpha", settings: [] });
    registerSettings({ id: "first", title: "Pinned", order: 0, settings: [] });
    expect(get(settingsSections).map((s) => s.id)).toEqual(["first", "a", "z"]);
  });
});

describe("get/set/reset", () => {
  test("getSetting returns the default when nothing is stored", () => {
    registerSettings(appearance);
    expect(getSetting("appearance.showGreeting")).toBe(true);
    expect(getSetting("appearance.density")).toBe("comfortable");
  });

  test("setSetting overrides and getSetting reflects it", () => {
    registerSettings(appearance);
    setSetting("appearance.showGreeting", false);
    expect(getSetting("appearance.showGreeting")).toBe(false);
  });

  test("setSetting persists to the injected KV under one JSON blob", () => {
    registerSettings(appearance);
    setSetting("appearance.density", "compact");
    const blob = JSON.parse(kv.data["supergit:settings"]);
    expect(blob["appearance.density"]).toBe("compact");
  });

  test("values survive a reload (fresh registry, same KV)", () => {
    registerSettings(appearance);
    setSetting("appearance.showGreeting", false);
    _resetSettingsForTests();
    setSettingsKV(kv);
    registerSettings(appearance);
    expect(getSetting("appearance.showGreeting")).toBe(false);
  });

  test("isModified is true only for overridden values", () => {
    registerSettings(appearance);
    expect(isModified("appearance.showGreeting")).toBe(false);
    setSetting("appearance.showGreeting", false);
    expect(isModified("appearance.showGreeting")).toBe(true);
    // Setting back to the default still counts as not modified.
    setSetting("appearance.showGreeting", true);
    expect(isModified("appearance.showGreeting")).toBe(false);
  });

  test("resetSetting removes the override and persists the removal", () => {
    registerSettings(appearance);
    setSetting("appearance.density", "compact");
    resetSetting("appearance.density");
    expect(getSetting("appearance.density")).toBe("comfortable");
    const blob = JSON.parse(kv.data["supergit:settings"]);
    expect("appearance.density" in blob).toBe(false);
  });
});

describe("settingValue store", () => {
  test("emits the effective value and reacts to setSetting", () => {
    registerSettings(appearance);
    const store = settingValue("appearance.showGreeting");
    expect(get(store)).toBe(true);
    setSetting("appearance.showGreeting", false);
    expect(get(store)).toBe(false);
  });

  test("picks up the default once the section registers later", () => {
    const store = settingValue("appearance.density");
    expect(get(store)).toBeUndefined();
    registerSettings(appearance);
    expect(get(store)).toBe("comfortable");
  });
});

describe("action settings", () => {
  function actionSection(onInvoke: () => void) {
    return {
      id: "maintenance",
      title: "Maintenance",
      settings: [
        {
          key: "maintenance.resetWalkthrough",
          label: "Reset walkthrough",
          description: "Show the onboarding tour again",
          type: "action" as const,
          buttonLabel: "Reset",
          onInvoke,
        },
      ],
    };
  }

  test("an action def registers and renders in its section", () => {
    registerSettings(actionSection(() => {}));
    const sections = get(settingsSections);
    expect(sections[0].settings[0].key).toBe("maintenance.resetWalkthrough");
  });

  test("isActionSetting narrows action vs value defs", () => {
    registerSettings(appearance);
    registerSettings(actionSection(() => {}));
    const all = get(settingsSections);
    const action = all
      .flatMap((s) => s.settings)
      .find((d) => d.key === "maintenance.resetWalkthrough")!;
    const value = all
      .flatMap((s) => s.settings)
      .find((d) => d.key === "appearance.showGreeting")!;
    expect(isActionSetting(action)).toBe(true);
    expect(isActionSetting(value)).toBe(false);
  });

  test("actions carry no value — getSetting is undefined, never modified", () => {
    registerSettings(actionSection(() => {}));
    expect(getSetting("maintenance.resetWalkthrough")).toBeUndefined();
    expect(isModified("maintenance.resetWalkthrough")).toBe(false);
  });

  test("setSetting on an action key is a no-op (nothing persisted)", () => {
    registerSettings(actionSection(() => {}));
    setSetting("maintenance.resetWalkthrough", true);
    expect(isModified("maintenance.resetWalkthrough")).toBe(false);
    // The settings blob is never written for an action.
    expect(kv.data["supergit:settings"]).toBeUndefined();
  });

  test("the onInvoke callback is preserved and callable", () => {
    const spy = mock(() => {});
    registerSettings(actionSection(spy));
    const def = get(settingsSections)[0].settings[0];
    if (isActionSetting(def)) def.onInvoke();
    expect(spy).toHaveBeenCalledTimes(1);
  });

  test("filterSections matches an action by label and description", () => {
    const all = [actionSection(() => {})];
    expect(filterSections(all, "walkthrough").length).toBe(1);
    expect(filterSections(all, "onboarding").length).toBe(1);
    expect(filterSections(all, "no-such-thing")).toEqual([]);
  });
});

describe("slider settings", () => {
  const audio = {
    id: "sound",
    title: "Sound",
    settings: [
      {
        key: "sound.volume",
        label: "Volume",
        type: "slider" as const,
        default: 100,
        min: 0,
        max: 100,
        step: 5,
        unit: "%",
      },
    ],
  };

  test("a slider behaves as a numeric value setting (not an action)", () => {
    registerSettings(audio);
    expect(isActionSetting(audio.settings[0])).toBe(false);
    expect(getSetting("sound.volume")).toBe(100);
    setSetting("sound.volume", 60);
    expect(getSetting("sound.volume")).toBe(60);
    expect(isModified("sound.volume")).toBe(true);
  });

  test("setting a slider back to its default clears the override", () => {
    registerSettings(audio);
    setSetting("sound.volume", 60);
    setSetting("sound.volume", 100);
    expect(isModified("sound.volume")).toBe(false);
    expect(JSON.parse(kv.data["supergit:settings"] ?? "{}")).toEqual({});
  });

  test("settingValue tracks a slider reactively", () => {
    registerSettings(audio);
    const store = settingValue("sound.volume");
    expect(get(store)).toBe(100);
    setSetting("sound.volume", 25);
    expect(get(store)).toBe(25);
  });
});

describe("resetAllSettings", () => {
  test("clears every override and falls back to declared defaults", () => {
    registerSettings(appearance);
    setSetting("appearance.showGreeting", false);
    setSetting("appearance.density", "compact");
    expect(isModified("appearance.showGreeting")).toBe(true);

    resetAllSettings();

    expect(getSetting("appearance.showGreeting")).toBe(true);
    expect(getSetting("appearance.density")).toBe("comfortable");
    expect(isModified("appearance.showGreeting")).toBe(false);
    expect(isModified("appearance.density")).toBe(false);
  });

  test("persists an empty blob so the reset survives a reload", () => {
    registerSettings(appearance);
    setSetting("appearance.density", "compact");
    resetAllSettings();
    expect(JSON.parse(kv.data["supergit:settings"])).toEqual({});

    _resetSettingsForTests();
    setSettingsKV(kv);
    registerSettings(appearance);
    expect(getSetting("appearance.density")).toBe("comfortable");
  });

  test("is a no-op when nothing has been overridden", () => {
    registerSettings(appearance);
    resetAllSettings();
    expect(isModified("appearance.showGreeting")).toBe(false);
  });
});

describe("filterSections", () => {
  const sections = [
    {
      id: "appearance",
      title: "Appearance",
      settings: [
        {
          key: "appearance.showGreeting",
          label: "Show build greeting",
          description: "Version line above the menubar",
          type: "boolean" as const,
          default: true,
        },
        {
          key: "appearance.density",
          label: "Row density",
          type: "enum" as const,
          default: "comfortable",
          options: [{ value: "comfortable" }, { value: "compact" }],
        },
      ],
    },
    {
      id: "terminal",
      title: "Terminal",
      settings: [
        {
          key: "terminal.fontSize",
          label: "Font size",
          type: "number" as const,
          default: 13,
        },
      ],
    },
  ];

  test("empty query returns everything", () => {
    expect(filterSections(sections, "")).toEqual(sections);
    expect(filterSections(sections, "   ")).toEqual(sections);
  });

  test("matches on setting label, description, and key", () => {
    expect(
      filterSections(sections, "greeting")[0].settings.map((s) => s.key),
    ).toEqual(["appearance.showGreeting"]);
    expect(
      filterSections(sections, "menubar")[0].settings.map((s) => s.key),
    ).toEqual(["appearance.showGreeting"]);
    expect(filterSections(sections, "fontSize").map((s) => s.id)).toEqual([
      "terminal",
    ]);
  });

  test("a section-title match keeps all of that section's settings", () => {
    const hit = filterSections(sections, "terminal");
    expect(hit.length).toBe(1);
    expect(hit[0].settings.length).toBe(1);
    const appearanceHit = filterSections(sections, "appearance");
    expect(appearanceHit[0].settings.length).toBe(2);
  });

  test("sections with no matching settings are dropped", () => {
    expect(filterSections(sections, "density").map((s) => s.id)).toEqual([
      "appearance",
    ]);
    expect(filterSections(sections, "zzz-no-match")).toEqual([]);
  });
});
