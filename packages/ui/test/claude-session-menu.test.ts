import { test, expect, describe } from "bun:test";
import {
  claudeSessionMenuItems,
  claudeAgentSettings,
  codexAccessOptions,
  codexAccessValue,
  codexAgentSettings,
  parseCodexAccessValue,
  effortIcon,
} from "../src/claude-session-menu";
import type { SessionMenuItem } from "../src/SessionMenu.svelte";

function noop() {}

/** Labels of the children flagged as the currently-active option (the
 *  trailing-check marker). */
function selectedLabels(item: SessionMenuItem | undefined): string[] {
  if (item?.kind !== "submenu") throw new Error("expected submenu");
  return item.children
    .filter((c) => c.kind === "action" && c.selected)
    .map((c) => c.label);
}

describe("claudeSessionMenuItems", () => {
  test("produces a Claude: Model and Claude: Effort submenu, both filled SVG", () => {
    const items = claudeSessionMenuItems({
      currentModel: undefined,
      detectedModel: undefined,
      currentEffort: undefined,
      onPickModel: noop,
      onPickEffort: noop,
    });
    expect(items.map((i) => i.label)).toEqual([
      "Claude: Model",
      "Claude: Effort",
    ]);
    expect(items.every((i) => i.kind === "submenu")).toBe(true);
    // Headers carry a filled SVG glyph (not emoji).
    for (const header of items) {
      expect(header.iconSvg && header.iconSvg.length > 0).toBe(true);
      expect(header.iconFilled).toBe(true);
    }
  });

  test("Model submenu offers opus / sonnet / haiku", () => {
    const [model] = claudeSessionMenuItems({
      currentModel: undefined,
      detectedModel: undefined,
      currentEffort: undefined,
      onPickModel: noop,
      onPickEffort: noop,
    });
    if (model?.kind !== "submenu") throw new Error("expected submenu");
    expect(model.children.map((c) => c.label)).toEqual([
      "opus",
      "sonnet",
      "haiku",
    ]);
  });

  test("Effort submenu lists levels high→low (max at top, low at bottom)", () => {
    const [, effort] = claudeSessionMenuItems({
      currentModel: undefined,
      detectedModel: undefined,
      currentEffort: undefined,
      onPickModel: noop,
      onPickEffort: noop,
    });
    if (effort?.kind !== "submenu") throw new Error("expected submenu");
    expect(effort.children.map((c) => c.label)).toEqual([
      "max",
      "xhigh",
      "high",
      "medium",
      "low",
    ]);
  });

  test("effort levels are colour-coded filled gauge glyphs that grow per level", () => {
    const [, effort] = claudeSessionMenuItems({
      currentModel: undefined,
      detectedModel: undefined,
      currentEffort: undefined,
      onPickModel: noop,
      onPickEffort: noop,
    });
    if (effort?.kind !== "submenu") throw new Error("expected submenu");
    // Distinct colours, all set.
    const colors = effort.children.map((c) =>
      c.kind === "action" ? c.iconColor : undefined,
    );
    expect(colors.every((c) => typeof c === "string" && c.length > 0)).toBe(
      true,
    );
    expect(new Set(colors).size).toBe(colors.length);
    // Each level is a single filled gauge-arc path…
    expect(effort.children.every((c) => c.iconSvg?.length === 1)).toBe(true);
    expect(effort.children.every((c) => c.iconFilled === true)).toBe(true);
    // …over a shared dim full-sweep track (same for every level)…
    const tracks = effort.children.map((c) => c.iconTrackPaths?.[0]);
    expect(tracks.every((t) => typeof t === "string" && t.length > 0)).toBe(
      true,
    );
    expect(new Set(tracks).size).toBe(1);
    // …and the fill arc geometry differs per level (a growing sweep), so no
    // two levels render the same coloured glyph.
    const arcs = effort.children.map((c) => c.iconSvg?.[0]);
    expect(new Set(arcs).size).toBe(arcs.length);
  });

  test("uses SVG icons throughout — never emoji/unicode glyphs", () => {
    const items = claudeSessionMenuItems({
      currentModel: "opus",
      detectedModel: undefined,
      currentEffort: "high",
      onPickModel: noop,
      onPickEffort: noop,
    });
    const all: SessionMenuItem[] = [
      ...items,
      ...items.flatMap((i) => (i.kind === "submenu" ? i.children : [])),
    ];
    for (const it of all) {
      expect((it as { icon?: string }).icon).toBeUndefined();
    }
  });

  test("checkmarks the model currently enabled (persisted override wins)", () => {
    const [model] = claudeSessionMenuItems({
      currentModel: "sonnet",
      detectedModel: "claude-opus-4-8",
      currentEffort: undefined,
      onPickModel: noop,
      onPickEffort: noop,
    });
    expect(selectedLabels(model)).toEqual(["sonnet"]);
  });

  test("checkmarks the detected model's tier when no override is set", () => {
    const [model] = claudeSessionMenuItems({
      currentModel: undefined,
      detectedModel: "claude-haiku-4-5-20251001",
      currentEffort: undefined,
      onPickModel: noop,
      onPickEffort: noop,
    });
    expect(selectedLabels(model)).toEqual(["haiku"]);
  });

  test("checkmarks nothing when neither override nor detected model is known", () => {
    const [model] = claudeSessionMenuItems({
      currentModel: undefined,
      detectedModel: undefined,
      currentEffort: undefined,
      onPickModel: noop,
      onPickEffort: noop,
    });
    expect(selectedLabels(model)).toEqual([]);
  });

  test("checkmarks only the effort override", () => {
    const [, effort] = claudeSessionMenuItems({
      currentModel: undefined,
      detectedModel: "claude-opus-4-8",
      currentEffort: "max",
      onPickModel: noop,
      onPickEffort: noop,
    });
    expect(selectedLabels(effort)).toEqual(["max"]);
  });

  test("checkmarks no effort when none is set (no detection channel)", () => {
    const [, effort] = claudeSessionMenuItems({
      currentModel: undefined,
      detectedModel: "claude-opus-4-8",
      currentEffort: undefined,
      onPickModel: noop,
      onPickEffort: noop,
    });
    expect(selectedLabels(effort)).toEqual([]);
  });

  test("effortIcon returns a colour-coded gauge arc, or undefined when unset", () => {
    expect(effortIcon(undefined)).toBeUndefined();
    expect(effortIcon("")).toBeUndefined();
    expect(effortIcon("bogus")).toBeUndefined();
    const low = effortIcon("low");
    const max = effortIcon("max");
    // One filled arc path per level; the sweep (path geometry) and colour
    // both differ between low and max.
    expect(low?.paths.length).toBe(1);
    expect(max?.paths.length).toBe(1);
    expect(low?.paths[0]).not.toBe(max?.paths[0]);
    expect(typeof low?.color).toBe("string");
    expect(low?.color).not.toBe(max?.color);
    // Both carry the same full-sweep dim track behind the coloured fill.
    expect(low?.trackPaths.length).toBe(1);
    expect(low?.trackPaths[0]).toBe(max?.trackPaths[0]);
    // max's fill arc is the full sweep, so it equals the track geometry.
    expect(max?.paths[0]).toBe(max?.trackPaths[0]);
  });

  test("picking an item invokes the matching callback", () => {
    let pickedModel: string | undefined;
    let pickedEffort: string | undefined;
    const [model, effort] = claudeSessionMenuItems({
      currentModel: undefined,
      detectedModel: undefined,
      currentEffort: undefined,
      onPickModel: (m) => (pickedModel = m),
      onPickEffort: (e) => (pickedEffort = e),
    });
    if (model?.kind !== "submenu" || effort?.kind !== "submenu") {
      throw new Error("expected submenus");
    }
    const opus = model.children.find((c) => c.label === "opus");
    const high = effort.children.find((c) => c.label === "high");
    if (opus?.kind !== "action" || high?.kind !== "action") {
      throw new Error("expected action children");
    }
    const rect = {} as DOMRect;
    opus.onSelect(rect);
    high.onSelect(rect);
    expect(pickedModel).toBe("opus");
    expect(pickedEffort).toBe("high");
  });
});

describe("claudeAgentSettings (pill popover model)", () => {
  function build(overrides: Partial<Parameters<typeof claudeAgentSettings>[0]> = {}) {
    return claudeAgentSettings({
      currentModel: undefined,
      detectedModel: undefined,
      currentEffort: undefined,
      onPickModel: () => {},
      onPickEffort: () => {},
      ...overrides,
    });
  }

  test("exposes a Model group and an Effort group", () => {
    const groups = build();
    expect(groups.map((g) => g.key)).toEqual(["model", "effort"]);
    expect(groups.map((g) => g.label)).toEqual(["Model", "Effort"]);
  });

  test("Model options are opus/sonnet/haiku; Effort is low→max (popover order)", () => {
    const [model, effort] = build();
    expect(model!.options.map((o) => o.value)).toEqual(["opus", "sonnet", "haiku"]);
    // The popover lists effort ascending (gauge grows left→right); the
    // burger menu lists it high→low — they intentionally differ.
    expect(effort!.options.map((o) => o.value)).toEqual([
      "low",
      "medium",
      "high",
      "xhigh",
      "max",
    ]);
  });

  test("mirrors the menu's selected state (override wins, else detected tier)", () => {
    const [model] = build({ currentModel: "sonnet", detectedModel: "claude-opus-4-8" });
    expect(model!.options.filter((o) => o.selected).map((o) => o.value)).toEqual([
      "sonnet",
    ]);
    const [model2] = build({ detectedModel: "claude-haiku-4-5" });
    expect(model2!.options.filter((o) => o.selected).map((o) => o.value)).toEqual([
      "haiku",
    ]);
  });

  test("Effort selection reflects only an explicit override, with gauge icons", () => {
    const [, effort] = build({ currentEffort: "high" });
    expect(effort!.options.filter((o) => o.selected).map((o) => o.value)).toEqual([
      "high",
    ]);
    // Every effort option carries a gauge icon (track + coloured fill).
    expect(
      effort!.options.every(
        (o) => o.icon && o.icon.paths.length === 1 && o.icon.trackPaths.length === 1,
      ),
    ).toBe(true);
    // Model options have no icon.
    const [model] = build();
    expect(model!.options.every((o) => o.icon === undefined)).toBe(true);
  });

  test("onPick fires the matching group callback", () => {
    let m: string | undefined;
    let e: string | undefined;
    const [model, effort] = build({
      onPickModel: (v) => (m = v),
      onPickEffort: (v) => (e = v),
    });
    model!.onPick("opus");
    effort!.onPick("max");
    expect(m).toBe("opus");
    expect(e).toBe("max");
  });

  test("agrees with the menu builder on model selection (no drift)", () => {
    const args = {
      currentModel: undefined,
      detectedModel: "claude-sonnet-4-6",
      currentEffort: "xhigh" as string,
      onPickModel: () => {},
      onPickEffort: () => {},
    };
    const [menuModel] = claudeSessionMenuItems(args);
    const [popModel] = claudeAgentSettings(args);
    const menuSelected =
      menuModel?.kind === "submenu"
        ? menuModel.children.filter((c) => c.kind === "action" && c.selected).map((c) => c.label)
        : [];
    const popSelected = popModel!.options.filter((o) => o.selected).map((o) => o.value);
    expect(popSelected).toEqual(menuSelected);
    expect(popSelected).toEqual(["sonnet"]);
  });
});

describe("codexAgentSettings", () => {
  function build(overrides: Partial<Parameters<typeof codexAgentSettings>[0]> = {}) {
    return codexAgentSettings({
      models: [
        {
          id: "gpt-5-codex",
          displayName: "GPT-5 Codex",
          isDefault: true,
          defaultReasoningEffort: "medium",
        },
        {
          id: "gpt-5-codex-mini",
          displayName: "GPT-5 Codex Mini",
          defaultReasoningEffort: "low",
        },
      ],
      detectedModel: undefined,
      currentModel: "",
      modelsLoading: false,
      modelsError: "",
      currentEffort: "",
      currentSummary: "auto",
      currentSandbox: "workspaceWrite",
      currentApproval: "on-request",
      onPickModel: () => {},
      onPickEffort: () => {},
      onPickSummary: () => {},
      onPickSandbox: () => {},
      onPickApproval: () => {},
      ...overrides,
    });
  }

  test("exposes model, reasoning, summary, sandbox, and approval groups", () => {
    expect(build().map((g) => [g.key, g.label])).toEqual([
      ["codex-model", "Model"],
      ["codex-effort", "Reasoning"],
      ["codex-summary", "Summary"],
      ["codex-sandbox", "Sandbox"],
      ["codex-approval", "Approvals"],
    ]);
  });

  test("model options include Default plus app-server models and preserve the active model", () => {
    const [model] = build({ currentModel: "gpt-5-codex-mini" });
    expect(model!.options.map((o) => o.value)).toEqual([
      "",
      "gpt-5-codex",
      "gpt-5-codex-mini",
    ]);
    expect(model!.options.filter((o) => o.selected).map((o) => o.value)).toEqual([
      "gpt-5-codex-mini",
    ]);
    expect(model!.options[0]!.label).toBe("Default (GPT-5 Codex)");
  });

  test("current and detected models are kept even when the model endpoint omits them", () => {
    const [model] = build({
      models: [],
      detectedModel: "gpt-detected",
      currentModel: "gpt-picked",
    });
    expect(model!.options.map((o) => o.value)).toEqual([
      "",
      "gpt-detected",
      "gpt-picked",
    ]);
    expect(model!.options.filter((o) => o.selected).map((o) => o.value)).toEqual([
      "gpt-picked",
    ]);
  });

  test("reasoning budget options show the resolved app-server default when known", () => {
    const [, effort] = build({ currentEffort: "medium" });
    expect(effort!.options.map((o) => o.value)).toEqual([
      "",
      "speed",
      "minimal",
      "low",
      "medium",
      "high",
      "xhigh",
    ]);
    expect(effort!.options[0]!.label).toBe("Default (medium)");
    expect(effort!.options.at(-1)!.label).toBe("extra high");
    expect(effort!.options.filter((o) => o.selected).map((o) => o.value)).toEqual([
      "medium",
    ]);
  });

  test("reasoning default follows the explicitly selected model when app-server reports one", () => {
    const [, effort] = build({ currentModel: "gpt-5-codex-mini" });
    expect(effort!.options[0]!.label).toBe("Default (low)");
  });

  test("onPick callbacks route through the matching Codex group", () => {
    const picked: string[] = [];
    const groups = build({
      onPickModel: (v) => picked.push(`model:${v}`),
      onPickEffort: (v) => picked.push(`effort:${v}`),
      onPickSummary: (v) => picked.push(`summary:${v}`),
      onPickSandbox: (v) => picked.push(`sandbox:${v}`),
      onPickApproval: (v) => picked.push(`approval:${v}`),
    });
    for (const group of groups) group.onPick(group.options.at(-1)!.value);
    expect(picked).toEqual([
      "model:gpt-5-codex-mini",
      "effort:xhigh",
      "summary:none",
      "sandbox:dangerFullAccess",
      "approval:never",
    ]);
  });
});

describe("codexAccessOptions", () => {
  test("combines sandbox and approval into one footer-friendly value", () => {
    expect(codexAccessValue("workspaceWrite", "on-request")).toBe(
      "workspaceWrite|on-request",
    );
    expect(parseCodexAccessValue("dangerFullAccess|never")).toEqual({
      sandbox: "dangerFullAccess",
      approval: "never",
    });
    expect(parseCodexAccessValue("bad")).toBeUndefined();
  });

  test("selects a known access preset", () => {
    const options = codexAccessOptions({
      currentSandbox: "workspaceWrite",
      currentApproval: "on-request",
    });
    expect(options.filter((o) => o.selected).map((o) => o.value)).toEqual([
      "workspaceWrite|on-request",
    ]);
  });

  test("keeps unusual existing combinations as a custom selected option", () => {
    const options = codexAccessOptions({
      currentSandbox: "readOnly",
      currentApproval: "never",
    });
    expect(options[0]).toEqual({
      value: "readOnly|never",
      label: "Custom · readOnly / never",
      selected: true,
    });
  });
});
