<script lang="ts" context="module">
  export interface InflightRec {
    id: string;
    agent: string;
    sessionId: string;
    pid: number;
    textPreview: string;
    startedAt: string;
  }
</script>

<script lang="ts">
  /**
   * The shared per-session column header. Same 4-column grid for every
   * variant — brand-new TUI, resumed Claude/Codex session in TUI mode,
   * stored-chat read mode — so users see one consistent affordance set
   * regardless of which path got them here.
   *
   * Missing data (no sid yet, no token usage yet, ...) just hides the
   * relevant chip. The header structure stays put so the column doesn't
   * jitter as the agent's first JSONL line lands and the metadata
   * fills in.
   */
  import { onMount, onDestroy } from "svelte";
  import ManualTitle from "./ManualTitle.svelte";
  import SessionMenu, { type SessionMenuItem } from "./SessionMenu.svelte";
  import Popover from "./Popover.svelte";
  import Tooltip from "./Tooltip.svelte";
  import SleepIndicationAnimation from "./SleepIndicationAnimation.svelte";
  import { ICONS } from "./icons";
  import { contextChip } from "./context-tokens";
  import type { AgentSettingGroup } from "./claude-session-menu";

  export let agent:
    | "claude"
    | "codex"
    | "copilot"
    | "ollama"
    | "shell"
    | "files"
    | "history";
  /** Overrides the lowercase agent name in the agent-pill. Used by
   *  Ollama columns to show the model tag (e.g. `qwen3-coder:30b`)
   *  instead of the generic "ollama" — for an Ollama column the
   *  picked model is what the user actually identifies the session
   *  by; "ollama" is redundant when every Ollama column would carry
   *  the same label. Undefined ⇒ render the agent name. */
  export let agentLabel: string | undefined = undefined;
  /** Optional small glyph rendered inside the agent-pill right after the
   *  label (e.g. the colour-coded effort indicator after "opus"). The
   *  `paths` are filled SVG `d`-strings in a 24×24 viewBox; `color` tints
   *  them. Undefined ⇒ nothing rendered. */
  export let agentIcon:
    | { paths: string[]; trackPaths?: string[]; color: string; title?: string }
    | undefined = undefined;
  /** Settings groups (Model, Effort, …) for this agent's pill popover.
   *  Non-empty ⇒ the agent pill becomes a clickable trigger that opens a
   *  settings popover mirroring the burger menu's selection (with current
   *  state). Empty ⇒ the pill is non-interactive unless a placeholder is
   *  given. */
  export let agentSettings: AgentSettingGroup[] = [];
  /** When set (and `agentSettings` is empty), the pill still opens a
   *  popover showing this muted message instead of options — used by
   *  agents we don't have settings for yet (e.g. codex). */
  export let settingsPlaceholder: string | undefined = undefined;
  export let source: string;
  export let manualTitle: string = "";
  /** AI-generated title (from the cached Ollama summary). When the user
   *  hasn't set a manual title, it's shown as the rename input's
   *  placeholder instead of the generic "Name this session…". */
  export let aiTitle: string = "";
  /** "read" hides Stop Session / fullscreen; "terminal" shows them. */
  export let mode: "read" | "terminal" = "terminal";
  /** Whether the column can switch from the visual transcript/app view
   *  into a resumed terminal surface. */
  export let canResume: boolean = false;
  /** Whether the column can be ended (Dispose) right now. */
  export let canEnd: boolean = true;
  /** Read mode normally exposes Resume only. Live visual app surfaces use
   *  the same primary slot for Stop while a turn is active. */
  export let showEndInRead: boolean = false;
  export let disposing: boolean = false;
  export let awaitingInput: boolean = false;
  /** Whether the PTY is currently emitting output. True ⇒ a rotating
   *  conic-gradient ring sweeps the agent pill in the agent's colour.
   *  False ⇒ a solid border in the agent's colour smoothly pulses
   *  between dim and bright. Only meaningful in terminal mode (the
   *  consumer gates on `mode === "terminal" && working` before
   *  passing it through). */
  export let working: boolean = false;

  // Metadata (all optional — empty values just don't render their chip)
  export let loadedMessageCount: number | undefined = undefined;
  export let totalMessageCount: number | undefined = undefined;
  export let contextTokens: number | undefined = undefined;
  export let contextTokensExact: boolean | undefined = undefined;
  /** Authoritative cap shipped by the agent's JSONL (Codex 0.130+).
   *  Wins over the model-id heuristic inside contextChip. */
  export let contextWindow: number | undefined = undefined;
  export let model: string | undefined = undefined;
  export let lastActivityIso: string | undefined = undefined;
  /** Text of the user's most recent message in this session, surfaced
   *  in the rich hover-tooltip on the "last activity" chip. Often the
   *  user wants a quick "what did I last ask?" reminder without
   *  scrolling the column — this is that reminder. Undefined ⇒ the
   *  tooltip omits the "Your last message" section. */
  export let lastUserMessage: string | undefined = undefined;
  export let pollCount: number = 0;
  export let lastLoadedAt: number = 0;
  export let inflight: InflightRec[] = [];
  /** Placeholder text shown when `lastActivityIso` is empty. Lets
   *  brand-new TUI columns render e.g. "new session" in the activity
   *  slot instead of leaving the column blank until the agent's first
   *  JSONL line lands. Undefined ⇒ hide the slot when empty. */
  export let lastActivityFallback: string | undefined = undefined;
  /** Placeholder for the message-count slot, same idea. */
  export let messageCountFallback: string | undefined = undefined;
  export let menuItems: SessionMenuItem[] = [];
  /** Extra line appended to ManualTitle's rest-state tooltip. The
   *  SessionView passes the cached Ollama summary here so a hover
   *  over the title surfaces the session's gist without expanding
   *  the column. */
  export let titleTooltipExtra: string | undefined = undefined;

  /** Whether this session is starred (favorite). Only meaningful for
   *  agent sessions (claude/codex/copilot/ollama). */
  export let starred: boolean = false;
  export let onToggleStar: () => void = () => {};

  // Callbacks
  export let onTitleSaved: (next: string) => void = () => {};
  export let onTitleEditingChange: (editing: boolean) => void = () => {};
  export let onResume: () => void = () => {};
  export let onEndSession: () => void = () => {};
  export let onSshBrowse: (() => void) | undefined = undefined;
  $: if (sshConnected)
    console.debug(
      "[SessionHeader] sshConnected=true, onSshBrowse=",
      !!onSshBrowse,
    );
  export let sshConnected = false;
  export let onCancelInflight: () => void = () => {};
  export let onClose: () => void = () => {};
  export let onDragStart: (e: DragEvent) => void = () => {};

  /** Tooltip strings for the Stop Session / Terminal switch buttons. Default
   *  texts work for SessionView; NewSessionCol can override. */
  export let endSessionTitle: string | undefined =
    "SIGTERM the PTY and flip back to the chat view";
  export let endSessionLabel: string | undefined = "Stop Session";
  export let resumeTitle: string =
    "Spawn a live resume PTY in this session's cwd";
  /** Tooltip for the × close button. Default reflects SessionView's
   *  semantics: the column unmounts but the JSONL stays on disk, so
   *  reopening the session from the worktree's picker resumes the
   *  full chat history. Consumers with different semantics (a fresh
   *  TUI whose PTY dies when its column unmounts) should override. */
  export let closeTitle: string =
    "Close this column.\nThe session stays saved on disk — reopen it anytime from the worktree's session picker.";

  $: ctxChip = contextChip({
    tokens: contextTokens,
    exact: contextTokensExact,
    model,
    agent: agent === "shell" || agent === "ollama" ? undefined : agent,
    cap: contextWindow,
  });

  function relTimeFromNow(ts: number): string {
    const s = Math.floor((Date.now() - ts) / 1000);
    if (s < 2) return "just now";
    if (s < 60) return `${s}s ago`;
    return `${Math.floor(s / 60)}m ago`;
  }
  function relTimeFromIso(iso: string): string {
    const s = Math.floor((Date.now() - Date.parse(iso)) / 1000);
    if (s < 60) return "just now";
    if (s < 120) return "1 minute ago";
    if (s < 3600) return `${Math.floor(s / 60)} minutes ago`;
    if (s < 7200) return "1 hour ago";
    if (s < 86400) return `${Math.floor(s / 3600)} hours ago`;
    if (s < 172800) return "yesterday";
    return `${Math.floor(s / 86400)} days ago`;
  }

  /** Bound to the header element so the burger-menu "Toggle fullscreen"
   *  action can find its `.session` ancestor without an event target —
   *  the menu hands actions a bounding rect, not the clicked node. */
  let headerEl: HTMLElement | null = null;
  function toggleFullscreen() {
    const el = headerEl?.closest(".session") as HTMLElement | null;
    if (!el) return;
    if (document.fullscreenElement === el) {
      void document.exitFullscreen().catch(() => {});
    } else {
      void el.requestFullscreen().catch(() => {});
    }
  }

  /** When the column is in TUI mode we splice a "Toggle fullscreen"
   *  entry on top of whatever the parent passed in. Keeps the action
   *  reachable for keyboard users (the burger is focusable) and trims
   *  the right-side button cluster down to just Stop Session + ×. */
  $: isAgentSession =
    agent === "claude" ||
    agent === "codex" ||
    agent === "copilot" ||
    agent === "ollama";

  let starJumping = false;
  let starFixedStyle = "";
  let starBtnEl: HTMLButtonElement | null = null;
  function handleStarClick() {
    const wasStarred = starred;
    onToggleStar();
    if (!wasStarred && starBtnEl) {
      const r = starBtnEl.getBoundingClientRect();
      starFixedStyle = `position:fixed;left:${r.left}px;top:${r.top}px;z-index:9999;`;
      starJumping = true;
      setTimeout(() => {
        starJumping = false;
        starFixedStyle = "";
      }, 1800);
    }
  }

  /** Agent-pill settings popover. The pill is a trigger only when there
   *  are settings to show (claude today; codex later). State lives here —
   *  the popover is one-per-column, so local state is enough. */
  /** Title-cased agent name for the placeholder sentence ("Files", "Codex"). */
  $: agentTitleCase = agent.charAt(0).toUpperCase() + agent.slice(1);
  /** What the popover shows when there are no real settings: the caller's
   *  override if any, else a generic "nothing here yet" note — so EVERY
   *  pill is a consistent, clickable affordance, not just the ones we've
   *  built settings for. */
  $: effectivePlaceholder =
    agentSettings.length > 0
      ? undefined
      : (settingsPlaceholder ?? `No settings for ${agentTitleCase} yet.`);
  $: pillInteractive = agentSettings.length > 0 || !!effectivePlaceholder;
  let settingsOpen = false;
  let pillAnchorEl: HTMLElement | null = null;
  /** Staged selections (groupKey → value) while the popover is open. Picks
   *  are non-destructive — nothing is applied until the user hits Apply,
   *  so opening the popover and clicking around never restarts a session. */
  let staged: Record<string, string> = {};

  function currentValue(group: AgentSettingGroup): string | undefined {
    return group.options.find((o) => o.selected)?.value;
  }
  function openSettings() {
    const next: Record<string, string> = {};
    for (const g of agentSettings) {
      const v = currentValue(g);
      if (v !== undefined) next[g.key] = v;
    }
    staged = next;
    settingsOpen = true;
  }
  function toggleSettings() {
    if (settingsOpen) settingsOpen = false;
    else openSettings();
  }
  function selectOption(group: AgentSettingGroup, value: string) {
    staged = { ...staged, [group.key]: value };
  }
  $: settingsDirty = agentSettings.some((g) => {
    const v = staged[g.key];
    return v !== undefined && v !== currentValue(g);
  });
  function applySettings() {
    for (const g of agentSettings) {
      const v = staged[g.key];
      if (v !== undefined && v !== currentValue(g)) g.onPick(v);
    }
    settingsOpen = false;
  }
  function onDocClick(e: MouseEvent) {
    if (!settingsOpen) return;
    const t = e.target as Node | null;
    if (pillAnchorEl && t && !pillAnchorEl.contains(t)) settingsOpen = false;
  }
  function onDocKey(e: KeyboardEvent) {
    if (settingsOpen && e.key === "Escape") settingsOpen = false;
  }
  onMount(() => {
    document.addEventListener("click", onDocClick);
    document.addEventListener("keydown", onDocKey);
  });
  onDestroy(() => {
    document.removeEventListener("click", onDocClick);
    document.removeEventListener("keydown", onDocKey);
  });

  $: effectiveMenuItems =
    mode === "terminal"
      ? ([
          {
            kind: "action",
            label: "Toggle fullscreen",
            icon: "⛶",
            title: "Fill the viewport with this column (Esc to exit)",
            onSelect: () => toggleFullscreen(),
          },
          ...menuItems,
        ] satisfies SessionMenuItem[])
      : menuItems;
  $: showReadEnd = mode === "read" && showEndInRead && canEnd;
  $: showReadResume = canResume && mode === "read" && !showReadEnd;
  $: effectiveEndSessionTitle =
    endSessionTitle ?? "SIGTERM the PTY and flip back to the chat view";
  $: effectiveEndSessionLabel = endSessionLabel ?? "Stop Session";
</script>

<header bind:this={headerEl} draggable="true" on:dragstart={onDragStart}>
  <div class="hdr-col col-agent">
    <span class="agent-pill-anchor" bind:this={pillAnchorEl}>
      {#snippet pillBody()}{#if sshConnected}<svg
            class="ssh-conn-icon"
            viewBox="0 0 24 24"
            fill="none"
            stroke="currentColor"
            stroke-width="2"
            stroke-linecap="round"
            stroke-linejoin="round"
            aria-label="SSH connection active"
            ><title>SSH connection active</title
            >{#each ICONS.monitor.paths ?? [] as d}<path {d} />{/each}</svg
          >{/if}{agentLabel ?? agent}{#if agentIcon}<svg
            class="agent-pill-icon"
            viewBox="0.5 6 23 12"
            style="color:{agentIcon.color}"
            aria-hidden="true"
            >{#if agentIcon.title}<title>{agentIcon.title}</title
              >{/if}{#each agentIcon.trackPaths ?? [] as d}<path
                {d}
                class="gauge-track"
              />{/each}{#each agentIcon.paths as d}<path {d} />{/each}</svg
          >{/if}{#if mode === "terminal"}<span
            class="sleep-slot"
            title={!working ? "Idle — waiting for input" : ""}
            ><SleepIndicationAnimation visible={!working} /></span
          >{/if}{/snippet}
      {#if pillInteractive}
        <button
          class="agent-pill agent-{agent} interactive"
          class:working={working}
          class:idle={mode === "terminal" && !working}
          type="button"
          title={`${agent} settings — model & effort`}
          aria-haspopup="menu"
          aria-expanded={settingsOpen}
          draggable="false"
          on:click|stopPropagation={toggleSettings}
          on:dragstart|preventDefault|stopPropagation
          >{@render pillBody()}</button
        >
      {:else}
        <span
          class="agent-pill agent-{agent}"
          class:working={working}
          class:idle={mode === "terminal" && !working}
          >{@render pillBody()}</span
        >
      {/if}
      {#if settingsOpen}
        <Popover
          variant="agents"
          extraClass="agent-settings-popover"
          headClass="agent-settings-popover-head"
        >
          <svelte:fragment slot="head"><span>{agent} settings</span></svelte:fragment>
          {#if agentSettings.length > 0}
            <div class="agent-settings-body">
              {#each agentSettings as group (group.key)}
                <div class="agent-settings-group">
                  <span class="agent-settings-glabel">{group.label}</span>
                  <div class="agent-settings-opts">
                    {#each group.options as opt (opt.value)}
                      {@const active =
                        (staged[group.key] ?? currentValue(group)) === opt.value}
                      <button
                        type="button"
                        class="agent-settings-opt"
                        class:selected={active}
                        on:click={() => selectOption(group, opt.value)}
                      >
                        {#if opt.icon}<svg
                            class="agent-settings-opt-icon"
                            viewBox="0.5 6 23 12"
                            style="color:{opt.icon.color}"
                            aria-hidden="true"
                            >{#each opt.icon.trackPaths as d}<path
                                {d}
                                class="gauge-track"
                              />{/each}{#each opt.icon.paths as d}<path
                                {d}
                              />{/each}</svg
                          >{/if}
                        <span class="agent-settings-opt-label">{opt.label}</span>
                        {#if active}<svg
                            class="agent-settings-check"
                            viewBox="0 0 24 24"
                            aria-hidden="true"><path d="M20 6 9 17l-5-5" /></svg
                          >{/if}
                      </button>
                    {/each}
                  </div>
                </div>
              {/each}
              <div class="agent-settings-foot">
                <button
                  type="button"
                  class="agent-settings-apply"
                  disabled={!settingsDirty}
                  on:click={applySettings}
                >Apply</button>
              </div>
            </div>
          {:else if effectivePlaceholder}
            <p class="agent-settings-empty muted small">{effectivePlaceholder}</p>
          {/if}
        </Popover>
      {/if}
    </span>
    {#if isAgentSession}
      <span class="star-slot">
        <button
          bind:this={starBtnEl}
          class="star-btn"
          class:starred
          class:jump={starJumping}
          style={starFixedStyle}
          type="button"
          title={starred
            ? "Unstar this session"
            : "Star this session — pinned to the top of the session picker"}
          on:click|stopPropagation={handleStarClick}
          aria-label={starred ? "Unstar session" : "Star session"}
        >
          <svg viewBox="0 0 24 24" width="16" height="16" aria-hidden="true">
            {#if starred}
              <path
                fill="currentColor"
                d="M12 2l3.09 6.26L22 9.27l-5 4.87 1.18 6.88L12 17.77l-6.18 3.25L7 14.14 2 9.27l6.91-1.01z"
              />
            {:else}
              <path
                fill="none"
                stroke="currentColor"
                stroke-width="1.8"
                stroke-linejoin="round"
                d="M12 2l3.09 6.26L22 9.27l-5 4.87 1.18 6.88L12 17.77l-6.18 3.25L7 14.14 2 9.27l6.91-1.01z"
              />
            {/if}
          </svg>
        </button>
      </span>
    {/if}
  </div>
  <div class="hdr-col col-name">
    <ManualTitle
      {source}
      value={manualTitle}
      placeholder={aiTitle?.trim() ? aiTitle : "Name this session…"}
      extraTooltip={titleTooltipExtra}
      on:saved={(e) => onTitleSaved(e.detail.title)}
      onEditingChange={onTitleEditingChange}
    />
    {#if ctxChip}
      <Tooltip variant="wide" placement="bottom" escapeClip>
        <span
          slot="trigger"
          class="ctx-bar"
          class:warn={ctxChip.ratio !== undefined &&
            ctxChip.ratio > 0.6 &&
            ctxChip.ratio <= 0.85}
          class:hot={ctxChip.ratio !== undefined && ctxChip.ratio > 0.85}
          class:unknown={ctxChip.ratio === undefined}
          aria-label={ctxChip.text}
        >
          <span
            class="ctx-bar-fill"
            style:width={ctxChip.ratio !== undefined
              ? `${Math.min(100, Math.round(ctxChip.ratio * 100))}%`
              : "100%"}
          ></span>
          <span class="ctx-bar-text muted small">
            <span class="ctx-bar-now">{ctxChip.absolute}</span
            ><!--
            --><span class="ctx-bar-rest">
              {#if ctxChip.capText}
                {` / ${ctxChip.capText} ctx (${Math.round((ctxChip.ratio ?? 0) * 100)}%)`}
              {:else}
                {` / ??? ctx`}
              {/if}
            </span>
          </span>
        </span>
        <div slot="content" class="ctx-tt">
          <div class="ctx-tt-head">
            Estimated context size at the start of the next turn
          </div>
          <dl class="ctx-tt-kv">
            <dt>Model</dt>
            <dd>{model ?? "(unknown)"}</dd>
            <dt>Tokens</dt>
            <dd>
              {contextTokens !== undefined
                ? contextTokens.toLocaleString()
                : "—"}
              {#if ctxChip.ratio !== undefined}
                <span class="muted small"
                  >({Math.round(ctxChip.ratio * 100)}% of cap)</span
                >
              {/if}
            </dd>
          </dl>
          <div class="ctx-tt-section">
            <div class="ctx-tt-section-head">How it's computed</div>
            {#if contextTokensExact}
              <ul>
                <li>
                  Read from the most recent assistant turn's <code
                    >message.usage</code
                  > in the session JSONL.
                </li>
                <li>
                  Sum of <code>input_tokens</code> +
                  <code>cache_read_input_tokens</code>
                  + <code>cache_creation_input_tokens</code> — the three disjoint
                  slices Anthropic reports for that request, so their sum is everything
                  the model saw as input.
                </li>
                <li>
                  Output tokens are excluded (they're generated, not in-context
                  yet).
                </li>
                <li>
                  Lagged by one turn: your next prompt adds a bit more on top.
                </li>
              </ul>
            {:else}
              <ul>
                <li>
                  Codex's JSONL doesn't carry a usage block, so this is a rough
                  estimate.
                </li>
                <li>
                  Sum of every user/assistant message's content length ÷ 4
                  (OpenAI's chars-per-token rule of thumb).
                </li>
                <li>Developer / system / event messages are excluded.</li>
              </ul>
            {/if}
          </div>
          <div class="ctx-tt-section">
            <div class="ctx-tt-section-head">Cap (picked from model id)</div>
            <ul>
              <li>Opus / Sonnet 4.6+ → 1,000,000</li>
              <li>Haiku 4.5 → 200,000</li>
              <li>Legacy Opus / Sonnet (≤4.5) → 200,000</li>
              <li>
                Unknown model → shown as <code>???</code> (no fabricated denominator).
              </li>
            </ul>
          </div>
        </div>
      </Tooltip>
    {/if}
    {#if inflight.length > 0}
      <button
        class="inflight-pill"
        type="button"
        title={inflight
          .map(
            (r) =>
              `pid ${r.pid}: ${r.textPreview}${r.textPreview.length === 200 ? "…" : ""}`,
          )
          .join("\n")}
        on:click={onCancelInflight}
      >
        <span class="spinner" aria-hidden="true"></span>
        <span>{inflight.length} sending — click to cancel</span>
      </button>
    {/if}
  </div>
  <div class="hdr-col col-meta">
    {#if lastActivityIso}
      {#if lastUserMessage && lastUserMessage.trim().length > 0}
        <Tooltip variant="wide" placement="bottom" escapeClip>
          <span slot="trigger" class="muted small last-activity"
            >last activity {relTimeFromIso(lastActivityIso)}</span
          >
          <pre slot="content" class="la-tt-msg">{lastUserMessage}</pre>
        </Tooltip>
      {:else}
        <span class="muted small last-activity"
          >last activity {relTimeFromIso(lastActivityIso)}</span
        >
      {/if}
    {:else if lastActivityFallback}
      <span class="muted small last-activity placeholder"
        >{lastActivityFallback}</span
      >
    {/if}
    {#if loadedMessageCount !== undefined}
      <span
        class="muted small msg-count"
        title={totalMessageCount !== undefined &&
        totalMessageCount > loadedMessageCount
          ? `Showing the last ${loadedMessageCount} of ${totalMessageCount.toLocaleString()} messages.`
          : `${loadedMessageCount} message${loadedMessageCount === 1 ? "" : "s"} in this session`}
      >
        {#if totalMessageCount !== undefined && totalMessageCount > loadedMessageCount}
          {loadedMessageCount} of {totalMessageCount.toLocaleString()} messages
        {:else}
          {loadedMessageCount} messages
        {/if}
      </span>
    {:else if totalMessageCount !== undefined}
      <span
        class="muted small msg-count"
        title={`${totalMessageCount.toLocaleString()} message${totalMessageCount === 1 ? "" : "s"} in this session`}
        >{totalMessageCount.toLocaleString()} messages</span
      >
    {:else if messageCountFallback}
      <span class="muted small msg-count placeholder"
        >{messageCountFallback}</span
      >
    {/if}
  </div>
  <div class="hdr-col col-actions">
    {#if showReadResume}
      <button class="resume-btn" on:click={onResume} title={resumeTitle}
        >Resume</button
      >
    {/if}
    {#if showReadEnd}
      <button
        class="resume-btn dispose-btn"
        class:is-stopping={disposing}
        class:is-running={working && !disposing}
        on:click={onEndSession}
        title={disposing
          ? "Click again to cancel — the agent is still running"
          : effectiveEndSessionTitle}
      >
        {#if disposing}
          <span class="stop-spinner" aria-hidden="true"></span>
          <span>Stopping…</span>
        {:else if working}
          <span class="stop-running-ring" aria-hidden="true"></span>
          <span>{effectiveEndSessionLabel}</span>
        {:else}
          {effectiveEndSessionLabel}
        {/if}
      </button>
    {/if}
    {#if mode === "terminal"}
      {#if awaitingInput}
        <span
          class="awaiting-pill"
          title="The agent is paused on a prompt — focus the terminal and respond."
          >needs input</span
        >
      {/if}
      {#if sshConnected && onSshBrowse}
        <button
          class="resume-btn ssh-browse-btn"
          on:click={() => {
            console.debug("[SessionHeader] Browse Files clicked");
            onSshBrowse?.();
          }}
          title="Browse remote filesystem"
        >
          <svg
            width="13"
            height="13"
            viewBox="0 0 24 24"
            fill="none"
            stroke="currentColor"
            stroke-width="2"
            stroke-linecap="round"
            stroke-linejoin="round"
            ><path
              d="M22 19a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h5l2 3h9a2 2 0 0 1 2 2z"
            /></svg
          >
          Browse Files
        </button>
      {/if}
      {#if canEnd}
        <button
          class="resume-btn dispose-btn"
          class:is-stopping={disposing}
          class:is-running={working && !disposing}
          on:click={onEndSession}
          title={disposing
            ? "Click again to cancel — the agent is still running"
            : effectiveEndSessionTitle}
        >
          {#if disposing}
            <span class="stop-spinner" aria-hidden="true"></span>
            <span>Stopping…</span>
          {:else if working}
            <span class="stop-running-ring" aria-hidden="true"></span>
            <span>{effectiveEndSessionLabel}</span>
          {:else}
            {effectiveEndSessionLabel}
          {/if}
        </button>
      {/if}
    {/if}
    {#if effectiveMenuItems.length > 0}
      <SessionMenu items={effectiveMenuItems} />
    {/if}
    <button
      class="close"
      on:click={onClose}
      title={closeTitle}
      aria-label="Close column">×</button
    >
  </div>
</header>

<style>
  header {
    display: flex;
    align-items: center;
    gap: 0.6rem;
    padding: 0.4rem 0.6rem;
    background: var(--surface-2);
    border-bottom: 1px solid var(--surface-3);
    cursor: grab;
    user-select: none;
  }
  header:active {
    cursor: grabbing;
  }
  .hdr-col {
    display: flex;
    line-height: 1.1;
  }
  .col-agent {
    flex: 0 0 auto;
    align-items: center;
  }
  .col-name {
    /* Grow to fill the space col-meta + col-actions don't claim. The
       title can still ellipsize (it explicitly sets min-width: 0 on
       its own button), but we floor col-name itself at a ~2x-wider
       minimum so a cramped column doesn't truncate the title down to
       6 chars before anything else gives. Pair with the bumped
       .session-col min-width in worktree-row.css. */
    flex: 1 1 0;
    min-width: 16ch;
    flex-direction: column;
    align-items: flex-start;
    gap: 0.15rem;
  }
  .col-name > :global(*) {
    max-width: 100%;
  }
  .col-meta {
    /* Intrinsic size — col-meta never gets squeezed. col-name takes
       the slack via flex: 1, so the title is what ellipsizes when
       the column is tight. */
    flex: 0 0 auto;
    flex-direction: column;
    align-items: flex-start;
    gap: 0.15rem;
  }
  .col-meta > * {
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
    display: block;
  }
  .col-meta .placeholder {
    font-style: italic;
    color: var(--text-faint);
  }
  .col-actions {
    /* Sits flush right because col-name grows; we don't need this
       column to flex any further. */
    flex: 0 0 auto;
    align-items: center;
    justify-content: flex-end;
    gap: 0.35rem;
  }
  .resume-btn {
    flex: 0 0 auto;
    align-self: center;
    background: transparent;
    color: var(--text-muted);
    border: 1px solid var(--surface-3);
    padding: 0.25rem 0.6rem;
    border-radius: var(--radius-sm);
    font-size: 0.7rem;
    cursor: pointer;
  }
  .resume-btn:hover {
    color: var(--text-1);
    border-color: var(--text-faint);
  }
  .resume-btn.ssh-browse-btn {
    display: inline-flex;
    align-items: center;
    gap: 0.3rem;
  }
  .resume-btn.dispose-btn {
    color: #efaaaa;
    border-color: color-mix(in srgb, #efaaaa 30%, transparent);
    background: color-mix(in srgb, var(--error-bg) 50%, transparent);
  }
  .resume-btn.dispose-btn:hover:not(:disabled) {
    color: #ffcaca;
    border-color: color-mix(in srgb, #efaaaa 55%, transparent);
  }
  .resume-btn.dispose-btn.is-running {
    display: inline-flex;
    align-items: center;
    gap: 0.35rem;
  }
  /* "Stopping…" state: stays clickable (a second click cancels during
     the 1s grace window) but signals progress with a spinner and a
     slight desaturation so it reads as "in-flight, not destructive
     finality." */
  .resume-btn.dispose-btn.is-stopping {
    display: inline-flex;
    align-items: center;
    gap: 0.35rem;
    opacity: 0.85;
  }
  .stop-spinner {
    width: 0.7rem;
    height: 0.7rem;
    border-radius: 50%;
    border: 1.5px solid color-mix(in srgb, currentColor 35%, transparent);
    border-top-color: currentColor;
    animation: spin 0.8s linear infinite;
    flex: 0 0 auto;
  }
  .stop-running-ring {
    width: 0.7rem;
    height: 0.7rem;
    border-radius: 50%;
    border: 1.5px solid color-mix(in srgb, currentColor 22%, transparent);
    border-top-color: currentColor;
    border-right-color: color-mix(in srgb, currentColor 70%, transparent);
    animation: spin 1.05s linear infinite;
    flex: 0 0 auto;
  }
  .resume-btn:disabled {
    opacity: 0.55;
    cursor: not-allowed;
  }
  .agent-pill {
    /* Position-relative so the .working state's ::before ring can
       anchor to the pill bounds. Inline-block keeps inline flow while
       still letting the ring extend a few px outside the padding box. */
    position: relative;
    display: inline-flex;
    align-items: center;
    gap: 0.25rem;
    padding: 0.1rem 0.5rem;
    border-radius: var(--radius-sm);
    font-size: 0.72rem;
    text-transform: lowercase;
    font-family: ui-monospace, monospace;
    /* Always-on transparent border so toggling .idle (which paints a
       real border) doesn't reflow the pill by 1px in either axis. */
    border: 1px solid transparent;
    /* The pill renders as a <button> when it has settings (and a <span>
       otherwise); neutralise the UA button chrome so both look identical. */
    appearance: none;
    -webkit-appearance: none;
    margin: 0;
    line-height: 1.1;
  }
  /* Interactive (has a settings popover): pointer + a subtle hover lift so
     it reads as "click me" without an extra glyph. */
  .agent-pill.interactive {
    cursor: pointer;
  }
  .agent-pill.interactive:hover {
    filter: brightness(1.12);
  }
  .agent-pill-anchor {
    position: relative;
    display: inline-flex;
    align-items: center;
    flex-shrink: 0;
  }
  /* Settings popover body (slot content lives in this component's scope). */
  .agent-settings-body {
    display: flex;
    flex-direction: column;
    gap: 0.7rem;
  }
  .agent-settings-group {
    display: flex;
    flex-direction: column;
    gap: 0.3rem;
  }
  .agent-settings-glabel {
    font-size: 0.72rem;
    font-weight: 600;
    text-transform: uppercase;
    letter-spacing: 0.05em;
    color: var(--text-muted);
  }
  .agent-settings-opts {
    display: flex;
    flex-wrap: wrap;
    gap: 0.3rem;
  }
  .agent-settings-opt {
    display: inline-flex;
    align-items: center;
    gap: 0.4rem;
    padding: 0.25rem 0.55rem;
    border-radius: var(--radius-sm);
    border: 1px solid color-mix(in srgb, var(--text-muted) 25%, transparent);
    background: transparent;
    color: var(--text-1);
    font: inherit;
    font-size: 0.8rem;
    cursor: pointer;
  }
  .agent-settings-opt:hover {
    background: var(--surface-2);
  }
  .agent-settings-opt.selected {
    border-color: var(--brand);
    background: color-mix(in srgb, var(--brand) 14%, transparent);
  }
  .agent-settings-opt-label {
    text-transform: lowercase;
    font-family: ui-monospace, monospace;
  }
  /* Effort gauge in the option — same glyph as the pill badge / menu. */
  .agent-settings-opt-icon {
    width: 1.7em;
    height: 0.95em;
    flex-shrink: 0;
    fill: currentColor;
    stroke: none;
  }
  .agent-settings-opt-icon .gauge-track {
    fill: var(--text-faint);
    opacity: 0.5;
  }
  .agent-settings-check {
    width: 0.85em;
    height: 0.85em;
    flex-shrink: 0;
    margin-left: auto;
    fill: none;
    stroke: var(--status-clean);
    stroke-width: 2.5;
    stroke-linecap: round;
    stroke-linejoin: round;
  }
  /* Apply footer — changes are staged on click and only committed here,
     so opening the popover and browsing options never restarts a session. */
  .agent-settings-foot {
    display: flex;
    justify-content: flex-end;
    margin-top: 0.1rem;
  }
  .agent-settings-apply {
    padding: 0.3rem 0.8rem;
    border-radius: var(--radius-sm);
    border: 1px solid var(--brand);
    background: var(--brand);
    color: var(--on-brand, #fff);
    font: inherit;
    font-size: 0.8rem;
    font-weight: 600;
    cursor: pointer;
  }
  .agent-settings-apply:hover:not(:disabled) {
    filter: brightness(1.1);
  }
  .agent-settings-apply:disabled {
    opacity: 0.45;
    cursor: default;
  }
  .agent-settings-empty {
    margin: 0;
    color: var(--text-muted);
  }
  .ssh-conn-icon {
    width: 0.85em;
    height: 0.85em;
    flex-shrink: 0;
    opacity: 0.85;
  }
  /* Effort glyph after the model name. Filled (matches the menu's bars),
     tinted via the inline `color` from the effort ramp. Sized a touch
     taller than the lowercase text so the bars read at pill scale. */
  /* Wider-than-tall footprint matching the tight gauge viewBox (~2:1) so
     the semicircle renders large enough to read at pill text size — a
     square 1em box wasted ~half its height on the gauge's flat bottom. */
  .agent-pill-icon {
    width: 1.85em;
    height: 1em;
    flex-shrink: 0;
    fill: currentColor;
    stroke: none;
  }
  /* Dim/neutral gauge remainder behind the coloured fill. */
  .agent-pill-icon .gauge-track {
    fill: var(--text-faint);
    opacity: 0.5;
  }
  .agent-pill.agent-claude {
    background: var(--chip-orange-bg);
    color: var(--chip-orange-text);
    --agent-color: var(--chip-orange-text);
  }
  .agent-pill.agent-codex {
    background: var(--chip-codex-bg);
    color: var(--chip-codex-text);
    --agent-color: var(--chip-codex-text);
  }
  .agent-pill.agent-ollama {
    background: var(--chip-ollama-bg);
    color: var(--chip-ollama-text);
    --agent-color: var(--chip-ollama-text);
  }
  .agent-pill.agent-copilot {
    background: var(--chip-default-bg);
    color: var(--chip-default-text);
    --agent-color: var(--chip-default-text);
  }
  .agent-pill.agent-shell {
    background: var(--surface-3);
    color: var(--text-2);
    --agent-color: var(--text-2);
  }
  .agent-pill.agent-files {
    background: var(--chip-default-bg);
    color: var(--chip-default-text);
    --agent-color: var(--chip-default-text);
  }
  .agent-pill.agent-history {
    background: var(--chip-purple-bg);
    color: var(--chip-purple-text);
    --agent-color: var(--chip-purple-text);
  }
  /* Working: comet-trail conic-gradient ring. The @property-animated
     `from` angle sweeps the bright arc smoothly around the pill's
     border outline — keeping the gradient ANGLE in motion (rather
     than rotating the pseudo) is what makes the sweep follow the pill
     shape uniformly on wide rectangles. Yes this repaints the pseudo
     every frame; .working is transient (only on while an agent turn
     is in flight) so the paint cost is bounded. Transform-rotating a
     static conic was tried and produced a visibly non-uniform sweep
     on the pill's wide aspect ratio. */
  @property --pill-sweep-angle {
    syntax: "<angle>";
    initial-value: 0deg;
    inherits: false;
  }
  .agent-pill.working::before {
    content: "";
    position: absolute;
    /* Extend 3px outside so the comet sweep hugs the pill's outer
       edge instead of sitting on top of the text. */
    inset: -3px;
    border-radius: calc(var(--radius-sm) + 3px);
    padding: 2px;
    background: conic-gradient(
      from var(--pill-sweep-angle),
      transparent 0deg,
      transparent 250deg,
      color-mix(in srgb, var(--agent-color) 0%, transparent) 270deg,
      color-mix(in srgb, var(--agent-color) 95%, transparent) 340deg,
      var(--agent-color) 360deg
    );
    -webkit-mask:
      linear-gradient(#fff 0 0) content-box,
      linear-gradient(#fff 0 0);
    mask:
      linear-gradient(#fff 0 0) content-box,
      linear-gradient(#fff 0 0);
    -webkit-mask-composite: xor;
    mask-composite: exclude;
    pointer-events: none;
    animation: pill-sweep 3.2s linear infinite;
  }
  @keyframes pill-sweep {
    to {
      --pill-sweep-angle: 360deg;
    }
  }
  /* Idle / waiting: a static border in a dim variant of the agent's
     colour. Previously this also rendered an opacity-pulsing overlay
     pseudo to draw the eye; killed because every visible idle pill
     was forcing its own compositor layer, and the constant layer-tree
     walk dominated Layerize cost in the perf trace. The zzz trail
     next to the agent name already says "idle" without the pulse. */
  .agent-pill.idle {
    border-color: color-mix(in srgb, var(--agent-color) 55%, transparent);
  }
  @media (prefers-reduced-motion: reduce) {
    .agent-pill.working::before {
      animation: none;
    }
    .stop-running-ring {
      animation: none;
    }
  }
  .star-slot {
    display: inline-flex;
    align-items: center;
    width: 16px;
    height: 16px;
    margin-left: 6px;
    margin-right: 0;
    flex: 0 0 auto;
  }
  .star-btn {
    flex: 0 0 auto;
    display: inline-flex;
    align-items: center;
    justify-content: center;
    background: none;
    border: none;
    padding: 0;
    cursor: pointer;
    color: var(--text-faint);
    transition: color 120ms ease;
    line-height: 1;
  }
  .star-btn:hover {
    color: var(--text-muted);
  }
  .star-btn.starred {
    color: #e8b931;
  }
  .star-btn.starred:hover {
    color: #c99e28;
  }
  .star-btn.jump {
    animation: star-jump 1.8s cubic-bezier(0.2, 0.6, 0.35, 1);
  }
  @keyframes star-jump {
    /* spin up */
    0% {
      transform: scale(1) rotate(0deg);
    }
    4% {
      transform: scale(1) rotate(180deg);
    }
    8% {
      transform: scale(1) rotate(540deg);
    }
    14% {
      transform: scale(1) rotate(1080deg);
    }
    /* pump — catching air */
    18% {
      transform: scale(1.9) rotate(1080deg);
    }
    22% {
      transform: scale(0.7) rotate(1080deg);
    }
    26% {
      transform: scale(2.2) rotate(1080deg);
    }
    30% {
      transform: scale(0.6) rotate(1080deg);
    }
    34% {
      transform: scale(2.5) rotate(1080deg);
    }
    38% {
      transform: scale(1) rotate(1080deg);
    }
    /* happy bounces */
    46% {
      transform: scale(1) translateY(0) rotate(1080deg);
    }
    52% {
      transform: scale(1.1) translateY(-10px) rotate(1080deg);
    }
    58% {
      transform: scale(1) translateY(0) rotate(1080deg);
    }
    66% {
      transform: scale(1.1) translateY(-7px) rotate(1080deg);
    }
    72% {
      transform: scale(1) translateY(0) rotate(1080deg);
    }
    80% {
      transform: scale(1.05) translateY(-4px) rotate(1080deg);
    }
    86% {
      transform: scale(1) translateY(0) rotate(1080deg);
    }
    93% {
      transform: scale(1.02) translateY(-2px) rotate(1080deg);
    }
    100% {
      transform: scale(1) translateY(0) rotate(1080deg);
    }
  }
  @media (prefers-reduced-motion: reduce) {
    .star-btn.jump {
      animation: none;
    }
  }
  /* Thin wrapper around <SleepIndicationAnimation>. The component owns
     its own layout reservation + animation; we only set the colour so
     the z-trail picks up the agent's brand colour via currentColor. */
  .sleep-slot {
    display: inline-block;
    margin-left: 0.2rem;
    color: var(--agent-color);
  }
  /* Compact horizontal "loading bar" representation of context usage.
     The track is a thin dark strip; the fill grows with `ratio`. The
     numeric label is hidden by default and slides in as a small
     adjacent caption on hover, so the resting state stays quiet in
     a busy header row. The full breakdown lives in the Tooltip popup
     that wraps this trigger. */
  /* Grid with two areas: the bar (track + fill stacked in the same
     cell via grid-area: bar) and the hover-revealed label. */
  .ctx-bar {
    display: inline-grid;
    grid-template-columns: 64px auto;
    grid-template-areas: "bar text";
    column-gap: 0.4rem;
    align-items: center;
    line-height: 1;
    /* `help` paints the OS "?" cursor — signals there's more info on
       hover (the Tooltip popup + the fade-in cap/% text). */
    cursor: help;
  }
  .ctx-bar > .ctx-bar-fill,
  .ctx-bar::before {
    height: 8px;
    border-radius: 999px;
    box-sizing: border-box;
  }
  /* `::before` is the empty track behind the fill. A 1px outline keeps
     the bar legible even when the fill is the same hue as the
     surrounding header background. */
  .ctx-bar::before {
    content: "";
    display: block;
    width: 64px;
    background: var(--surface-3);
    border: 1px solid var(--text-faint);
    grid-area: bar;
  }
  /* In warn/hot states the outline echoes the fill so the chip reads
     as one tinted unit instead of a neutral frame around a colored
     stripe. */
  .ctx-bar.warn::before {
    border-color: var(--ctx-warn);
  }
  .ctx-bar.hot::before {
    border-color: var(--ctx-hot);
  }
  .ctx-bar-fill {
    grid-area: bar;
    display: block;
    background: var(--text-faint);
    /* No own width — set inline via `style:width`. Transitions so a
       poll-cycle bump doesn't jitter the bar. */
    transition:
      width 200ms ease,
      background 200ms ease;
  }
  .ctx-bar.warn .ctx-bar-fill {
    background: var(--ctx-warn);
  }
  .ctx-bar.hot .ctx-bar-fill {
    background: var(--ctx-hot);
  }
  .ctx-bar.unknown .ctx-bar-fill {
    /* Striped indeterminate look when we don't know the cap, so the
       bar doesn't lie by showing a fixed fill level. */
    background: repeating-linear-gradient(
      45deg,
      var(--text-faint) 0 4px,
      transparent 4px 8px
    );
  }
  .ctx-bar-text {
    grid-area: text;
    font-variant-numeric: tabular-nums;
    white-space: nowrap;
    pointer-events: none;
    font-size: 0.68rem;
    /* Reserve the stacking context + padding at rest so the only thing
       that changes on hover is the background — that way the "now"
       text doesn't shift right by 4px when the cap-and-% slice fades
       in. Background stays transparent at rest so the chip blends
       into the header surface. */
    position: relative;
    z-index: 1;
    padding: 0 0.25rem;
    background: transparent;
    transition: background 120ms ease;
    /* The "now" span sits at full opacity; the "rest" span (cap + %)
       fades in on hover so the resting state is just the current size. */
  }
  /* Paint-over only on hover. Matches the header surface so the
     hover-expanded "/ 200k ctx (21%)" slice covers col-meta's "x of
     y messages" / last-activity text underneath when the inline-grid
     grows past col-name's allotted width. */
  .ctx-bar:hover .ctx-bar-text,
  .ctx-bar:focus-within .ctx-bar-text {
    background: var(--surface-2);
  }
  .ctx-bar-rest {
    opacity: 0;
    transition: opacity 120ms ease;
  }
  .ctx-bar:hover .ctx-bar-rest,
  .ctx-bar:focus-within .ctx-bar-rest {
    opacity: 1;
  }
  .ctx-bar.warn .ctx-bar-text {
    color: var(--ctx-warn);
  }
  .ctx-bar.hot .ctx-bar-text {
    color: var(--ctx-hot);
  }
  /* Tooltip body for the ctx-chip. `:global` because the slot content
     is rendered inside Tooltip.svelte's DOM — Svelte's per-file scope
     class would still attach, but DCE has historically been unreliable
     about slot-nested selectors, so go global to remove the doubt. */
  :global(.ctx-tt) {
    display: flex;
    flex-direction: column;
    gap: 0.5rem;
    font-size: 0.75rem;
    line-height: 1.4;
    color: var(--text-1);
    /* `max-content` lets the popup grow to its natural unwrapped width
       before the cap kicks in — otherwise a max-width by itself only
       caps shrink-to-fit, which can settle far below it for short
       content. The cap doubles the previous 42ch so long sentences
       wrap onto fewer rows. */
    width: max-content;
    max-width: min(84ch, 92vw);
  }
  :global(.ctx-tt-head) {
    font-weight: 600;
  }
  :global(.ctx-tt-kv) {
    display: grid;
    grid-template-columns: max-content 1fr;
    column-gap: 0.6rem;
    row-gap: 0.15rem;
    margin: 0;
  }
  :global(.ctx-tt-kv dt) {
    color: var(--text-muted);
  }
  :global(.ctx-tt-kv dd) {
    margin: 0;
    font-variant-numeric: tabular-nums;
  }
  :global(.ctx-tt-section-head) {
    color: var(--text-muted);
    font-weight: 500;
    margin-bottom: 0.2rem;
  }
  :global(.ctx-tt ul) {
    margin: 0;
    padding-left: 1.1rem;
  }
  :global(.ctx-tt li + li) {
    margin-top: 0.15rem;
  }
  :global(.ctx-tt code) {
    font-family: ui-monospace, monospace;
    font-size: 0.95em;
    background: var(--surface-3);
    padding: 0 0.2em;
    border-radius: 2px;
  }
  /* "Last activity" hover tooltip — just the user's last message, no
     extra meta. `:global()` because the slot content renders inside
     Tooltip.svelte's DOM so scoped selectors don't reach it. */
  :global(.la-tt-msg) {
    margin: 0;
    font-family: ui-monospace, monospace;
    font-size: 0.72rem;
    line-height: 1.4;
    color: var(--text-1);
    white-space: pre-wrap;
    word-break: break-word;
    max-width: min(72ch, 92vw);
    max-height: 40vh;
    overflow-y: auto;
  }
  .awaiting-pill {
    background: color-mix(in srgb, var(--status-dirty) 25%, transparent);
    color: var(--status-dirty);
    padding: 0.05rem 0.4rem;
    border-radius: var(--radius-sm);
    font-size: 0.68rem;
    text-transform: uppercase;
    letter-spacing: 0.05em;
    font-weight: 600;
    align-self: center;
    white-space: nowrap;
  }
  .inflight-pill {
    display: inline-flex;
    align-items: center;
    gap: 0.35rem;
    padding: 0.05rem 0.5rem;
    border-radius: var(--radius-sm);
    background: color-mix(in srgb, var(--brand) 18%, transparent);
    color: var(--text-1);
    border: 0;
    font-size: 0.68rem;
    line-height: 1;
    cursor: pointer;
  }
  .inflight-pill:hover {
    background: color-mix(in srgb, var(--brand) 28%, transparent);
  }
  .inflight-pill .spinner {
    width: 0.7rem;
    height: 0.7rem;
    border-radius: 50%;
    border: 2px solid color-mix(in srgb, var(--brand) 40%, transparent);
    border-top-color: var(--brand);
    animation: spin 0.8s linear infinite;
  }
  @keyframes spin {
    to {
      transform: rotate(360deg);
    }
  }
  .close {
    flex: 0 0 auto;
    align-self: center;
    display: inline-flex;
    align-items: center;
    justify-content: center;
    background: transparent;
    /* Transparent border at rest so the layout doesn't shift when the
       hover state's outline appears. */
    border: 1px solid transparent;
    border-radius: var(--radius-sm);
    color: var(--text-muted);
    padding: 0.1rem 0.5rem;
    font-size: 1rem;
    line-height: 1;
    cursor: pointer;
  }
  .close:hover {
    color: var(--text-1);
    background: var(--surface-3);
    border-color: var(--text-faint);
  }
  .close:focus-visible {
    outline: none;
    border-color: var(--brand);
  }
</style>
