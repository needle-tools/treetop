<script lang="ts">
  import { onMount } from "svelte";
  import { apiUrl } from "./api";
  import { getDaemonKV } from "./daemon-kv";
  import { getSetting } from "./settings-registry";
  import { shouldOfferActivityRecap } from "./ui-idle";
  import type { AddToastOpts } from "./toast-manager";
  import LoadingSpinner from "./LoadingSpinner.svelte";
  import { marked } from "marked";
  import DOMPurify from "dompurify";

  export let notify: (toast: AddToastOpts) => number;
  let dialog: HTMLDialogElement;
  let since = 0, until = 0, busy = false, error = "", text = "", model = "";
  let inputTokens: number | null = null, outputTokens: number | null = null;
  let request: AbortController | undefined;
  let availabilityRequest: AbortController | undefined;
  let elapsed = 0;
  type SavedRecap = { key: string; body: string; model: string; inputTokens: number | null; outputTokens: number | null; since: number; until: number };
  let savedRecaps: SavedRecap[] = [], currentKey = "";
  $: currentIndex = savedRecaps.findIndex(recap => recap.key === currentKey);
  $: rendered = DOMPurify.sanitize(marked.parse(text, { async: false }) as string);

  function displaySaved(recap: SavedRecap) {
    currentKey = recap.key; text = recap.body; model = recap.model;
    inputTokens = recap.inputTokens; outputTokens = recap.outputTokens;
    since = recap.since; until = recap.until; error = "";
  }
  function browse(direction: number) {
    const index = currentIndex < 0 ? 0 : currentIndex + direction;
    if (!busy && savedRecaps[index]) displaySaved(savedRecaps[index]);
  }
  function formatTime(value: number) { return new Date(value).toLocaleString(undefined, { dateStyle: "medium", timeStyle: "short" }); }
  function recapUrl(from: number, to: number) {
    const start = new Date(to); start.setHours(0, 0, 0, 0);
    const end = new Date(start); end.setDate(end.getDate() + 1);
    return apiUrl(`/api/activity-recap?since=${from}&until=${to}&dayStart=${start.getTime()}&dayEnd=${end.getTime()}`);
  }

  function reveal() { if (!dialog.open) dialog.showModal(); }

  export function show(from = Date.now() - 86400_000) {
    reveal();
    if (busy) return;
    since = from; until = Date.now();
    void generate();
  }
  async function generate() {
    request?.abort();
    const current = request = new AbortController();
    busy = true; error = ""; text = ""; model = "";
    elapsed = 0;
    const started = Date.now();
    const timer = setInterval(() => { elapsed = Math.floor((Date.now() - started) / 1000); }, 1000);
    inputTokens = outputTokens = null;
    try {
      const res = await fetch(recapUrl(since, until), {
        method: "POST", signal: current.signal,
        headers: { "Content-Type": "application/json" }, body: JSON.stringify({ agent: "codex" }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error ?? `HTTP ${res.status}`);
      if (current !== request) return;
      text = data.recap?.body ?? "No saved summaries, new notes, or reminders cover this period.";
      model = data.recap?.model ?? "";
      inputTokens = data.recap?.inputTokens ?? null;
      outputTokens = data.recap?.outputTokens ?? null;
      savedRecaps = data.recaps ?? [];
      currentKey = data.recap?.key ?? "";
      if (data.recap?.since != null) { since = data.recap.since; until = data.recap.until; }
      if (data.recap && !dialog.open) notify({ kind: "success", title: "Activity recap ready", message: "Your highlights are ready to read.",
        persist: true, action: { label: "View recap", onClick: reveal } });
    } catch (e) {
      if (!current.signal.aborted) {
        error = e instanceof Error ? e.message : String(e);
        if (!dialog.open) notify({ kind: "error", title: "Activity recap failed", message: error,
          action: { label: "View", onClick: reveal } });
      }
    } finally { clearInterval(timer); if (current === request) busy = false; }
  }
  async function offerRecap(from: number, to: number) {
    availabilityRequest?.abort();
    const current = availabilityRequest = new AbortController();
    try {
      const res = await fetch(recapUrl(from, to), { signal: current.signal });
      if (!res.ok) throw new Error(`Recap availability: HTTP ${res.status}`);
      const data = await res.json();
      if (current.signal.aborted || getSetting("activityRecap.enabled") === false || !data.available) return;
      notify({ kind: "info", title: "Welcome back", message: "Review activity since your last visit?",
        persist: true, silent: true, action: { label: "Activity recap", onClick: () => show(from) } });
    } catch (e) {
      if (!current.signal.aborted) console.warn("Could not check recap availability", e);
    }
  }
  onMount(() => {
    const kv = getDaemonKV(), key = "supergit:recapLastActivity";
    let last = Number(kv.getItem(key)) || 0, saved = last, starting = true;
    const record = () => {
      if (document.hidden || !document.hasFocus()) return;
      const now = Date.now(), previous = last;
      if (getSetting("activityRecap.enabled") !== false && shouldOfferActivityRecap(previous, now, starting)) {
        void offerRecap(previous, now);
      }
      last = now;
      if (now - saved >= 60_000 || starting) { kv.setItem(key, String(now)); saved = now; }
      starting = false;
    };
    record();
    const activity = () => record();
    const events = ["pointerdown", "keydown", "wheel", "focus", "visibilitychange"];
    for (const event of events) window.addEventListener(event, activity, { capture: true, passive: true });
    return () => {
      request?.abort();
      availabilityRequest?.abort();
      for (const event of events) window.removeEventListener(event, activity, true);
    };
  });
</script>

<dialog bind:this={dialog} aria-labelledby="recap-title">
  <header><h2 id="recap-title">Activity recap</h2><button aria-label="Close recap" on:click={() => dialog.close()}>
    <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" aria-hidden="true"><path d="m6 6 12 12M18 6 6 18" /></svg>
  </button></header>
  {#if savedRecaps.length > 1 || (savedRecaps.length && currentIndex < 0)}
    <button class="history-arrow older" aria-label="Older recap" title="Older recap" disabled={busy || currentIndex === savedRecaps.length - 1} on:click={() => browse(1)}>
      <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" aria-hidden="true"><path d="m14 6-6 6 6 6" /></svg>
    </button>
    <button class="history-arrow newer" aria-label="Newer recap" title="Newer recap" disabled={busy || currentIndex <= 0} on:click={() => browse(-1)}>
      <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" aria-hidden="true"><path d="m10 6 6 6-6 6" /></svg>
    </button>
  {/if}
  {#if busy}<div class="loading" aria-busy="true"><LoadingSpinner size="1rem" label="Generating recap" /><div><p role="status">{elapsed < 20 ? "Generating highlights..." : "Still generating highlights..."}</p><small>{elapsed}s elapsed. You can close this window; we'll notify you when it's ready.</small></div></div>{/if}
  {#if error}<p role="alert">{error}</p><button on:click={generate}>Try again</button>{/if}
  {#if text}<div class="recap-text">{@html rendered}</div>{/if}
  {#if !busy && text}<footer><div>From {formatTime(since)} to {formatTime(until)}</div>{#if model}{model} | {inputTokens === null ? "Input tokens unavailable" : `${inputTokens.toLocaleString()} input tokens`} | {outputTokens === null ? "Output tokens unavailable" : `${outputTokens.toLocaleString()} output tokens`}{/if}</footer>{/if}
</dialog>

<style>
  dialog { width: min(34rem, calc(100vw - 5rem)); max-height: 75vh; overflow: auto; padding: 1.2rem 2rem; color: var(--text-1); background: var(--surface-1); border: 1px solid var(--surface-3); border-radius: .7rem; }
  dialog::backdrop { background: #0008; }
  header { display: flex; align-items: center; justify-content: space-between; gap: 1rem; }
  h2 { margin: 0; font-size: 1.1rem; }
  button { cursor: pointer; font: inherit; color: inherit; background: var(--surface-2); border: 1px solid var(--surface-3); border-radius: .3rem; padding: .35rem .5rem; }
  .loading { display: grid; grid-template-columns: 1rem minmax(0, 1fr); align-items: center; column-gap: .75rem; row-gap: .3rem; margin-top: 1rem; }
  .loading > div { display: contents; }
  .loading p { margin: 0; }
  .loading small { grid-column: 2; color: var(--text-muted); }
  .recap-text { margin-top: 1rem; line-height: 1.5; overflow-wrap: anywhere; }
  .recap-text :global(p), .recap-text :global(li) { text-wrap: balance; }
  .recap-text :global(ul), .recap-text :global(ol) { padding-left: 1.3rem; margin: 0; }
  .recap-text :global(li + li) { margin-top: .7rem; }
  .recap-text :global(p) { margin: .5rem 0; }
  .recap-text :global(h1), .recap-text :global(h2), .recap-text :global(h3) { font-size: 1rem; margin: 1rem 0 .35rem; text-wrap: balance; }
  footer { margin-top: 1rem; color: var(--text-muted); font-size: .75rem; }
  footer div { margin-bottom: .3rem; }
  .history-arrow { position: absolute; top: 50%; transform: translateY(-50%); background: none; border: 0; padding: .5rem .15rem; color: var(--text-muted); opacity: .55; }
  .history-arrow:hover:not(:disabled) { opacity: 1; color: var(--text-1); }
  .history-arrow:disabled { opacity: .15; cursor: default; }
  .older { left: .25rem; } .newer { right: .25rem; }
</style>
