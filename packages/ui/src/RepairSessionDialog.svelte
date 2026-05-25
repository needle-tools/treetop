<script lang="ts">
  import { activeRepair, closeRepair } from "./repair-session-dialog";

  type Phase =
    | { kind: "idle" }
    | { kind: "diagnosing" }
    | {
        kind: "diagnosed";
        diagnosis: {
          totalEntries: number;
          chainEntries: number;
          brokenLinks: number;
          details: Array<{
            missingUuid: string;
            referencedBy: string;
            lineIndex: number;
          }>;
        };
      }
    | { kind: "repairing" }
    | { kind: "done"; repairedCount: number; backupPath: string }
    | { kind: "error"; message: string }
    | { kind: "healthy" };

  let phase: Phase = { kind: "idle" };
  let lastSource: string | null = null;

  $: if ($activeRepair && $activeRepair.source !== lastSource) {
    lastSource = $activeRepair.source;
    phase = { kind: "idle" };
    void diagnose();
  }
  $: if (!$activeRepair) {
    lastSource = null;
    phase = { kind: "idle" };
  }

  async function diagnose() {
    if (!$activeRepair) return;
    phase = { kind: "diagnosing" };
    try {
      const res = await fetch("/api/sessions/repair", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ source: $activeRepair.source, dryRun: true }),
      });
      if (!res.ok) {
        const body = await res.json().catch(() => null);
        throw new Error(
          (body as Record<string, string> | null)?.error ?? `HTTP ${res.status}`,
        );
      }
      const body = (await res.json()) as {
        diagnosis: Phase extends { kind: "diagnosed" }
          ? Phase["diagnosis"]
          : never;
      };
      const d = (body as Record<string, unknown>).diagnosis as {
        totalEntries: number;
        chainEntries: number;
        brokenLinks: number;
        details: Array<{
          missingUuid: string;
          referencedBy: string;
          lineIndex: number;
        }>;
      };
      if (d.brokenLinks === 0) {
        phase = { kind: "healthy" };
      } else {
        phase = { kind: "diagnosed", diagnosis: d };
      }
    } catch (e) {
      phase = {
        kind: "error",
        message: e instanceof Error ? e.message : String(e),
      };
    }
  }

  async function repair() {
    if (!$activeRepair) return;
    phase = { kind: "repairing" };
    try {
      const res = await fetch("/api/sessions/repair", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ source: $activeRepair.source }),
      });
      if (!res.ok) {
        const body = await res.json().catch(() => null);
        throw new Error(
          (body as Record<string, string> | null)?.error ?? `HTTP ${res.status}`,
        );
      }
      const body = (await res.json()) as {
        repaired: boolean;
        repairedCount?: number;
        backupPath?: string;
      };
      if (body.repaired) {
        phase = {
          kind: "done",
          repairedCount: body.repairedCount ?? 0,
          backupPath: body.backupPath ?? "",
        };
      } else {
        phase = { kind: "healthy" };
      }
    } catch (e) {
      phase = {
        kind: "error",
        message: e instanceof Error ? e.message : String(e),
      };
    }
  }

  function onKeydown(ev: KeyboardEvent) {
    if (!$activeRepair) return;
    if (ev.key === "Escape") {
      ev.preventDefault();
      closeRepair();
    }
  }

  function shortPath(p: string): string {
    const parts = p.replace(/\\/g, "/").split("/");
    return parts.slice(-1).join("/");
  }
</script>

<svelte:window on:keydown={onKeydown} />

{#if $activeRepair}
  <div
    class="repair-overlay"
    on:click={closeRepair}
    on:keydown|stopPropagation
    role="presentation"
  >
    <div
      class="repair-dialog"
      role="dialog"
      aria-modal="true"
      aria-labelledby="repair-title"
      on:click|stopPropagation
    >
      <h2 id="repair-title" class="repair-title">Repair session</h2>

      {#if phase.kind === "idle" || phase.kind === "diagnosing"}
        <div class="repair-loading">
          <span class="repair-spinner"></span>
          <span>Diagnosing parent chain…</span>
        </div>

      {:else if phase.kind === "healthy"}
        <p class="repair-blurb">
          No broken parent links found — this session's chain is intact.
        </p>

      {:else if phase.kind === "diagnosed"}
        <p class="repair-blurb">
          Found <strong>{phase.diagnosis.brokenLinks}</strong> broken
          parent {phase.diagnosis.brokenLinks === 1 ? "link" : "links"} in
          a session with {phase.diagnosis.totalEntries} entries.
        </p>
        <p class="repair-blurb">
          Claude Code traces messages by following parent UUIDs. When a
          link is missing, the loader can only see messages after the
          break — which can drop a long session down to a handful of
          messages.
        </p>
        <div class="repair-details">
          {#each phase.diagnosis.details as d}
            <div class="repair-detail">
              <span class="repair-mono">Line {d.lineIndex}</span>
              <span class="repair-sep">→</span>
              <span class="repair-mono">{d.missingUuid}…</span> missing
            </div>
          {/each}
        </div>
        <p class="repair-blurb repair-note">
          A <code>.bak</code> backup is created before any changes.
          Synthetic bridge nodes are inserted so the chain is continuous
          again.
        </p>

      {:else if phase.kind === "repairing"}
        <div class="repair-loading">
          <span class="repair-spinner"></span>
          <span>Repairing…</span>
        </div>

      {:else if phase.kind === "done"}
        <p class="repair-result repair-ok">
          Repaired {phase.repairedCount}
          {phase.repairedCount === 1 ? "link" : "links"}.
          Resume the session to load full history.
        </p>
        <p class="repair-blurb repair-note">
          Backup: <code>{shortPath(phase.backupPath)}</code>
        </p>

      {:else if phase.kind === "error"}
        <p class="repair-result repair-err" role="alert">{phase.message}</p>
      {/if}

      <div class="repair-buttons">
        {#if phase.kind === "diagnosed"}
          <button type="button" class="repair-btn" on:click={closeRepair}>
            Cancel
          </button>
          <button
            type="button"
            class="repair-btn repair-confirm"
            on:click={repair}
          >
            Repair
          </button>
        {:else}
          <button type="button" class="repair-btn" on:click={closeRepair}>
            {phase.kind === "done" ? "Close" : "Cancel"}
          </button>
        {/if}
      </div>
    </div>
  </div>
{/if}

<style>
  .repair-overlay {
    position: fixed;
    inset: 0;
    background: rgba(0, 0, 0, 0.5);
    display: flex;
    align-items: center;
    justify-content: center;
    z-index: 2000;
    backdrop-filter: blur(2px);
  }
  .repair-dialog {
    min-width: 380px;
    max-width: min(500px, 92vw);
    background: var(--surface-1);
    color: var(--text, inherit);
    border: 1px solid var(--surface-2);
    border-radius: var(--radius-md, 8px);
    box-shadow: 0 12px 32px rgba(0, 0, 0, 0.5);
    padding: 1rem 1.1rem;
    display: flex;
    flex-direction: column;
    gap: 0.4rem;
  }
  .repair-title {
    margin: 0;
    font-size: 0.95rem;
    font-weight: 600;
  }
  .repair-blurb {
    margin: 0;
    font-size: 0.82rem;
    line-height: 1.45;
    color: var(--text-muted);
  }
  .repair-note {
    font-size: 0.78rem;
    opacity: 0.8;
  }
  .repair-note code {
    font-size: 0.75rem;
    background: color-mix(in srgb, var(--text-muted) 12%, transparent);
    padding: 0.05rem 0.3rem;
    border-radius: 3px;
  }
  .repair-details {
    display: flex;
    flex-direction: column;
    gap: 0.2rem;
    margin: 0.2rem 0;
    padding: 0.4rem 0.5rem;
    background: color-mix(in srgb, var(--text-muted) 6%, transparent);
    border-radius: 4px;
    font-size: 0.78rem;
  }
  .repair-detail {
    display: flex;
    align-items: center;
    gap: 0.3rem;
  }
  .repair-mono {
    font-family: var(--font-mono, monospace);
    font-size: 0.75rem;
  }
  .repair-sep {
    color: var(--text-muted);
  }
  .repair-loading {
    display: flex;
    align-items: center;
    gap: 0.5rem;
    font-size: 0.85rem;
    color: var(--text-muted);
    padding: 0.4rem 0;
  }
  .repair-spinner {
    display: inline-block;
    width: 14px;
    height: 14px;
    border: 2px solid color-mix(in srgb, var(--text-muted) 30%, transparent);
    border-top-color: var(--text-muted);
    border-radius: 50%;
    animation: repair-spin 0.6s linear infinite;
  }
  @keyframes repair-spin {
    to {
      transform: rotate(360deg);
    }
  }
  .repair-result {
    margin: 0;
    font-size: 0.85rem;
    line-height: 1.4;
    padding: 0.3rem 0;
  }
  .repair-ok {
    color: var(--status-ok, #27ae60);
  }
  .repair-err {
    color: var(--status-error, #c0392b);
  }
  .repair-buttons {
    display: flex;
    justify-content: flex-end;
    gap: 0.5rem;
    margin-top: 0.3rem;
  }
  .repair-btn {
    font: inherit;
    font-size: 0.85rem;
    padding: 0.35rem 0.8rem;
    border-radius: 4px;
    border: 1px solid color-mix(in srgb, var(--text-muted) 40%, transparent);
    background: transparent;
    color: inherit;
    cursor: pointer;
  }
  .repair-btn:hover,
  .repair-btn:focus-visible {
    background: color-mix(in srgb, var(--chip-default-bg) 45%, transparent);
    outline: none;
  }
  .repair-confirm {
    background: color-mix(in srgb, var(--text-muted) 18%, transparent);
  }
  .repair-confirm:hover,
  .repair-confirm:focus-visible {
    background: color-mix(in srgb, var(--text-muted) 30%, transparent);
  }
</style>
