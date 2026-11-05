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
  type RecapReference = { href: string; type: "project" | "session"; value: string; label: string };
  export let projects: Array<{ id: string; name: string; path: string }> = [];
  export let openReference: (reference: RecapReference) => void | Promise<void>;
  let references: RecapReference[] = [];
  let dialog: HTMLDialogElement;
  let since = 0, until = 0, busy = false, error = "", text = "", model = "";
  let inputTokens: number | null = null, outputTokens: number | null = null;
  let request: AbortController | undefined;
  let availabilityRequest: AbortController | undefined;
  let elapsed = 0;
  const loadingTitles = ["The latest", "A quick recap", "Recent progress", "Your latest updates", "The short version", "Work in review", "What changed", "A look back"];
  let headline = "Activity recap";
  type SavedRecap = { key: string; title?: string | null; references?: RecapReference[]; body: string; model: string; inputTokens: number | null; outputTokens: number | null; since: number; until: number };
  let savedRecaps: SavedRecap[] = [], currentKey = "";
  $: currentIndex = savedRecaps.findIndex(recap => recap.key === currentKey);
  $: allowedReferences = [...references, ...projects.map(p => ({ href: `#recap-project-ui-${encodeURIComponent(p.id)}`, type: "project" as const, value: p.path, label: p.name }))];
  $: rendered = renderRecap(text, allowedReferences);

  function renderRecap(markdown: string, targets: RecapReference[]) {
    const template = document.createElement("template");
    template.innerHTML = DOMPurify.sanitize(marked.parse(markdown.replace(/^(#{1,6}\s+)[\p{Extended_Pictographic}\uFE0F\u200D]+\s*/gmu, "$1"), { async: false }) as string);
    for (const link of template.content.querySelectorAll("a")) {
      if (!targets.some(t => t.href === link.getAttribute("href"))) link.replaceWith(...link.childNodes);
    }
    const normalized = (name: string) => name.toLowerCase().replace(/[^\p{L}\p{N}]/gu, "");
    for (const strong of template.content.querySelectorAll("strong")) {
      if (strong.closest("a")) continue;
      const matches = targets.filter(t => t.type === "project" && normalized(t.label) === normalized(strong.textContent ?? ""));
      if (new Set(matches.map(t => t.value)).size !== 1) continue;
      const link = document.createElement("a");
      link.href = matches[0].href;
      strong.replaceWith(link); link.append(strong);
    }
    return template.innerHTML;
  }
  function recapNavigation(node: HTMLElement) {
    const click = (event: MouseEvent) => {
      const link = (event.target as Element | null)?.closest("a");
      if (!link) return;
      event.preventDefault();
      const reference = allowedReferences.find(t => t.href === link.getAttribute("href"));
      if (reference) { dialog.close(); void openReference(reference); }
    };
    node.addEventListener("click", click);
    return { destroy: () => node.removeEventListener("click", click) };
  }

  function displaySaved(recap: SavedRecap) {
    currentKey = recap.key; text = recap.body; model = recap.model;
    headline = recap.title || "Activity recap";
    references = recap.references ?? [];
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
    references = [];
    headline = loadingTitles[Math.floor(Math.random() * loadingTitles.length)];
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
      headline = data.recap?.title || "Activity recap";
      references = data.recap?.references ?? [];
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
  <header>
    <div class="masthead">
      <svg class="title-plant" width="34" height="44" viewBox="0 0 44 48" fill="none" aria-hidden="true">
        <g stroke="currentColor" stroke-width="1.4" stroke-linecap="round">
          <ellipse cx="22" cy="31" rx="8" ry="11" />
          <ellipse cx="10" cy="19" rx="6" ry="8.5" transform="rotate(-34 10 19)" />
          <ellipse cx="33" cy="14" rx="6.5" ry="9" transform="rotate(25 33 14)" />
          <path d="m15 25 3 2m9-5 3-2M22 42v4M12 46h20M7 15l1 2m3 4 1 2m19-12 1 2m2 3 1 2m-16 9 1 2m3 6 1 2m-5 1 1 1M4 12l-2-1m34-7 1-2m4 14 2 1M14 32h-2" />
        </g>
      </svg>
      <div><p class="dateline">{new Date(until).toLocaleDateString(undefined, { weekday: "long", month: "long", day: "numeric", year: "numeric" })}</p><h2 id="recap-title">{headline}</h2></div>
    </div>
    <button class="close-recap" aria-label="Close recap" on:click={() => dialog.close()}>
    <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" aria-hidden="true"><path d="m6 6 12 12M18 6 6 18" /></svg>
  </button></header>
  <div class="journal-rule" aria-hidden="true"></div>
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
  {#if text}<div class="recap-text" use:recapNavigation>{@html rendered}</div>{/if}
  {#if !busy && text}<footer><div>From {formatTime(since)} to {formatTime(until)}</div>{#if model}{model} | {inputTokens === null ? "Input tokens unavailable" : `${inputTokens.toLocaleString()} input tokens`} | {outputTokens === null ? "Output tokens unavailable" : `${outputTokens.toLocaleString()} output tokens`}{/if}</footer>{/if}
  <svg class="corner-plant" width="76" height="108" viewBox="0 0 76 108" fill="none" aria-hidden="true">
    <path d="M41 103V32c0-12-13-12-13 0v41M28 74H17c-9 0-12-5-12-13V49M41 65h13c10 0 15-7 15-16V35M9 103h59" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" />
    <path d="M41 88c9-14 12-28 11-39M49 65c-7-5-8-13-5-18 6 4 8 11 5 18ZM52 54c6-1 10-6 10-12-6 0-10 5-10 12Z" fill="currentColor" />
    <path d="M35 23v-7m-4 7-3-5m10 4 4-5" stroke="currentColor" stroke-width="1.1" stroke-linecap="round" />
  </svg>
</dialog>

<style>
  @font-face { font-family: "Treetop Nunito Sans"; src: url("/fonts/NunitoSans-Variable.ttf") format("truetype"); font-style: normal; font-weight: 200 900; font-display: swap; }
  @font-face { font-family: "Treetop Plex Serif"; src: url("/fonts/IBMPlexSerif-Italic-Variable.ttf") format("truetype"); font-style: italic; font-weight: 100 700; font-display: swap; }
  dialog { --journal-ink: #e9e3d5; --journal-sage: #a6b995; --journal-muted: #a3a899; --journal-rule: #46503f; width: min(49rem, calc(100vw - 5rem)); max-height: 82vh; overflow: auto; padding: 1.5rem 2.25rem; color: var(--journal-ink); background: #1c201c; border: 1px solid var(--journal-rule); border-radius: .3rem; box-shadow: 0 1.5rem 5rem #0005; text-align: left; scrollbar-width: thin; scrollbar-color: #5f70504d transparent; }
  dialog::-webkit-scrollbar { width: 5px; height: 5px; }
  dialog::-webkit-scrollbar-track { background: transparent; }
  dialog::-webkit-scrollbar-thumb { background: #5f70504d; border-radius: 9px; }
  dialog::-webkit-scrollbar-thumb:hover { background: #84977380; }
  dialog::-webkit-scrollbar-button { display: none; }
  dialog::backdrop { background: #0c100cb3; }
  dialog { font-family: "Treetop Nunito Sans", var(--font-brand, system-ui), sans-serif; }
  header { display: flex; align-items: start; justify-content: space-between; gap: 1rem; }
  .masthead { display: grid; grid-template-columns: 34px minmax(0, 1fr); align-items: center; column-gap: .9rem; }
  .masthead > div { display: contents; }
  .dateline { grid-column: 2; grid-row: 1; margin: 0 0 .45rem; font-size: .73rem; letter-spacing: .025em; color: var(--journal-muted); }
  .masthead h2 { grid-column: 2; grid-row: 2; }
  h2 { margin: 0; font-family: "Treetop Plex Serif", Georgia, serif; font-style: italic; font-size: clamp(1.4rem, 2.6vw, 1.85rem); font-weight: 400; letter-spacing: -.025em; line-height: 1.16; text-wrap: balance; }
  .title-plant { grid-column: 1; grid-row: 2; align-self: center; color: var(--journal-sage); }
  .journal-rule { border-top: 1px solid var(--journal-rule); margin: 1.25rem 0 1rem; }
  .corner-plant { position: absolute; bottom: .8rem; right: .7rem; color: var(--journal-sage); opacity: .2; pointer-events: none; }
  button { cursor: pointer; font: inherit; color: inherit; background: var(--surface-2); border: 1px solid var(--surface-3); border-radius: .3rem; padding: .35rem .5rem; }
  .close-recap { display: grid; place-items: center; padding: .35rem; border: 0; background: none; color: var(--journal-muted); }
  .close-recap:hover { color: var(--journal-ink); }
  button:focus-visible { outline: 2px solid var(--journal-sage); outline-offset: 4px; }
  .loading { display: grid; grid-template-columns: 1rem minmax(0, 1fr); align-items: center; column-gap: .75rem; row-gap: .3rem; margin-top: 1rem; }
  .loading > div { display: contents; }
  .loading p { margin: 0; }
  .loading small { grid-column: 2; color: var(--journal-muted); }
  .loading :global(.loading-spinner) { color: var(--journal-sage); }
  .recap-text { margin-top: .5rem; font-size: .84rem; line-height: 1.6; overflow-wrap: anywhere; columns: 2; column-gap: 2rem; column-rule: 1px solid var(--journal-rule); }
  .recap-text :global(p), .recap-text :global(li) { text-wrap: balance; }
  .recap-text :global(ul), .recap-text :global(ol) { padding-left: 0; margin: 0; list-style: none; }
  .recap-text :global(li + li) { margin-top: .45rem; }
  .recap-text :global(li), .recap-text :global(p) { break-inside: avoid; }
  .recap-text :global(p) { margin: .5rem 0; }
  .recap-text :global(h1), .recap-text :global(h2), .recap-text :global(h3) { font-family: inherit; font-style: normal; font-size: .76rem; font-weight: 700; color: var(--journal-sage); margin: 1rem 0 .4rem; letter-spacing: .015em; text-wrap: balance; break-after: avoid; }
  .recap-text :global(h1:first-child), .recap-text :global(h2:first-child), .recap-text :global(h3:first-child) { margin-top: 0; }
  .recap-text :global(strong) { color: #f4efdf; font-weight: 650; }
  .recap-text :global(a) { color: var(--journal-sage); text-underline-offset: .15em; }
  .recap-text :global(a strong) { color: inherit; }
  .recap-text :global(a:hover) { color: var(--journal-ink); }
  .recap-text :global(a:focus-visible) { outline: 2px solid var(--journal-sage); outline-offset: 3px; }
  .recap-text :global(del) { color: var(--journal-muted); }
  footer { position: relative; margin-top: 1.5rem; padding: .85rem 3rem 0 0; border-top: 1px solid var(--journal-rule); color: var(--journal-muted); font-size: .68rem; line-height: 1.6; }
  footer div { margin-bottom: .3rem; }
  .history-arrow { position: absolute; top: 50%; transform: translateY(-50%); background: none; border: 0; padding: .5rem .15rem; color: var(--text-muted); opacity: .55; }
  .history-arrow:hover:not(:disabled) { opacity: 1; color: var(--text-1); }
  .history-arrow:disabled { opacity: .15; cursor: default; }
  .older { left: .25rem; } .newer { right: .25rem; }
  @media (max-width: 700px) {
    .recap-text { columns: 1; }
  }
  @media (max-width: 600px) {
    dialog { width: calc(100vw - 4rem); padding: 1.4rem 1.65rem; max-height: 86vh; }
    .title-plant { width: 26px; height: 34px; }
    .masthead { grid-template-columns: 26px minmax(0, 1fr); column-gap: .6rem; }
    .dateline { font-size: .65rem; }
    .corner-plant { width: 54px; height: 78px; opacity: .15; }
  }
</style>
