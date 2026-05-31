/**
 * The UI-idle gate is what tells visible-fetch, the transient-session
 * poller, and any future opt-in background refresher whether the user
 * is still around to care. Getting this wrong in either direction is
 * bad: too aggressive about "idle" and the dashboard goes stale while
 * the user is reading it; too lax and we keep paying the polling cost
 * with the laptop lid closed.
 */

import { test, expect, describe } from "bun:test";
import {
  ACTIVITY_IDLE_MS,
  bumpActivityWith,
  createIdleStateForTest,
  isUiIdleWith,
  onIdleChangeWith,
  onResumeWith,
  setHiddenWith,
  syncIdleWith,
} from "../src/ui-idle";

describe("ui-idle gate", () => {
  test("starts non-idle (fresh activity timestamp)", () => {
    let now = 1000;
    const s = createIdleStateForTest(() => now);
    expect(isUiIdleWith(s)).toBe(false);
  });

  test("becomes idle after ACTIVITY_IDLE_MS of quiet", () => {
    let now = 0;
    const s = createIdleStateForTest(() => now);
    bumpActivityWith(s);
    now += ACTIVITY_IDLE_MS - 1;
    expect(isUiIdleWith(s)).toBe(false);
    now += 2;
    expect(isUiIdleWith(s)).toBe(true);
  });

  test("activity resets the idle clock", () => {
    let now = 0;
    const s = createIdleStateForTest(() => now);
    bumpActivityWith(s);
    now += ACTIVITY_IDLE_MS + 100;
    expect(isUiIdleWith(s)).toBe(true);
    bumpActivityWith(s);
    expect(isUiIdleWith(s)).toBe(false);
  });

  test("hidden tab forces idle even with fresh activity", () => {
    let now = 0;
    const s = createIdleStateForTest(() => now);
    bumpActivityWith(s);
    setHiddenWith(s, true);
    expect(isUiIdleWith(s)).toBe(true);
    setHiddenWith(s, false);
    expect(isUiIdleWith(s)).toBe(false);
  });

  test("onResume fires when activity wakes the tab from idle", () => {
    let now = 0;
    const s = createIdleStateForTest(() => now);
    let resumeCount = 0;
    onResumeWith(s, () => resumeCount++);

    // Go idle by waiting past the threshold.
    bumpActivityWith(s);
    now += ACTIVITY_IDLE_MS + 100;
    expect(isUiIdleWith(s)).toBe(true);

    // First activity after idle fires the resume listener.
    bumpActivityWith(s);
    expect(resumeCount).toBe(1);

    // Subsequent activity while non-idle does NOT re-fire.
    now += 100;
    bumpActivityWith(s);
    expect(resumeCount).toBe(1);
  });

  test("onResume fires when tab becomes visible after being hidden", () => {
    let now = 0;
    const s = createIdleStateForTest(() => now);
    let resumeCount = 0;
    onResumeWith(s, () => resumeCount++);

    setHiddenWith(s, true);
    expect(isUiIdleWith(s)).toBe(true);

    setHiddenWith(s, false);
    expect(resumeCount).toBe(1);
  });

  test("onResume does NOT fire if user was already active when tab visible", () => {
    let now = 0;
    const s = createIdleStateForTest(() => now);
    let resumeCount = 0;
    onResumeWith(s, () => resumeCount++);

    bumpActivityWith(s);
    // No idle period — toggling visibility off+on should not fire
    // resume because we never became idle from the perspective of the
    // listener. (The hidden→visible transition still bumps the clock,
    // which IS the desired behavior; we only care that we don't get
    // spurious resume callbacks when the user wasn't actually away.)
    setHiddenWith(s, false);
    expect(resumeCount).toBe(0);
  });

  test("onResume teardown removes the listener", () => {
    let now = 0;
    const s = createIdleStateForTest(() => now);
    let resumeCount = 0;
    const off = onResumeWith(s, () => resumeCount++);
    off();

    bumpActivityWith(s);
    now += ACTIVITY_IDLE_MS + 100;
    bumpActivityWith(s);
    expect(resumeCount).toBe(0);
  });

  test("multiple onResume listeners all fire on wake", () => {
    let now = 0;
    const s = createIdleStateForTest(() => now);
    let a = 0;
    let b = 0;
    onResumeWith(s, () => a++);
    onResumeWith(s, () => b++);

    bumpActivityWith(s);
    now += ACTIVITY_IDLE_MS + 100;
    bumpActivityWith(s);
    expect(a).toBe(1);
    expect(b).toBe(1);
  });

  test("a throwing listener doesn't stop the others", () => {
    let now = 0;
    const s = createIdleStateForTest(() => now);
    let b = 0;
    onResumeWith(s, () => {
      throw new Error("boom");
    });
    onResumeWith(s, () => b++);

    bumpActivityWith(s);
    now += ACTIVITY_IDLE_MS + 100;
    bumpActivityWith(s);
    expect(b).toBe(1);
  });
});

/**
 * onIdleChange is the push edge that drives the `body.ui-idle` class,
 * which in turn pauses the *decorative* always-on CSS animations
 * (status-badge edge-flow, walkthrough pulse, ...) once the user has
 * been inactive for ACTIVITY_IDLE_MS. Functional spinners are not
 * tagged, so they keep moving — this gate only governs the ambient
 * stuff. It must fire exactly on transitions: a missed edge leaves the
 * class stuck (animations frozen while the user is active, or burning
 * CPU after they've left).
 */
describe("ui-idle change notifications (body.ui-idle driver)", () => {
  test("fires idle=true only when activity goes stale, once per edge", () => {
    let now = 0;
    const s = createIdleStateForTest(() => now);
    const seen: boolean[] = [];
    onIdleChangeWith(s, (idle) => seen.push(idle));

    bumpActivityWith(s); // still active — no transition, no fire
    expect(seen).toEqual([]);

    now += ACTIVITY_IDLE_MS + 1;
    syncIdleWith(s); // crossed into idle (the timer-driven edge)
    expect(seen).toEqual([true]);

    syncIdleWith(s); // still idle — must not re-fire
    expect(seen).toEqual([true]);
  });

  test("fires idle=false when the user resumes activity", () => {
    let now = 0;
    const s = createIdleStateForTest(() => now);
    const seen: boolean[] = [];
    onIdleChangeWith(s, (idle) => seen.push(idle));

    now += ACTIVITY_IDLE_MS + 1;
    syncIdleWith(s);
    bumpActivityWith(s); // activity recomputes and clears idle
    expect(seen).toEqual([true, false]);
  });

  test("hidden / visible transitions drive the idle class too", () => {
    let now = 0;
    const s = createIdleStateForTest(() => now);
    const seen: boolean[] = [];
    onIdleChangeWith(s, (idle) => seen.push(idle));

    setHiddenWith(s, true);
    setHiddenWith(s, false);
    expect(seen).toEqual([true, false]);
  });

  test("teardown stops further notifications", () => {
    let now = 0;
    const s = createIdleStateForTest(() => now);
    const seen: boolean[] = [];
    const off = onIdleChangeWith(s, (idle) => seen.push(idle));
    off();
    setHiddenWith(s, true);
    expect(seen).toEqual([]);
  });

  test("a throwing idle listener doesn't stop the others", () => {
    const s = createIdleStateForTest(() => 0);
    let b = 0;
    onIdleChangeWith(s, () => {
      throw new Error("boom");
    });
    onIdleChangeWith(s, () => {
      b++;
    });
    setHiddenWith(s, true);
    expect(b).toBe(1);
  });
});
