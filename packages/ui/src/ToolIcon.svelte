<script lang="ts">
  export let name: string | undefined = "";

  type IconKind =
    | "read"
    | "edit"
    | "write"
    | "bash"
    | "search"
    | "list"
    | "fetch"
    | "tool";

  function kindFor(toolName: string): IconKind {
    const n = toolName.toLowerCase();
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
    <path d="M16.5 3.5a2.121 2.121 0 1 1 3 3L7 19l-4 1 1-4 12.5-12.5z" />
  {:else if kind === "write"}
    <!-- file-edit-like -->
    <path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z" />
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
  {:else}
    <!-- generic wrench -->
    <path
      d="M14.7 6.3a4 4 0 0 0-5.7 5.6l-6.1 6.1a2 2 0 0 0 2.8 2.8l6.1-6.1a4 4 0 0 0 5.6-5.7l-2.7 2.7-2.5-2.5 2.5-2.9z"
    />
  {/if}
</svg>

<style>
  .tool-icon {
    flex: 0 0 auto;
    color: var(--text-muted);
  }
</style>
