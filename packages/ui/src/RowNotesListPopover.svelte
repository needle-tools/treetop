<script lang="ts">
  import { createEventDispatcher } from "svelte";
  import AttachmentIcon from "./AttachmentIcon.svelte";
  import type { Event as EventLogEntry } from "./event-format";
  import { notesListDisplay, relTime } from "./display-helpers";
  import NoteIcon from "./NoteIcon.svelte";
  import type { NoteShape } from "./notes-counts";
  import Popover from "./Popover.svelte";

  type ListableNote = NoteShape & { kind?: "note" | "link" };

  const dispatch = createEventDispatcher<{
    undoDelete: { event: EventLogEntry; trigger: HTMLElement };
  }>();

  export let title = "";
  export let notes: NoteShape[] = [];
  export let deletes: EventLogEntry[] = [];

  function isListableNote(note: NoteShape): note is ListableNote {
    return note.kind !== "emoji";
  }

  function deletedDisplay(ev: EventLogEntry) {
    const note = ev.inverse?.note as
      | {
          body?: string;
          kind?: "note" | "link" | "emoji";
          target?: NoteShape["target"];
        }
      | undefined;
    return notesListDisplay({
      body: note?.body ?? "",
      kind: note?.kind === "link" ? "link" : "note",
      target: note?.target,
    });
  }

  $: visibleNotes = notes
    .filter(isListableNote)
    .map((n) => ({ n, display: notesListDisplay(n) }))
    .filter((row) => row.display.text.length > 0);

  $: visibleDeletes = deletes
    .filter((ev) => ev.inverse?.note?.kind !== "emoji")
    .slice(0, 20)
    .map((ev) => ({ ev, display: deletedDisplay(ev) }))
    .filter((row) => row.display.text.length > 0);
</script>

<Popover variant="agents" extraClass="notes-list-popover">
  <svelte:fragment slot="head">{title}</svelte:fragment>
  <div class="notes-list-section">
    {#if visibleNotes.length === 0}
      <p class="muted small nopad">No notes with content.</p>
    {:else}
      <ul class="notes-list">
        {#each visibleNotes as row (row.n.id)}
          {@const n = row.n}
          <li class="notes-list-row" class:is-link={row.display.kind === "link"}>
            <span class="notes-list-kind" aria-hidden="true">
              {#if row.display.kind === "link"}
                {#if row.display.agent || row.display.provider || row.display.glyph}
                  <AttachmentIcon
                    agent={row.display.agent}
                    provider={row.display.provider}
                    glyph={row.display.glyph}
                    size={14}
                  />
                {:else}
                  <svg
                    viewBox="0 0 24 24"
                    width="12"
                    height="12"
                    fill="none"
                    stroke="currentColor"
                    stroke-width="2.2"
                    stroke-linecap="round"
                    stroke-linejoin="round"
                    aria-hidden="true"
                  >
                    <path
                      d="M10 13a5 5 0 0 0 7.54.54l3-3a5 5 0 0 0-7.07-7.07l-1.72 1.71"
                    />
                    <path
                      d="M14 11a5 5 0 0 0-7.54-.54l-3 3a5 5 0 0 0 7.07 7.07l1.71-1.71"
                    />
                  </svg>
                {/if}
              {:else}
                <NoteIcon size={13} />
              {/if}
            </span>
            <span class="notes-list-body" title={row.display.title}
              >{row.display.text}</span
            >
            <span class="muted ev-time">{relTime(n.updatedAt)}</span>
          </li>
        {/each}
      </ul>
    {/if}
  </div>
  <div class="notes-list-section">
    <div class="notes-list-section-head">
      Recently deleted ({visibleDeletes.length})
    </div>
    {#if visibleDeletes.length === 0}
      <p class="muted small nopad">None.</p>
    {:else}
      <ul class="notes-list">
        {#each visibleDeletes as r (r.ev.id)}
          <li class="notes-list-row deleted" class:is-link={r.display.kind === "link"}>
            <span class="notes-list-kind" aria-hidden="true">
              {#if r.display.kind === "link"}
                {#if r.display.agent || r.display.provider || r.display.glyph}
                  <AttachmentIcon
                    agent={r.display.agent}
                    provider={r.display.provider}
                    glyph={r.display.glyph}
                    size={14}
                  />
                {:else}
                  <svg
                    viewBox="0 0 24 24"
                    width="12"
                    height="12"
                    fill="none"
                    stroke="currentColor"
                    stroke-width="2.2"
                    stroke-linecap="round"
                    stroke-linejoin="round"
                    aria-hidden="true"
                  >
                    <path
                      d="M10 13a5 5 0 0 0 7.54.54l3-3a5 5 0 0 0-7.07-7.07l-1.72 1.71"
                    />
                    <path
                      d="M14 11a5 5 0 0 0-7.54-.54l-3 3a5 5 0 0 0 7.07 7.07l1.71-1.71"
                    />
                  </svg>
                {/if}
              {:else}
                <NoteIcon size={13} />
              {/if}
            </span>
            <span class="notes-list-body" title={r.display.title}
              >{r.display.text}</span
            >
            <span class="muted ev-time">{relTime(r.ev.timestamp)}</span>
            <button
              class="undo"
              on:click={(e) =>
                dispatch("undoDelete", {
                  event: r.ev,
                  trigger: e.currentTarget as HTMLElement,
                })}
              title="Restore this deleted note">Undo</button
            >
          </li>
        {/each}
      </ul>
    {/if}
  </div>
</Popover>
