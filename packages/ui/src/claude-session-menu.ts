import type { SessionMenuItem } from "./SessionMenu.svelte";
import {
  CLAUDE_MODEL_ALIASES,
  CLAUDE_EFFORT_LEVELS,
  claudeModelAlias,
} from "./storage";

/** SVG path glyphs (24×24 viewBox), rendered via SessionMenu's iconSvg
 *  slot so the menu never falls back to emoji. */
// AI "sparkle" four-point star (same mark as ICONS.ai) — the model picker.
const SPARKLE_PATH =
  "M12 1l2.35 8.65L23 12l-8.65 2.35L12 23l-2.35-8.65L1 12l8.65-2.35z";
// Lucide "zap" lightning bolt — the effort picker.
const ZAP_PATH =
  "M4 14a1 1 0 0 1-.78-1.63l9.9-10.2a.5.5 0 0 1 .86.46l-1.92 6.02A1 1 0 0 0 13 10h7a1 1 0 0 1 .78 1.63l-9.9 10.2a.5.5 0 0 1-.86-.46l1.92-6.02A1 1 0 0 0 11 14z";

/** Speedometer geometry (24×24 viewBox, vertically centred). The coloured
 *  arc sweeps the top semicircle from the left (min) toward the right
 *  (max), filling a larger fraction as the effort level rises. */
const G_CX = 12;
const G_CY = 17.25;
const G_R_OUTER = 10.5;
const G_R_INNER = 6.5;

function polar(r: number, deg: number): [number, number] {
  const a = (deg * Math.PI) / 180;
  // SVG y grows downward, so negate the sine to sweep over the top.
  return [G_CX + r * Math.cos(a), G_CY - r * Math.sin(a)];
}
const r2 = (n: number) => Math.round(n * 100) / 100;

/** A filled annular sector ("gauge arc") covering `fraction` (0..1) of the
 *  top semicircle, anchored at the left (min) end. Single closed path so
 *  it renders solid through SessionMenu's filled-icon slot. */
function gaugeArcPath(fraction: number): string {
  const f = Math.max(0, Math.min(1, fraction));
  const startDeg = 180; // left end (min)
  const endDeg = 180 * (1 - f); // sweeps toward 0° (right / max)
  const [ox1, oy1] = polar(G_R_OUTER, startDeg);
  const [ox2, oy2] = polar(G_R_OUTER, endDeg);
  const [ix2, iy2] = polar(G_R_INNER, endDeg);
  const [ix1, iy1] = polar(G_R_INNER, startDeg);
  return (
    `M${r2(ox1)} ${r2(oy1)}` +
    `A${G_R_OUTER} ${G_R_OUTER} 0 0 1 ${r2(ox2)} ${r2(oy2)}` +
    `L${r2(ix2)} ${r2(iy2)}` +
    `A${G_R_INNER} ${G_R_INNER} 0 0 0 ${r2(ix1)} ${r2(iy1)}Z`
  );
}

const EFFORT_META: Record<string, { fraction: number; color: string }> = {
  low: { fraction: 0.2, color: "#6cc070" },
  medium: { fraction: 0.4, color: "#c9c24a" },
  high: { fraction: 0.6, color: "#e0a13a" },
  xhigh: { fraction: 0.8, color: "#e07b3a" },
  max: { fraction: 1, color: "#e0533a" },
};

/** The full gauge sweep, drawn dim/neutral behind the coloured fill so the
 *  glyph reads as a gauge (not a floating sliver) even at low effort. */
const GAUGE_TRACK = gaugeArcPath(1);

/** The colour-coded gauge glyph for an effort level — the same mark the
 *  Effort menu uses. `trackPaths` is the full dim sweep; `paths` is the
 *  coloured fill up to the level. Returned for reuse in the agent pill
 *  (shown after the model name). Returns undefined for an unset/unknown
 *  effort, so the pill simply omits the icon on the default. */
export function effortIcon(
  effort: string | undefined,
): { trackPaths: string[]; paths: string[]; color: string } | undefined {
  if (!effort) return undefined;
  const meta = EFFORT_META[effort];
  if (!meta) return undefined;
  return {
    trackPaths: [GAUGE_TRACK],
    paths: [gaugeArcPath(meta.fraction)],
    color: meta.color,
  };
}

/** Builds the "Claude: Model" + "Claude: Effort" submenu entries for a
 *  Claude session's header burger. Shared by NewSessionCol (brand-new
 *  TUI) and SessionView (resumed TUI) so the two surfaces never drift.
 *  The option currently enabled for the session carries a trailing check:
 *
 *   - model: the persisted `currentModel` override wins; when absent we
 *     fall back to the tier alias of the model the JSONL reports
 *     (`detectedModel`), so a session that's running on its default model
 *     still shows which tier is live.
 *   - effort: there's no detection channel for effort, so only an explicit
 *     `currentEffort` override is ticked. Levels are listed high→low.
 *
 *  Picking an item is what triggers the "restart via resume" — the
 *  callbacks just persist the choice; the caller re-spawns. */
export function claudeSessionMenuItems(opts: {
  currentModel: string | undefined;
  detectedModel: string | undefined;
  currentEffort: string | undefined;
  onPickModel: (model: string) => void;
  onPickEffort: (effort: string) => void;
}): SessionMenuItem[] {
  const activeModel = opts.currentModel ?? claudeModelAlias(opts.detectedModel);
  // High effort at the top, low at the bottom.
  const effortsHighToLow = [...CLAUDE_EFFORT_LEVELS].reverse();
  return [
    {
      kind: "submenu",
      label: "Claude: Model",
      iconSvg: [SPARKLE_PATH],
      iconFilled: true,
      title:
        "Switch the model for this Claude session — restarts it via resume",
      children: CLAUDE_MODEL_ALIASES.map((m) => ({
        kind: "action" as const,
        label: m,
        selected: activeModel === m,
        title: `Use ${m} for this session`,
        onSelect: () => opts.onPickModel(m),
      })),
    },
    {
      kind: "submenu",
      label: "Claude: Effort",
      iconSvg: [ZAP_PATH],
      iconFilled: true,
      title:
        "Set the reasoning effort for this Claude session — restarts it via resume",
      children: effortsHighToLow.map((e) => {
        const meta = EFFORT_META[e]!;
        return {
          kind: "action" as const,
          label: e,
          iconTrackPaths: [GAUGE_TRACK],
          iconSvg: [gaugeArcPath(meta.fraction)],
          iconFilled: true,
          iconColor: meta.color,
          selected: opts.currentEffort === e,
          title: `Set effort to ${e}`,
          onSelect: () => opts.onPickEffort(e),
        };
      }),
    },
  ];
}

/** One selectable option in an agent-settings group. `selected` marks the
 *  value currently in effect; `icon` (optional) carries the same gauge
 *  glyph the menu/pill use (track + coloured fill). */
export interface AgentSettingOption {
  value: string;
  label: string;
  selected: boolean;
  icon?: { trackPaths: string[]; paths: string[]; color: string };
}
/** A labelled group of mutually-exclusive options (e.g. Model, Effort). */
export interface AgentSettingGroup {
  key: string;
  label: string;
  options: AgentSettingOption[];
  onPick: (value: string) => void;
}

/** The agent-pill settings-popover model for a Claude session. Mirrors
 *  `claudeSessionMenuItems` (same constants, same active-state rules, same
 *  effort gauge + high→low order) so the popover and the burger menu can't
 *  drift — it's just a flatter, more visual shape for the popover UI. */
export function claudeAgentSettings(opts: {
  currentModel: string | undefined;
  detectedModel: string | undefined;
  currentEffort: string | undefined;
  onPickModel: (model: string) => void;
  onPickEffort: (effort: string) => void;
}): AgentSettingGroup[] {
  const activeModel = opts.currentModel ?? claudeModelAlias(opts.detectedModel);
  return [
    {
      key: "model",
      label: "Model",
      onPick: opts.onPickModel,
      options: CLAUDE_MODEL_ALIASES.map((m) => ({
        value: m,
        label: m,
        selected: activeModel === m,
      })),
    },
    {
      key: "effort",
      label: "Effort",
      onPick: opts.onPickEffort,
      // Low → max (ascending), so the gauge fill grows left-to-right like a
      // real speedometer. (The burger menu lists them high→low instead.)
      options: CLAUDE_EFFORT_LEVELS.map((e) => ({
        value: e,
        label: e,
        selected: opts.currentEffort === e,
        icon: effortIcon(e),
      })),
    },
  ];
}
