/**
 * Classify a weekly-usage projection into the line shown under the live usage
 * bars in AgentUsageChip: "On pace for ~60% — 40% headroom",
 * "On pace to exceed limit (~120%)", "PERFECT — on pace for 100%", or the
 * early "need more data" placeholder.
 *
 * `projected` is the fraction of the weekly limit we're trending toward
 * (0.6 = 60%, 1.2 = 120%), already clamped by the caller. `isEarly` is true
 * when too little of the window has elapsed to project reliably.
 *
 * The 100% case is special: landing exactly on the limit is the IDEAL outcome
 * (full utilization, no overage), so it gets its own celebratory "PERFECT"
 * state and — load-bearing — does NOT report `isOverPace`. `isOverPace` is
 * what tints the line red and arms the over-pace warning sound; a perfect pace
 * must do neither. The perfect band is "rounds to 100%" so a projection of
 * 100.4% (which used to render as the red "exceed" label) reads as PERFECT
 * rather than alarming.
 */
export interface WeeklyPaceClass {
  label: string;
  isOverPace: boolean;
  isPerfect: boolean;
}

export function classifyWeeklyPace(
  projected: number,
  isEarly: boolean,
  hoursUntilReliable: number,
): WeeklyPaceClass {
  const pp = Math.round(projected * 100);
  const isPerfect = !isEarly && pp === 100;
  const isOverPace = projected > 1.0 && !isPerfect;

  let label: string;
  if (isEarly) {
    label = `Projection available in ~${hoursUntilReliable}h (need more data)`;
  } else if (isPerfect) {
    label = "PERFECT — on pace for 100%";
  } else if (isOverPace) {
    label = `On pace to exceed limit (~${pp}%)`;
  } else {
    label = `On pace for ~${pp}% — ${Math.round((1 - projected) * 100)}% headroom`;
  }

  return { label, isOverPace, isPerfect };
}
