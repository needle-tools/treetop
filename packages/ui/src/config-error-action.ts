/**
 * State + presentation logic for the per-terminal "config error" pill.
 *
 * When Claude Code refuses to start because a config file (e.g.
 * .claude.json) contains invalid JSON, the daemon surfaces a `{file}`
 * marker and TerminalView renders a pill with Open / Repair / Dismiss
 * actions.
 *
 * Clicking an action no longer makes the pill vanish with no feedback:
 * the pill stays visible, marks the chosen action, shows a spinner while
 * the daemon works, then shows a one-word confirmation (or an error).
 * This module is the pure core of that interaction so it can be
 * unit-tested without a DOM.
 */

export type ConfigActionKind = "open" | "repair" | "dismiss";
export type ConfigActionPhase = "pending" | "done" | "error";

export interface ConfigActionState {
  kind: ConfigActionKind;
  phase: ConfigActionPhase;
  /** Short label shown in place of the chosen button's caption. */
  message: string;
}

const LABELS: Record<ConfigActionKind, Record<ConfigActionPhase, string>> = {
  open: { pending: "Opening…", done: "Opened", error: "Couldn't open" },
  repair: { pending: "Repairing…", done: "Repaired", error: "Repair failed" },
  dismiss: { pending: "Dismissing…", done: "Dismissed", error: "Failed" },
};

/** Begin an action — the chosen button shows a spinner, the rest lock. */
export function startConfigAction(kind: ConfigActionKind): ConfigActionState {
  return { kind, phase: "pending", message: LABELS[kind].pending };
}

/**
 * Settle the in-flight action. `ok` decides done vs error; an explicit
 * `message` overrides the default label (e.g. to fold in the daemon's
 * "via notepad" detail or its error text).
 */
export function settleConfigAction(
  state: ConfigActionState,
  ok: boolean,
  message?: string,
): ConfigActionState {
  const phase: ConfigActionPhase = ok ? "done" : "error";
  return {
    kind: state.kind,
    phase,
    message: message ?? LABELS[state.kind][phase],
  };
}

export interface ButtonView {
  /** This button is the one the user clicked. */
  active: boolean;
  /** Show a spinner glyph (this action is in flight). */
  spinner: boolean;
  /** Disable clicks. */
  disabled: boolean;
  /** Phase driving iconography/styling for this button. */
  phase: ConfigActionPhase | "idle";
}

/**
 * Derive how a single button should render given the current action.
 *
 * Locking rules:
 *  - While anything is pending, every button is disabled and the chosen
 *    one spins.
 *  - "open" is non-committing (it just launches an editor), so once it
 *    settles every button re-enables — the user can still Repair/Dismiss.
 *  - "repair"/"dismiss" commit the session (they send the keystroke that
 *    exits Claude), so once chosen the whole pill stays locked.
 */
export function configButtonView(
  button: ConfigActionKind,
  action: ConfigActionState | null,
): ButtonView {
  if (!action) {
    return { active: false, spinner: false, disabled: false, phase: "idle" };
  }
  const active = action.kind === button;
  const pending = action.phase === "pending";
  const committed = !pending && action.kind !== "open";
  return {
    active,
    spinner: active && pending,
    disabled: pending || committed,
    phase: active ? action.phase : "idle",
  };
}
