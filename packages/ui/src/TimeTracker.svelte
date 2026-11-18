<script lang="ts">
  import { onMount } from "svelte";
  import { apiUrl } from "./api";
  import Timelapse from "./Timelapse.svelte";
  import {
    WorkActivity,
    workHistory,
    splitWorkDays,
    workDay,
    type WorkDayInterval,
  } from "./work-time";

  export let projects: Array<{ id: string; name: string }> = [];
  type Total = { day: string; repoId: string; ms: number };
  const activity = new WorkActivity();
  let rows: Total[] = [],
    pending: WorkDayInterval[] = [],
    sending: WorkDayInterval[] = [];
  let paused = false,
    loaded = false,
    running = false,
    now = Date.now(),
    today = workDay();
  let dialog: HTMLDialogElement;
  let date = today,
    error = "",
    busy = false;
  let selectedProject = "",
    lastTick = Date.now(),
    lastPointer: { x: number; y: number } | undefined;
  let flushing: Promise<void> | undefined;
  let liveTail = 0;
  let away = false;
  const format = (ms: number) => {
    const s = Math.floor(Math.max(0, ms) / 1000);
    return `${String(Math.floor(s / 3600)).padStart(2, "0")}:${String(Math.floor(s / 60) % 60).padStart(2, "0")}:${String(s % 60).padStart(2, "0")}`;
  };
  $: optimistic = [...pending, ...sending];
  $: todayMs =
    rows.filter((r) => r.day === today).reduce((n, r) => n + r.ms, 0) +
    optimistic
      .filter((r) => r.day === today)
      .reduce((n, r) => n + r.end - r.start, 0) +
    liveTail;
  $: projectRows = [
    ...new Set([
      ...rows.filter((r) => r.day === date).map((r) => r.repoId),
      ...optimistic.filter((r) => r.day === date).map((r) => r.repoId),
      ...(date === today && running ? [activity.project()] : []),
    ]),
  ]
    .map((repoId) => ({
      repoId,
      name:
        projects.find((p) => p.id === repoId)?.name ??
        (repoId ? "Removed project" : "Treetop"),
      ms:
        rows
          .filter((r) => r.day === date && r.repoId === repoId)
          .reduce((n, r) => n + r.ms, 0) +
        optimistic
          .filter((r) => r.day === date && r.repoId === repoId)
          .reduce((n, r) => n + r.end - r.start, 0) +
        (date === today && activity.project() === repoId ? liveTail : 0),
    }))
    .sort((a, b) => b.ms - a.ms);

  $: history = workHistory(
    [
      ...rows,
      ...optimistic.map((row) => ({ day: row.day, ms: row.end - row.start })),
      { day: today, ms: liveTail },
    ],
    today,
  );
  const hours = (ms: number) =>
    `${(ms / 3600000).toLocaleString(undefined, { maximumFractionDigits: 1 })}h`;
  const dayLabel = (day: string) =>
    new Date(day + "T12:00:00").toLocaleDateString(undefined, {
      day: "numeric",
      month: "short",
      year: "numeric",
    });
  function collect(at = Date.now()) {
    const added = splitWorkDays(activity.drain(at));
    for (const row of added) {
      const prev = pending.at(-1);
      if (
        prev?.repoId === row.repoId &&
        prev.day === row.day &&
        prev.end === row.start &&
        row.end - prev.start <= 60_000
      )
        prev.end = row.end;
      else pending.push(row);
    }
    if (added.length) pending = [...pending];
  }
  function reset(at = Date.now()) {
    collect(at);
    activity.reset();
    running = false;
    liveTail = 0;
    lastPointer = undefined;
  }
  function apply(snapshot: { rows: Total[]; paused: boolean }) {
    rows = snapshot.rows;
    if (snapshot.paused !== paused) {
      reset();
      paused = snapshot.paused;
    }
    loaded = true;
  }
  async function load() {
    const r = await fetch(apiUrl("/api/work-time"));
    if (!r.ok) throw new Error(`Time tracker unavailable (HTTP ${r.status})`);
    apply(await r.json());
  }
  async function flush() {
    if (flushing) return flushing;
    collect();
    flushing = (async () => {
      if (!pending.length) {
        await load();
        return;
      }
      sending = pending.slice(0, 2000);
      pending = pending.slice(2000);
      try {
        const r = await fetch(apiUrl("/api/work-time"), {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ action: "activity", spans: sending }),
        });
        if (!r.ok)
          throw new Error(`Could not save work time (HTTP ${r.status})`);
        apply(await r.json());
        sending = [];
        error = "";
      } catch (e) {
        pending = [...sending, ...pending];
        sending = [];
        throw e;
      }
    })()
      .catch((e) => {
        error = e instanceof Error ? e.message : String(e);
      })
      .finally(() => {
        flushing = undefined;
      });
    return flushing;
  }
  function awake() {
    const t = Date.now();
    if ((t - lastTick > 5000 || t < lastTick) && !away) reset(lastTick);
    lastTick = t;
    return t;
  }
  function interact(event: Event) {
    const t = awake();
    if (
      !loaded ||
      paused ||
      document.hidden ||
      !document.hasFocus() ||
      !event.isTrusted
    )
      return;
    const target = event.target instanceof Element ? event.target : null;
    if (target?.closest("[data-time-tracker]")) return;
    const project = target
      ?.closest("[data-repo-id]")
      ?.getAttribute("data-repo-id");
    if (project !== undefined && project !== null) selectedProject = project;
    if (event.type === "pointermove") {
      const e = event as PointerEvent;
      if (lastPointer?.x === e.clientX && lastPointer?.y === e.clientY) return;
      lastPointer = { x: e.clientX, y: e.clientY };
      activity.move(selectedProject, t);
    } else activity.input(selectedProject, t);
  }
  async function changePause() {
    busy = true;
    await flush();
    try {
      const r = await fetch(apiUrl("/api/work-time"), {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ action: "pause", paused: !paused }),
      });
      if (!r.ok) throw new Error("Could not change time tracking");
      reset();
      apply(await r.json());
      error = "";
    } catch (e) {
      error = String(e);
    } finally {
      busy = false;
    }
  }
  onMount(() => {
    void load().catch((e) => {
      error = String(e);
    });
    const events = [
      "keydown",
      "input",
      "paste",
      "pointerdown",
      "pointermove",
      "wheel",
    ];
    for (const event of events)
      document.addEventListener(event, interact, {
        capture: true,
        passive: true,
      });
    const leave = () => {
      away = true;
      // Switching to an editor/browser is still work; retain the idle allowance.
      void flush();
    };
    const focus = () => {
      const t = Date.now();
      away = false;
      lastTick = t;
      if (loaded && !paused) activity.input(selectedProject, t);
      void load().catch((e) => {
        error = String(e);
      });
    };
    const visibility = () => {
      if (document.hidden) leave();
      else focus();
    };
    window.addEventListener("blur", leave);
    window.addEventListener("focus", focus);
    document.addEventListener("visibilitychange", visibility);
    const clock = setInterval(() => {
      now = awake();
      today = workDay(now);
      collect();
      running = loaded && !paused && activity.active(now);
      liveTail = running
        ? splitWorkDays([
            {
              repoId: activity.project(),
              start: now - activity.preview(now),
              end: now,
            },
          ])
            .filter((r) => r.day === today)
            .reduce((n, r) => n + r.end - r.start, 0)
        : 0;
    }, 1000);
    const save = setInterval(() => {
      if (pending.length || (!document.hidden && document.hasFocus()))
        void flush();
    }, 60_000);
    const beacon = () => {
      reset();
      const spans = [...sending, ...pending].slice(0, 2000);
      if (spans.length)
        navigator.sendBeacon(
          apiUrl("/api/work-time"),
          new Blob([JSON.stringify({ action: "activity", spans })], {
            type: "application/json",
          }),
        );
    };
    window.addEventListener("pagehide", beacon);
    return () => {
      clearInterval(clock);
      clearInterval(save);
      for (const event of events)
        document.removeEventListener(event, interact, true);
      window.removeEventListener("blur", leave);
      window.removeEventListener("focus", focus);
      document.removeEventListener("visibilitychange", visibility);
      window.removeEventListener("pagehide", beacon);
      beacon();
    };
  });
</script>

<div class="work-time" data-time-tracker>
  <Timelapse active={running} />
  <button
    class="clock-button"
    class:tracking={running}
    class:paused
    disabled={!loaded}
    aria-label="Work time"
    title={error ||
      `${paused ? "Paused" : running ? "Tracking" : "Idle"} · Today's work time`}
    on:click={() => {
      date = today;
      dialog.showModal();
    }}
  >
    <svg
      width="15"
      height="15"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      stroke-width="1.7"
      aria-hidden="true"
      ><circle cx="12" cy="12" r="9" /><path d="M12 6v6l4 2" /><path
        d="M12 12V5"
        style={`transform:rotate(${(Math.floor(todayMs / 1000) % 60) * 6}deg);transform-origin:12px 12px;opacity:.5`}
      /></svg
    >
    <span>{format(todayMs)}</span>
  </button>
  <dialog
    bind:this={dialog}
    on:click={(e) => {
      if (e.target === dialog) dialog.close();
    }}
    on:keydown={(e) => e.stopPropagation()}
  >
    <div class="time-heading">
      <h2>Work time</h2>
      <button aria-label="Close work time" on:click={() => dialog.close()}
        >×</button
      >
    </div>
    <div class="history-totals">
      <div>
        <span>Last 7 days</span><strong>{hours(history.last7Ms)}</strong>
      </div>
      <div>
        <span>Last 31 days</span><strong>{hours(history.last31Ms)}</strong>
      </div>
      <button class="pause-tracking" disabled={busy} on:click={changePause}
        >{paused ? "Resume tracking" : "Pause tracking"}</button
      >
    </div>
    <div class="history-label">
      <span>Daily activity</span><span>Last 6 months</span>
    </div>
    <div class="activity-grid" role="group" aria-label="Daily work activity">
      {#each history.days as day}
        <button
          class="activity-day"
          class:selected={date === day.day}
          disabled={day.future}
          style={`--activity:${day.ms ? 0.25 + (0.75 * day.ms) / history.maxDayMs : 0}`}
          title={`${dayLabel(day.day)}: ${hours(day.ms)}`}
          aria-label={`${day.day}: ${hours(day.ms)}`}
          aria-pressed={date === day.day}
          on:click={() => (date = day.day)}
        ></button>
      {/each}
    </div>
    <div class="history-label">
      <span>Hours by weekday</span><span>Last 31 days</span>
    </div>
    <div
      class="weekday-chart"
      role="group"
      aria-label="Work hours by weekday, last 31 days"
    >
      {#each history.weekdays as day}
        <div class="weekday" title={`${day.label}: ${hours(day.ms)}`}>
          <span>{hours(day.ms)}</span>
          <div class="bar-track">
            <div
              class="weekday-bar"
              style={`height:${(day.ms / history.maxWeekdayMs) * 100}%`}
            ></div>
          </div>
          <span>{day.label}</span>
        </div>
      {/each}
    </div>
    <div class="time-controls">
      <time class="selected-date" aria-label="Work day" datetime={date}
        >{dayLabel(date)}</time
      >
      <strong class="day-total"
        >{format(projectRows.reduce((n, r) => n + r.ms, 0))}</strong
      >
    </div>
    <div class="time-projects">
      {#each projectRows as project}<div>
          <span>{project.name}</span><time>{format(project.ms)}</time>
        </div>{:else}<p>No work recorded for this day.</p>{/each}
    </div>
    {#if error}<p class="time-error" role="alert">{error}</p>{/if}
    <small
      >{paused
        ? "Tracking is paused."
        : running
          ? "Tracking work."
          : "Waiting for activity."} 5-minute allowance between interactions. Counted time is kept.</small
    >
  </dialog>
</div>

<style>
  .work-time {
    display: flex;
    align-items: center;
  }
  .clock-button {
    display: flex;
    gap: 0.4rem;
    align-items: center;
    border: 0;
    background: transparent;
    color: var(--muted, #999);
    padding: 0.35rem 0.5rem;
    border-radius: 5px;
    font-size: 0.75rem;
    font-variant-numeric: tabular-nums;
    cursor: pointer;
  }
  .clock-button:hover {
    background: #ffffff12;
    color: var(--fg, #ddd);
  }
  .clock-button.tracking {
    color: #83bc72;
  }
  .clock-button.paused {
    opacity: 0.65;
  }
  dialog {
    background: var(--bg, #1a1a1a);
    color: var(--fg, #ddd);
    border: 1px solid #555;
    border-radius: 10px;
    width: min(480px, calc(100vw - 40px));
    max-height: 80vh;
    overflow: auto;
    padding: 0.85rem 1rem;
  }
  dialog::backdrop {
    background: #0008;
  }
  .time-heading {
    display: flex;
    justify-content: space-between;
    align-items: center;
  }
  .time-heading h2 {
    margin: 0;
    font-size: 1rem;
  }
  .time-heading button {
    background: none;
    border: 0;
    color: inherit;
    font-size: 1.3rem;
    cursor: pointer;
  }
  p,
  small {
    font-size: 0.8rem;
    color: var(--muted, #aaa);
    line-height: 1.5;
  }
  .time-controls {
    display: flex;
    justify-content: space-between;
    gap: 0.7rem;
    align-items: center;
    margin: 0.65rem 0;
  }
  .day-total {
    font-size: 1rem;
    font-variant-numeric: tabular-nums;
  }
  .time-projects {
    margin: 0.4rem 0;
    max-height: 130px;
    overflow: auto;
  }
  .time-projects div {
    display: flex;
    gap: 1rem;
    justify-content: space-between;
    padding: 0.3rem 0;
    border-bottom: 1px solid #ffffff12;
    font-size: 0.75rem;
  }
  .time-projects time {
    font-variant-numeric: tabular-nums;
    white-space: nowrap;
  }
  .selected-date {
    font-size: 0.75rem;
    color: var(--muted, #aaa);
  }
  .history-totals {
    display: flex;
    align-items: center;
    gap: 1.5rem;
    margin: 0.8rem 0;
  }
  .history-totals > div {
    display: flex;
    flex-direction: column;
    gap: 0.15rem;
  }
  .history-totals span,
  .history-label,
  .weekday {
    font-size: 0.68rem;
    color: var(--muted, #aaa);
  }
  .history-totals strong {
    font-size: 1.2rem;
    font-variant-numeric: tabular-nums;
    font-weight: 600;
  }
  .pause-tracking {
    margin-left: auto;
    background: #ffffff08;
    border: 1px solid #ffffff20;
    border-radius: 4px;
    color: inherit;
    padding: 0.25rem 0.45rem;
    font: inherit;
    font-size: 0.72rem;
    cursor: pointer;
  }
  .history-label {
    display: flex;
    justify-content: space-between;
    margin: 0.8rem 0 0.4rem;
  }
  .activity-grid {
    display: grid;
    grid-auto-flow: column;
    grid-template-rows: repeat(7, 1fr);
    grid-template-columns: repeat(26, minmax(0, 1fr));
    gap: 3px;
  }
  .activity-day {
    padding: 0;
    min-width: 0;
    width: 100%;
    aspect-ratio: 1;
    border: 0;
    border-radius: 2px;
    background: color-mix(
      in srgb,
      #83bc72 calc(var(--activity) * 100%),
      #ffffff0a
    );
    cursor: pointer;
  }
  .activity-day:disabled {
    opacity: 0.2;
    cursor: default;
  }
  .activity-day.selected {
    filter: brightness(1.12);
  }
  .activity-day:focus-visible {
    outline: 1px solid #83bc72;
    outline-offset: 1px;
  }
  .weekday-chart {
    display: grid;
    grid-template-columns: repeat(7, 1fr);
    gap: 0.65rem;
    padding-bottom: 0.6rem;
    border-bottom: 1px solid #ffffff12;
  }
  .weekday {
    display: flex;
    flex-direction: column;
    gap: 0.2rem;
    align-items: center;
    font-variant-numeric: tabular-nums;
  }
  .bar-track {
    height: 42px;
    width: 100%;
    display: flex;
    align-items: flex-end;
  }
  .weekday-bar {
    background: #83bc7280;
    width: 100%;
    min-height: 2px;
    border-radius: 2px 2px 0 0;
  }
  .time-error {
    color: #ed9999;
  }
</style>
