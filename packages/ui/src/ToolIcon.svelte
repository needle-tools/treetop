<script lang="ts">
  export let name: string | undefined = "";
  export let badge: string | undefined = undefined;
  export let remoteHost: string | undefined = undefined;

  type IconKind =
    | "read"
    | "edit"
    | "write"
    | "bash"
    | "search"
    | "list"
    | "fetch"
    | "end"
    | "create"
    | "delete"
    | "tool";

  function kindFor(toolName: string): IconKind {
    const n = toolName.toLowerCase();
    if (n.includes("filesystem_create")) return "create";
    if (n.includes("filesystem_delete")) return "delete";
    if (n.includes("process_end") || n.includes("kill")) return "end";
    if (n.includes("port_check")) return "fetch";
    if (n.includes("bash") || n.includes("shell") || n.includes("exec"))
      return "bash";
    if (n.includes("read")) return "read";
    if (n === "write") return "write";
    if (n.includes("edit") || n.includes("update") || n.includes("modify"))
      return "edit";
    if (n.includes("grep") || n.includes("search")) return "search";
    if (
      n.includes("glob") ||
      n.includes("ls") ||
      n.includes("list") ||
      n.includes("dir")
    )
      return "list";
    if (n.includes("fetch") || n.includes("web") || n.includes("http"))
      return "fetch";
    return "tool";
  }

  $: kind = kindFor(name ?? "");
</script>

<span
  class="tool-icon-wrap"
  class:has-remote={!!remoteHost}
  title={remoteHost
    ? badge
      ? `Launched via ${badge} on ${remoteHost}`
      : `Ran on ${remoteHost}`
    : badge
      ? `Launched via ${badge}`
      : undefined}
>
  <svg
    width="14"
    height="14"
    viewBox="0 0 24 24"
    fill="none"
    stroke="currentColor"
    stroke-width="2"
    stroke-linecap="round"
    stroke-linejoin="round"
    aria-hidden="true"
    class="tool-icon"
  >
    {#if kind === "read"}
      <!-- eye / visibility -->
      <path d="M2 12s3-7 10-7 10 7 10 7-3 7-10 7-10-7-10-7z" />
      <circle cx="12" cy="12" r="3" />
    {:else if kind === "edit"}
      <!-- pencil -->
      <path d="M12 20h9" />
      <path
        d="M16.5 3.5a2.121 2.121 0 1 1 3 3L7 19l-4 1 1-4 12.5-12.5z"
      />
    {:else if kind === "write"}
      <!-- file-edit-like -->
      <path
        d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"
      />
      <polyline points="14 2 14 8 20 8" />
      <line x1="9" y1="14" x2="15" y2="14" />
      <line x1="9" y1="18" x2="15" y2="18" />
    {:else if kind === "bash"}
      <!-- terminal -->
      <polyline points="4 17 10 11 4 5" />
      <line x1="12" y1="19" x2="20" y2="19" />
    {:else if kind === "search"}
      <!-- magnifier -->
      <circle cx="11" cy="11" r="7" />
      <line x1="21" y1="21" x2="16.65" y2="16.65" />
    {:else if kind === "list"}
      <!-- list / files -->
      <line x1="8" y1="6" x2="21" y2="6" />
      <line x1="8" y1="12" x2="21" y2="12" />
      <line x1="8" y1="18" x2="21" y2="18" />
      <circle cx="4" cy="6" r="1" />
      <circle cx="4" cy="12" r="1" />
      <circle cx="4" cy="18" r="1" />
    {:else if kind === "fetch"}
      <!-- globe / download -->
      <circle cx="12" cy="12" r="9" />
      <line x1="3" y1="12" x2="21" y2="12" />
      <path d="M12 3a14 14 0 0 1 0 18a14 14 0 0 1 0 -18z" />
    {:else if kind === "end"}
      <!-- skull / process cleanup -->
      <path
        d="M12 2a8 8 0 0 0-8 8c0 3.4 2.1 5.6 4 6.7V21h8v-4.3c1.9-1.1 4-3.3 4-6.7a8 8 0 0 0-8-8z"
      />
      <circle cx="9" cy="11" r="1" />
      <circle cx="15" cy="11" r="1" />
      <path d="M12 14v2" />
      <path d="M9 18h6" />
    {:else if kind === "create"}
      <!-- file-plus -->
      <path
        d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"
      />
      <polyline points="14 2 14 8 20 8" />
      <line x1="12" y1="12" x2="12" y2="18" />
      <line x1="9" y1="15" x2="15" y2="15" />
    {:else if kind === "delete"}
      <!-- trash -->
      <polyline points="3 6 5 6 21 6" />
      <path d="M19 6l-1 14a2 2 0 0 1-2 2H8a2 2 0 0 1-2-2L5 6" />
      <path d="M10 11v6" />
      <path d="M14 11v6" />
      <path d="M9 6V4a1 1 0 0 1 1-1h4a1 1 0 0 1 1 1v2" />
    {:else}
      <!-- generic wrench -->
      <path
        d="M14.7 6.3a4 4 0 0 0-5.7 5.6l-6.1 6.1a2 2 0 0 0 2.8 2.8l6.1-6.1a4 4 0 0 0 5.6-5.7l-2.7 2.7-2.5-2.5 2.5-2.9z"
      />
    {/if}
  </svg>
  {#if badge}
    <span class="tool-icon-badge">{badge.slice(0, 3)}</span>
  {/if}
  {#if remoteHost}
    <span class="tool-remote-wrap" aria-label={`Remote host ${remoteHost}`}>
      <svg
        class="tool-remote-icon"
        viewBox="0 0 24 24"
        fill="none"
        stroke="currentColor"
        stroke-width="2"
        stroke-linecap="round"
        stroke-linejoin="round"
        aria-hidden="true"
      >
        <rect x="3" y="4" width="18" height="12" rx="2" />
        <path d="M8 20h8" />
        <path d="M12 16v4" />
      </svg>
      <span class="tool-remote-badge">{remoteHost}</span>
    </span>
  {/if}
</span>

<style>
  .tool-icon-wrap {
    position: relative;
    display: inline-flex;
    flex: 0 0 auto;
    align-items: center;
    justify-content: center;
    gap: 0.28rem;
  }

  .tool-icon {
    flex: 0 0 auto;
    color: var(--text-muted);
  }

  .tool-icon-badge {
    position: absolute;
    right: -0.55rem;
    bottom: -0.35rem;
    max-width: 1rem;
    overflow: hidden;
    border-radius: 999px;
    padding: 0 0.15rem;
    background: var(--bg-elevated, var(--bg-panel, #252525));
    color: var(--text-muted);
    font-family: var(--font-mono, ui-monospace, monospace);
    font-size: 0.42rem;
    line-height: 0.62rem;
    text-transform: lowercase;
    box-shadow: 0 0 0 1px var(--border-subtle, rgba(255, 255, 255, 0.14));
  }

  .has-remote .tool-icon-badge {
    right: auto;
    left: 0.62rem;
  }

  .tool-remote-wrap {
    position: relative;
    display: inline-flex;
    flex: 0 0 auto;
    align-items: center;
    justify-content: center;
    width: 5.8rem;
    color: var(--text-muted);
  }

  .tool-remote-icon {
    width: 0.92rem;
    height: 0.92rem;
  }

  .tool-remote-badge {
    position: absolute;
    left: 1.05rem;
    bottom: -0.42rem;
    max-width: 4.7rem;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
    border-radius: 999px;
    padding: 0 0.22rem;
    background: var(--bg-elevated, var(--bg-panel, #252525));
    color: var(--text-muted);
    font-family: var(--font-mono, ui-monospace, monospace);
    font-size: 0.42rem;
    line-height: 0.62rem;
    box-shadow: 0 0 0 1px var(--border-subtle, rgba(255, 255, 255, 0.14));
  }
</style>
