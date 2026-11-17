<script lang="ts">
  import { onMount } from "svelte";
  import { apiUrl } from "./api";
  import Timelapse from "./Timelapse.svelte";
  import {
    WorkActivity,
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
    adjustProject = "",
    adjustMinutes = "",
    error = "",
    busy = false;
  let selectedProject = "",
    lastTick = Date.now(),
    lastPointer: { x: number; y: number } | undefined;
  let flushing: Promise<void> | undefined;
  let liveTail = 0;
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

  function collect() {
    const added = splitWorkDays(activity.drain());
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
  function reset() {
    collect();
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
    if (t - lastTick > 5000 || t < lastTick) reset();
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
  async function adjust() {
    const minutes = Number(adjustMinutes);
    if (!adjustMinutes.trim() || !Number.isFinite(minutes) || minutes === 0)
      return;
    busy = true;
    await flush();
    try {
      const r = await fetch(apiUrl("/api/work-time"), {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          action: "adjust",
          id: crypto.randomUUID(),
          day: date,
          repoId: adjustProject,
          deltaMs: Math.round(minutes * 60_000),
        }),
      });
      const body = await r.json();
      if (!r.ok) throw new Error(body.error ?? "Could not adjust work time");
      apply(body);
      adjustMinutes = "";
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
      reset();
      void flush();
    };
    const focus = () => {
      reset();
      lastTick = Date.now();
      void load().catch((e) => {
        error = String(e);
      });
    };
    const visibility = () => {
      if (document.hidden) leave();
      else {
        reset();
        lastTick = Date.now();
        void load().catch((e) => {
          error = String(e);
        });
      }
    };
    window.addEventListener("blur", leave);
    window.addEventListener("focus", focus);
    document.addEventListener("visibilitychange", visibility);
    const clock = setInterval(() => {
      now = awake();
      today = workDay(now);
      collect();
      running =
        loaded &&
        !paused &&
        !document.hidden &&
        document.hasFocus() &&
        activity.active(now);
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
  <Timelapse active={running}/>
  <button
    class="clock-button"
    class:tracking={running}
    class:paused
    disabled={!loaded}
    aria-label="Work time"
    title={error ||
      `${paused ? "Paused" : running ? "Tracking" : "Idle"} · Today's active time in Treetop`}
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
    <p>
      Active time in Treetop. Idle gaps and background agent work are excluded.
    </p>
    <div class="time-controls">
      <label
        >Day <input
          aria-label="Work day"
          type="date"
          bind:value={date}
        /></label
      ><button disabled={busy} on:click={changePause}
        >{paused ? "Resume tracking" : "Pause tracking"}</button
      >
    </div>
    <strong class="day-total"
      >{format(projectRows.reduce((n, r) => n + r.ms, 0))}</strong
    >
    <div class="time-projects">
      {#each projectRows as project}<div>
          <span>{project.name}</span><time>{format(project.ms)}</time>
        </div>{:else}<p>No work recorded for this day.</p>{/each}
    </div>
    <form on:submit|preventDefault={adjust}>
      <h3>Adjust time</h3>
      <label
        >Project <select
          aria-label="Adjustment project"
          bind:value={adjustProject}
          ><option value="">Treetop</option>{#each projects as project}<option
              value={project.id}>{project.name}</option
            >{/each}</select
        ></label
      >
      <label
        >Minutes <input
          type="text"
          inputmode="decimal"
          placeholder="e.g. 15 or -5"
          bind:value={adjustMinutes}
        /></label
      >
      <button type="submit" disabled={busy || !adjustMinutes}>Apply</button>
    </form>
    {#if error}<p class="time-error" role="alert">{error}</p>{/if}
    <small
      >{paused
        ? "Tracking is paused."
        : running
          ? "Tracking active work."
          : "Waiting for activity."} Stops after 2 minutes without interaction.</small
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
    width: min(460px, calc(100vw - 40px));
    max-height: 80vh;
    overflow: auto;
    padding: 1.25rem;
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
    font-size: 1.1rem;
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
    align-items: end;
    margin: 1rem 0;
  }
  label {
    display: flex;
    gap: 0.3rem;
    flex-direction: column;
    font-size: 0.75rem;
  }
  .day-total {
    font-size: 1.5rem;
    font-variant-numeric: tabular-nums;
  }
  .time-projects {
    margin: 1rem 0;
  }
  .time-projects div {
    display: flex;
    gap: 1rem;
    justify-content: space-between;
    padding: 0.45rem 0;
    border-bottom: 1px solid #ffffff12;
    font-size: 0.85rem;
  }
  .time-projects time {
    font-variant-numeric: tabular-nums;
    white-space: nowrap;
  }
  form {
    display: flex;
    flex-wrap: wrap;
    gap: 0.6rem;
    align-items: end;
    border-top: 1px solid #ffffff20;
    padding-top: 0.75rem;
    margin-bottom: 1rem;
  }
  h3 {
    width: 100%;
    margin: 0;
    font-size: 0.85rem;
  }
  select {
    max-width: 210px;
  }
  input[inputmode="decimal"] {
    width: 110px;
  }
  input,
  select {
    background: #ffffff08;
    color: inherit;
    border: 1px solid #555;
    border-radius: 4px;
    padding: 0.35rem;
  }
  select option {
    background: #222;
  }
  form button,
  .time-controls button {
    padding: 0.4rem 0.6rem;
    border: 1px solid #555;
    border-radius: 4px;
    background: #ffffff0c;
    color: inherit;
    cursor: pointer;
  }
  .time-error {
    color: #ed9999;
  }
</style>
