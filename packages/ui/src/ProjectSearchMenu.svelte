<script lang="ts">
  import { createEventDispatcher } from "svelte";
  import Popover from "./Popover.svelte";
  import PopoverSearchField from "./PopoverSearchField.svelte";
  import { daemonRepoKey } from "./repo-fanout";
  import { relTime } from "./display-helpers";
  import {
    buildProjectActionSearchItems,
    searchItems,
    type SearchItem,
  } from "./workspace-search";

  interface RepoLike {
    id: string;
    name: string;
    color?: string;
    daemonId?: string;
  }

  interface ProjectEntry {
    repo: RepoLike;
    latestActivity?: string;
    liveCount: number;
    working: boolean;
    awaiting: boolean;
  }

  export let repos: RepoLike[] = [];
  export let projectMenuEntries: ProjectEntry[] = [];
  export let projectSearchItems: SearchItem[] = [];
  export let importSessionsOpen = false;
  export let importMenuSource: string | null = null;

  let searchOpen = false;
  let searchQuery = "";
  const actionItems = buildProjectActionSearchItems();

  $: projectSearchResultIds =
    searchOpen && searchQuery.trim()
      ? new Set(
          searchItems(projectSearchItems, searchQuery, {
            kinds: new Set(["project"]),
          }).map((result) => {
            const data = result.item.data as RepoLike | undefined;
            return data?.id ?? result.item.id.replace(/^project:/, "");
          }),
        )
      : null;
  $: actionSearchResultIds =
    searchOpen && searchQuery.trim()
      ? new Set(
          searchItems(actionItems, searchQuery, {
            kinds: new Set(["action"]),
          }).map((result) => result.item.id),
        )
      : null;
  $: visibleProjectMenuEntries = projectSearchResultIds
    ? projectMenuEntries.filter((project) =>
        projectSearchResultIds?.has(project.repo.id),
      )
    : projectMenuEntries;
  $: visibleActionItems = actionSearchResultIds
    ? actionItems.filter((item) => actionSearchResultIds?.has(item.id))
    : actionItems;

  const dispatch = createEventDispatcher<{
    pick: SearchItem;
    focusRepo: { repoId: string };
    addFolder: void;
    openFromSessions: MouseEvent;
  }>();
</script>

<Popover variant="actions" extraClass="projects-popover" unclamped>
  <svelte:fragment slot="head">
    <span class="popover-search-head">
      <span>Projects</span>
      <PopoverSearchField
        bind:open={searchOpen}
        bind:value={searchQuery}
        title="Search projects"
        ariaLabel="Search projects"
        placeholder="Search projects..."
      />
    </span>
  </svelte:fragment>
  {#if repos.length === 0}
    <p class="muted small nopad">No projects yet.</p>
  {:else}
    <ul class="projects-list">
      {#each visibleProjectMenuEntries as project (daemonRepoKey(project.repo))}
        <li>
          <button
            class="projects-row"
            class:has-live={project.liveCount > 0}
            class:is-working={project.working}
            class:is-awaiting={project.awaiting}
            on:click={() => dispatch("focusRepo", { repoId: project.repo.id })}
            title={project.latestActivity
              ? `${project.repo.name}\nLast active ${relTime(project.latestActivity)}`
              : project.repo.name}
          >
            <span
              class="projects-dot"
              style:--project-color={project.repo.color || "var(--text-muted)"}
            >
              <span class="projects-dot-core"></span>
              <svg
                class="projects-dot-spinner"
                viewBox="0 0 24 24"
                aria-hidden="true"
              >
                <circle cx="12" cy="12" r="9.5" pathLength="100" />
              </svg>
            </span>
            <span class="projects-name">{project.repo.name}</span>
            {#if project.latestActivity}
              <span class="projects-time"
                >{relTime(project.latestActivity)}</span
              >
            {/if}
          </button>
        </li>
      {/each}
      {#if visibleProjectMenuEntries.length === 0}
        <li>
          <p class="muted small nopad">
            {visibleActionItems.length === 0
              ? "No projects match."
              : "No matching projects."}
          </p>
        </li>
      {/if}
    </ul>
    {#if visibleActionItems.length > 0}
      <div class="projects-actions">
        {#each visibleActionItems as action (action.id)}
          {#if action.id === "action:add-folder"}
            <button
              class="projects-row projects-add-folder-row"
              on:click={() => dispatch("addFolder")}
            >
              <span class="projects-plus" aria-hidden="true">+</span>
              <span class="projects-name">Add folder</span>
            </button>
          {:else if action.id === "action:open-from-sessions"}
            <button
              class="projects-row projects-add-folder-row"
              on:click|stopPropagation={(e) => dispatch("openFromSessions", e)}
              aria-haspopup="menu"
              aria-expanded={importSessionsOpen &&
                importMenuSource === "projects"}
            >
              <span class="projects-plus" aria-hidden="true">
                <svg
                  width="11"
                  height="11"
                  viewBox="0 0 24 24"
                  fill="none"
                  stroke="currentColor"
                  stroke-width="2"
                  stroke-linecap="round"
                  stroke-linejoin="round"
                  aria-hidden="true"
                >
                  <path d="M12 3v12" />
                  <path d="M7 10l5 5 5-5" />
                  <path d="M5 21h14" />
                </svg>
              </span>
              <span class="projects-name">Open from sessions</span>
            </button>
          {/if}
        {/each}
      </div>
    {/if}
  {/if}
</Popover>
