<script lang="ts">
  import { onDestroy } from "svelte";
  import { marked } from "marked";
  import DOMPurify from "dompurify";
  import { apiUrl } from "./api";
  import LoadingSpinner from "./LoadingSpinner.svelte";
  import ToolIcon from "./ToolIcon.svelte";
  import {
    buildVisualWorkDisplayEntries,
    cleanVisualToolResultText,
    cleanVisualUserText,
    formatVisualWorkDuration,
    getVisualTranscriptItemKey,
    getVisualWorkDisplayEntryKey,
    visualFileEditSummaryForBlock,
    visualPlanFromBlock,
    visualThinkingSummary,
    visualToolCallPayloadLanguage,
    visualToolCallPayloadText,
    visualToolPreviewText,
    visualUserImageAttachments,
    type VisualFileEditSummary,
    type VisualPlanItem,
    type VisualMarkerKind,
    type VisualTranscriptItem,
    type VisualWorkEntry,
  } from "./last-user-message";
  import { markdownCodeBlockHtml } from "./markdown-code";

  type Agent = "claude" | "codex" | "copilot" | "ollama";

  interface NormalizedBlock {
    type:
      | "text"
      | "thinking"
      | "plan"
      | "tool_use"
      | "tool_result"
      | "media"
      | "ide_context"
      | "system_reminder"
      | "command"
      | "marker";
    text?: string;
    toolName?: string;
    toolInput?: unknown;
    toolUseId?: string;
    explanation?: string;
    planItems?: VisualPlanItem[];
    tagName?: string;
    mediaKind?: "image" | "file" | "artifact";
    mimeType?: string;
    path?: string;
    url?: string;
    title?: string;
    alt?: string;
    hasAlpha?: boolean;
  }

  interface NormalizedMessage {
    role: "user" | "assistant" | "system" | "tool";
    blocks: NormalizedBlock[];
    timestamp?: string;
    id?: string;
    intent?: "steer";
    author?: string;
  }

  marked.setOptions({ breaks: true, gfm: true });
  marked.use({
    tokenizer: {
      lheading() {
        return undefined;
      },
    },
    renderer: {
      link(token: { href: string; title?: string | null; text: string }) {
        const href = token.href ?? "";
        const title = token.title ? ` title="${escapeAttr(token.title)}"` : "";
        return `<a href="${escapeAttr(href)}"${title} target="_blank" rel="noopener noreferrer">${token.text}</a>`;
      },
      code(token: { text?: string; lang?: string | null }) {
        return markdownCodeBlockHtml(token.text ?? "", token.lang);
      },
    },
  });

  export let agent: Agent = "claude";
  export let daemonId: string | undefined = undefined;
  export let items: VisualTranscriptItem<
    NormalizedBlock,
    NormalizedMessage
  >[] = [];
  export let transcriptSurface: "read" | "terminal" = "read";
  export let ollamaStreamingIdx: number | null = null;
  export let active = false;
  export let messagesEl: HTMLElement | null = null;
  export let onMessagesEnter: () => void = () => {};
  export let onMessagesLeave: () => void = () => {};
  export let onMessagesWheel: (e: WheelEvent) => void = () => {};
  export let onMessagesScroll: () => void = () => {};
  export let showLiveThinkingLine = false;
  export let messageMotionSources: Map<string, ComposerMotionRect> = new Map();
  export let onMessageMotionDone: (id: string) => void = () => {};

  let liveNowIso = new Date().toISOString();
  let liveClock: ReturnType<typeof setInterval> | null = null;
  let openMediaBlocks: NormalizedBlock[] = [];
  let openMediaIndex = -1;
  let expandedThinkingWorkKeys = new Set<string>();
  const MARKDOWN_CACHE_LIMIT = 500;
  const markdownCache = new Map<string, string>();

  interface ComposerMotionRect {
    x: number;
    y: number;
    width: number;
    height: number;
  }

  $: openMediaBlock =
    openMediaIndex >= 0 ? openMediaBlocks[openMediaIndex] : undefined;
  $: openMediaSrc = openMediaBlock ? mediaSourceUrl(openMediaBlock) : undefined;
  $: hasOpenWork = items.some((item) => item.kind === "work" && item.open);
  $: shouldRunLiveClock = active || hasOpenWork || showLiveThinkingLine;
  $: liveThinkingAttachedToWork = items.some(
    (item, index) => isLiveTailWork(item, index),
  );
  $: {
    const liveKeys = new Set(
      items
        .map((item, index) =>
          item.kind === "work" && item.open && !item.endedAt
            ? getVisualTranscriptItemKey(item, index)
            : undefined,
        )
        .filter((key): key is string => !!key),
    );
    const next = new Set(
      [...expandedThinkingWorkKeys].filter((key) => liveKeys.has(key)),
    );
    if (next.size !== expandedThinkingWorkKeys.size) {
      expandedThinkingWorkKeys = next;
    }
  }

  $: {
    if (shouldRunLiveClock && !liveClock) {
      liveNowIso = new Date().toISOString();
      liveClock = setInterval(() => {
        liveNowIso = new Date().toISOString();
      }, 1000);
    } else if (!shouldRunLiveClock && liveClock) {
      clearInterval(liveClock);
      liveClock = null;
    }
  }

  onDestroy(() => {
    if (liveClock) clearInterval(liveClock);
  });

  function escapeAttr(s: string): string {
    return s
      .replace(/&/g, "&amp;")
      .replace(/"/g, "&quot;")
      .replace(/</g, "&lt;")
      .replace(/>/g, "&gt;");
  }

  function md(text: string | undefined): string {
    if (!text) return "";
    const cacheKey = `${daemonId ?? ""}\u0000${text}`;
    const cached = markdownCache.get(cacheKey);
    if (cached !== undefined) return cached;
    const processed = text.replace(
      /\[Image:\s*source:\s*([^\]]+?\.(?:png|jpe?g|gif|webp|svg|bmp))\s*\]/gi,
      (_match, filePath) => {
        const url = apiUrl(
          `/api/image?path=${encodeURIComponent(filePath.trim())}`,
          daemonId,
        );
        return `![pasted image](${url})`;
      },
    );
    const html = DOMPurify.sanitize(
      marked.parse(processed, { async: false }) as string,
    );
    markdownCache.set(cacheKey, html);
    if (markdownCache.size > MARKDOWN_CACHE_LIMIT) {
      const first = markdownCache.keys().next().value;
      if (first !== undefined) markdownCache.delete(first);
    }
    return html;
  }

  function portal(node: HTMLElement): { destroy: () => void } {
    document.body.appendChild(node);
    return {
      destroy() {
        if (node.parentNode) node.parentNode.removeChild(node);
      },
    };
  }

  function isImageMediaBlock(block: NormalizedBlock): boolean {
    return block.type === "media" && block.mediaKind === "image";
  }

  function imageMediaBlocks(blocks: NormalizedBlock[]): NormalizedBlock[] {
    return blocks.filter(
      (block) => isImageMediaBlock(block) && !!mediaSourceUrl(block),
    );
  }

  function openMediaViewer(blocks: NormalizedBlock[], index: number): void {
    openMediaBlocks = blocks;
    openMediaIndex = index;
  }

  function closeMediaViewer(): void {
    openMediaBlocks = [];
    openMediaIndex = -1;
  }

  function openMediaByStep(step: number): void {
    if (openMediaBlocks.length === 0) return;
    openMediaIndex =
      (openMediaIndex + step + openMediaBlocks.length) % openMediaBlocks.length;
  }

  function onMediaModalKeydown(event: KeyboardEvent): void {
    if (event.key === "Escape") {
      event.preventDefault();
      closeMediaViewer();
    } else if (event.key === "ArrowLeft") {
      event.preventDefault();
      openMediaByStep(-1);
    } else if (event.key === "ArrowRight") {
      event.preventDefault();
      openMediaByStep(1);
    }
  }

  async function copyToClipboard(text: string) {
    try {
      await navigator.clipboard.writeText(text);
    } catch {
      // Clipboard permissions are best-effort in browser contexts.
    }
  }

  function handleMarkdownCodeCopy(e: MouseEvent): void {
    const target = e.target as HTMLElement | null;
    const button = target?.closest<HTMLButtonElement>(".md-code-copy");
    if (!button) return;
    const frame = button.closest(".md-code-frame");
    const code = frame?.querySelector("pre code")?.textContent ?? "";
    if (!code) return;
    void copyToClipboard(code);
  }

  function codeCopy(node: HTMLElement): { destroy: () => void } {
    node.addEventListener("click", handleMarkdownCodeCopy);
    return {
      destroy() {
        node.removeEventListener("click", handleMarkdownCodeCopy);
      },
    };
  }

  function handOffNestedWheel(e: WheelEvent): void {
    if (Math.abs(e.deltaX) <= Math.abs(e.deltaY)) return;
    const strip = (e.currentTarget as HTMLElement | null)?.closest(
      ".sessions-strip",
    ) as HTMLElement | null;
    if (!strip) return;
    e.preventDefault();
    e.stopPropagation();
    strip.scrollLeft += e.deltaX;
  }

  function prefersReducedMotion(): boolean {
    return (
      typeof window !== "undefined" &&
      window.matchMedia("(prefers-reduced-motion: reduce)").matches
    );
  }

  function motionSourceForMessage(
    message: NormalizedMessage,
  ): ComposerMotionRect | undefined {
    if (message.role !== "user" || !message.id) return undefined;
    return messageMotionSources.get(message.id);
  }

  function flyActualMessageFromComposer(
    node: HTMLElement,
    params: { id?: string; source?: ComposerMotionRect },
  ) {
    let cancelled = false;

    function run(id: string | undefined, source: ComposerMotionRect | undefined) {
      if (!id || !source || prefersReducedMotion()) return;
      requestAnimationFrame(() => {
        if (cancelled) return;
        const target = node.getBoundingClientRect();
        if (target.width <= 0 || target.height <= 0) {
          onMessageMotionDone(id);
          return;
        }
        const dx = source.x - target.left;
        const dy = source.y - target.top;
        const sx = Math.max(0.16, Math.min(2.4, source.width / target.width));
        const sy = Math.max(0.28, Math.min(2.2, source.height / target.height));
        node.style.transformOrigin = "top left";
        node.style.willChange = "transform, opacity, filter";
        node
          .animate(
            [
              {
                opacity: 0.72,
                transform: `translate3d(${dx}px, ${dy}px, 0) scale(${sx}, ${sy})`,
                filter: "blur(0.2px)",
              },
              {
                opacity: 1,
                transform: "translate3d(0, 0, 0) scale(1, 1)",
                filter: "blur(0)",
              },
            ],
            {
              duration: 430,
              easing: "cubic-bezier(.16, 1, .3, 1)",
              fill: "both",
            },
          )
          .finished.catch(() => {})
          .finally(() => {
            node.style.transformOrigin = "";
            node.style.willChange = "";
            onMessageMotionDone(id);
          });
      });
    }

    run(params.id, params.source);

    return {
      update() {
        // This action is intentionally mount-only. New sends get new message ids,
        // and re-running on ordinary reactive updates would make bubbles jump.
      },
      destroy() {
        cancelled = true;
        if (params.id && params.source) onMessageMotionDone(params.id);
      },
    };
  }

  function inputPreview(input: unknown): string {
    if (input === undefined) return "";
    let s: string;
    if (typeof input === "string") s = input;
    else {
      try {
        s = JSON.stringify(input);
      } catch {
        s = String(input);
      }
    }
    s = s.replace(/\s+/g, " ").trim();
    return s.length > 200 ? s.slice(0, 200) + "…" : s;
  }

  function workDurationLabel(
    item: Extract<
      VisualTranscriptItem<NormalizedBlock, NormalizedMessage>,
      { kind: "work" }
    >,
    nowIso: string,
  ): string | undefined {
    const running = item.open && !item.endedAt;
    const duration = formatVisualWorkDuration(
      item.startedAt,
      running ? nowIso : item.endedAt,
    );
    const prefix = running ? "Working" : "Worked";
    return duration ? `${prefix} for ${duration}` : prefix;
  }

  function formatToolWallTime(seconds: number | undefined): string | undefined {
    if (seconds === undefined || !Number.isFinite(seconds)) return undefined;
    if (seconds <= 0) return undefined;
    if (seconds < 1) return `${Math.max(1, Math.round(seconds * 1000))}ms`;
    if (seconds < 10) return `${seconds.toFixed(1)}s`;
    return `${Math.round(seconds)}s`;
  }

  function visualTextForBlock(
    text: string | undefined,
    role: string,
  ): string {
    return role === "user" ? cleanVisualUserText(text) : (text ?? "");
  }

  function isSteeredUserMessage(message: NormalizedMessage): boolean {
    return (
      message.role === "user" &&
      (message.intent === "steer" ||
        message.id === "codex-optimistic-user-steer" ||
        !!message.id?.startsWith("codex-optimistic-user-steer-"))
    );
  }

  function displayBlocksForMessage(
    blocks: NormalizedBlock[],
    role: string,
  ): NormalizedBlock[] {
    if (role !== "user") return blocks;
    const mediaBlocks = blocks.filter((block) => block.type === "media");
    const bodyBlocks = blocks
      .filter((block) => block.type !== "media")
      .flatMap((block): NormalizedBlock[] => {
        if (block.type !== "text") return [block];
        const attachments = visualUserImageAttachments(block.text).map(
          (attachment): NormalizedBlock => ({
            type: "media",
            mediaKind: "image",
            path: attachment.path,
            title: attachment.label,
            alt: attachment.label,
          }),
        );
        const text = cleanVisualUserText(block.text);
        return [...attachments, ...(text ? [{ ...block, text }] : [])];
      });
    return [...mediaBlocks, ...bodyBlocks];
  }

  function workEntryBlocksText(blocks: NormalizedBlock[]): string {
    return blocks
      .map((block) =>
        block.type === "tool_use"
          ? `${block.toolName ?? "tool"} ${inputPreview(block.toolInput)}`
          : block.type === "tool_result"
            ? cleanVisualToolResultText(block.text).body
            : (block.text ?? ""),
      )
      .join(" ")
      .replace(/\s+/g, " ")
      .trim();
  }

  function isPlainAssistantWorkText(
    entry: VisualWorkEntry<NormalizedBlock, NormalizedMessage>,
  ): boolean {
    return (
      entry.message.role === "assistant" &&
      entry.blocks.length > 0 &&
      entry.blocks.every((block) => block.type === "text")
    );
  }

  function roleLabel(role: string, author?: string): string {
    if (role !== "assistant") return role;
    if (author) return author;
    if (agent === "claude") return "Claude";
    if (agent === "codex") return "Codex";
    if (agent === "copilot") return "Copilot";
    if (agent === "ollama") return "Ollama";
    return "assistant";
  }

  function workEntryTitle(
    entry: VisualWorkEntry<NormalizedBlock, NormalizedMessage>,
  ): string {
    const first = entry.blocks[0];
    if (!first) return roleLabel(entry.message.role, entry.message.author);
    if (first.type === "thinking") {
      const thought = thinkingDisplay(first.text);
      return thought.title || thought.body || "Thinking";
    }
    if (first.type === "plan") return planTitle(first);
    if (first.type === "tool_use") return first.toolName || "Tool call";
    if (first.type === "tool_result") {
      const cleaned = cleanVisualToolResultText(first.text);
      return first.toolName ?? cleaned.title;
    }
    if (first.type === "media") return mediaLabel(first);
    if (first.type === "ide_context") return first.tagName ?? "IDE context";
    if (first.type === "system_reminder") return "System reminder";
    if (first.type === "command") return first.tagName ?? "Command";
    const preview = workEntryBlocksText(entry.blocks);
    return preview || roleLabel(entry.message.role, entry.message.author);
  }

  function thinkingDisplay(text: string | undefined): {
    title: string;
    body: string;
  } {
    return visualThinkingSummary(text);
  }

  function planTitle(block: NormalizedBlock): string {
    const plan = visualPlanFromBlock(block);
    if (!plan) return "Todo";
    return `Todo ${plan.completed}/${plan.total}`;
  }

  function planPreview(block: NormalizedBlock): string {
    const plan = visualPlanFromBlock(block);
    if (!plan) return "";
    const active = plan.items.find((item) => item.status === "in_progress");
    return active?.step ?? plan.explanation ?? plan.items[0]?.step ?? "";
  }

  function planStatusIcon(status: string): string {
    if (status === "completed") return "✓";
    if (status === "in_progress") return "•";
    return "○";
  }

  function firstCollapsedLine(text: string | undefined): string {
    return (text ?? "")
      .split("\n")
      .map((line) => line.trim())
      .find(Boolean) ?? "";
  }

  function workEntryCollapsedPreview(
    entry: VisualWorkEntry<NormalizedBlock, NormalizedMessage>,
  ): string {
    const first = entry.blocks[0];
    if (!first) return "";
    if (first.type === "thinking") {
      const thought = thinkingDisplay(first.text);
      return thought.title || firstCollapsedLine(thought.body);
    }
    if (first.type === "tool_result") {
      return firstCollapsedLine(cleanVisualToolResultText(first.text).body);
    }
    if (first.type === "plan") return planPreview(first);
    if (first.type === "tool_use") return workEntryToolPreview(first);
    if (first.type === "media") return mediaLabel(first);
    return firstCollapsedLine(workEntryBlocksText(entry.blocks));
  }

  function workEntryToolUseBlock(
    entry: VisualWorkEntry<NormalizedBlock, NormalizedMessage>,
  ): NormalizedBlock | undefined {
    return entry.blocks.find((block) => block.type === "tool_use");
  }

  function workEntryFileEditSummary(
    entry: VisualWorkEntry<NormalizedBlock, NormalizedMessage>,
  ): VisualFileEditSummary | undefined {
    return visualFileEditSummaryForBlock(workEntryToolUseBlock(entry));
  }

  function fileEditBasename(path: string): string {
    return path.split(/[\\/]/).filter(Boolean).at(-1) ?? path;
  }

  function fileEditActionLabel(action: string): string {
    if (action === "added") return "Added";
    if (action === "deleted") return "Deleted";
    return "Edited";
  }

  function workEntryToolPreview(block: NormalizedBlock): string {
    const text = visualToolPreviewText(block) || inputPreview(block.toolInput);
    return text.replace(/\s+/g, " ").trim();
  }

  function toolUsesInlineCommandLabel(block: NormalizedBlock): boolean {
    if (!workEntryToolPreview(block)) return false;
    const name = (block.toolName ?? "").toLowerCase();
    return (
      name.includes("bash") || name.includes("shell") || name.includes("exec")
    );
  }

  function workEntryToolResult(
    entry: VisualWorkEntry<NormalizedBlock, NormalizedMessage> | undefined,
  ): ReturnType<typeof cleanVisualToolResultText> | undefined {
    const block = entry?.blocks.find((b) => b.type === "tool_result");
    if (!block) return undefined;
    return cleanVisualToolResultText(block.text);
  }

  function workEntryToolResultBlock(
    entry: VisualWorkEntry<NormalizedBlock, NormalizedMessage> | undefined,
  ): NormalizedBlock | undefined {
    return entry?.blocks.find((b) => b.type === "tool_result");
  }

  function toolResultLabel(
    result: ReturnType<typeof cleanVisualToolResultText>,
    toolName?: string,
  ): string {
    const parts = [toolName ? `${toolName} result` : result.title];
    const duration = formatToolWallTime(result.wallTimeSeconds);
    if (duration) parts.push(duration);
    return parts.join(" · ");
  }

  function toolResultMeta(
    entry: VisualWorkEntry<NormalizedBlock, NormalizedMessage> | undefined,
  ): string {
    const result = workEntryToolResult(entry);
    if (!result?.wrappedCodexChunk) return "";
    const parts: string[] = [];
    const duration = formatToolWallTime(result.wallTimeSeconds);
    if (duration) parts.push(duration);
    if (!result.body) parts.push("no output");
    return parts.join(" · ");
  }

  function workMarkerIcon(kind: VisualMarkerKind | undefined): string {
    if (kind === "complete") return "✓";
    if (kind === "compacted") return "⇥";
    if (kind === "aborted") return "!";
    return "•";
  }

  function mediaSourceUrl(block: NormalizedBlock): string | undefined {
    if (block.path && block.mediaKind === "image") {
      return apiUrl(
        `/api/image?path=${encodeURIComponent(block.path)}`,
        daemonId,
      );
    }
    return block.url;
  }

  function mediaLabel(block: NormalizedBlock): string {
    return (
      block.title ??
      block.alt ??
      block.path?.split("/").pop() ??
      block.url ??
      block.mimeType ??
      "Artifact"
    );
  }

  function relTimeFromIso(iso: string): string {
    const s = Math.floor((Date.now() - Date.parse(iso)) / 1000);
    if (!Number.isFinite(s)) return "";
    if (s < 60) return "just now";
    if (s < 3600) return `${Math.floor(s / 60)}m`;
    if (s < 86400) return `${Math.floor(s / 3600)}h`;
    if (s < 172800) return "yesterday";
    return `${Math.floor(s / 86400)}d`;
  }

  function isLiveTailWork(
    item: VisualTranscriptItem<NormalizedBlock, NormalizedMessage>,
    index: number,
  ): boolean {
    return (
      showLiveThinkingLine &&
      index === items.length - 1 &&
      item.kind === "work" &&
      item.open === true &&
      !item.endedAt
    );
  }

  function isThinkingWorkEntry(
    entry: VisualWorkEntry<NormalizedBlock, NormalizedMessage>,
  ): boolean {
    return entry.blocks.some((block) => block.type === "thinking");
  }

  function forceOpenThinkingEntry(
    workKey: string,
    entry: VisualWorkEntry<NormalizedBlock, NormalizedMessage>,
  ): boolean {
    return isThinkingWorkEntry(entry) && expandedThinkingWorkKeys.has(workKey);
  }

  function onWorkEntryToggle(
    event: Event,
    item: Extract<
      VisualTranscriptItem<NormalizedBlock, NormalizedMessage>,
      { kind: "work" }
    >,
    workKey: string,
    entry: VisualWorkEntry<NormalizedBlock, NormalizedMessage>,
  ): void {
    const details = event.currentTarget as HTMLDetailsElement | null;
    if (
      !details?.open ||
      !item.open ||
      item.endedAt ||
      !isThinkingWorkEntry(entry)
    ) {
      return;
    }
    if (expandedThinkingWorkKeys.has(workKey)) return;
    expandedThinkingWorkKeys = new Set([...expandedThinkingWorkKeys, workKey]);
  }

  function visualBlockRenderKey(block: NormalizedBlock, index: number): string {
    return [
      index,
      block.type,
      block.toolUseId ?? "",
      block.toolName ?? "",
      block.path ?? block.url ?? "",
      block.mediaKind ?? "",
    ].join(":");
  }
</script>

{#snippet renderThinkingIcon()}
  <svg
    class="thinking-icon"
    viewBox="0 0 24 24"
    fill="none"
    stroke="currentColor"
    stroke-width="1.8"
    stroke-linecap="round"
    stroke-linejoin="round"
    aria-hidden="true"
  >
    <path
      d="M9.5 2.75a3.25 3.25 0 0 0-3.18 3.93A3.5 3.5 0 0 0 5 13.42a3.2 3.2 0 0 0 .94 5.53A3.35 3.35 0 0 0 12 17V6a3.25 3.25 0 0 0-2.5-3.25Z"
    />
    <path
      d="M14.5 2.75a3.25 3.25 0 0 1 3.18 3.93A3.5 3.5 0 0 1 19 13.42a3.2 3.2 0 0 1-.94 5.53A3.35 3.35 0 0 1 12 17V6a3.25 3.25 0 0 1 2.5-3.25Z"
    />
    <path d="M8.25 8.25H12" />
    <path d="M15.75 8.25H12" />
    <path d="M7.75 13.25H12" />
    <path d="M16.25 13.25H12" />
  </svg>
{/snippet}

{#snippet renderLiveThinkingLine()}
  <div class="live-thinking-line" aria-live="polite">
    {@render renderThinkingIcon()}
    <span>Thinking</span>
    {@render renderLiveDots()}
  </div>
{/snippet}

{#snippet renderLiveDots()}
  <span class="live-thinking-dots" aria-hidden="true">
    <span>.</span><span>.</span><span>.</span>
  </span>
{/snippet}

{#snippet renderImageAttachmentFrame(
  src: string,
  label: string,
  hasAlpha: boolean,
  extraClass: string,
)}
  <span
    class={`sticky-photo-frame ${extraClass}`.trim()}
    class:sticky-photo-frame-transparent={hasAlpha}
    title={label}
  >
    <img src={src} alt={label} draggable="false" />
  </span>
{/snippet}

{#snippet renderMessageBlocks(
  blocks: NormalizedBlock[],
  m: NormalizedMessage,
  messageIndex: number,
)}
  {@const userImageBlocks = m.role === "user" ? imageMediaBlocks(blocks) : []}
  {#if userImageBlocks.length > 0}
    <div class="block media-strip user-media-strip">
      {#each userImageBlocks as imageBlock, imageIndex (`${imageBlock.path ?? imageBlock.url ?? "image"}:${imageIndex}`)}
        {@const src = mediaSourceUrl(imageBlock)}
        {#if src}
          <button
            type="button"
            class="media-image-open"
            title={`Open ${mediaLabel(imageBlock)}`}
            aria-label={`Open ${mediaLabel(imageBlock)}`}
            on:click={() => openMediaViewer(userImageBlocks, imageIndex)}
          >
            {@render renderImageAttachmentFrame(
              src,
              imageBlock.alt ?? mediaLabel(imageBlock),
              !!imageBlock.hasAlpha,
              "composer-photo-frame media-photo-frame",
            )}
          </button>
        {/if}
      {/each}
    </div>
  {/if}
  {#each blocks as b, blockIndex (visualBlockRenderKey(b, blockIndex))}
    {#if m.role === "user" && isImageMediaBlock(b) && mediaSourceUrl(b)}
      <!-- Rendered once in the horizontal image strip above. -->
    {:else if b.type === "text"}
      {@const displayText = visualTextForBlock(b.text, m.role)}
      {#if messageIndex === ollamaStreamingIdx && !(b.text ?? "").length}
        <div class="block text md ollama-waiting">
          <LoadingSpinner size="0.9rem" label="Waiting for response" />
        </div>
      {:else if displayText}
        <div class="block text md">{@html md(displayText)}</div>
      {/if}
    {:else if b.type === "thinking"}
      {@const thought = thinkingDisplay(b.text)}
      <div class="block thinking">
        {@render renderThinkingIcon()}
        <div class="thinking-copy">
          {#if thought.title}
            <div class="thinking-title">{thought.title}</div>
          {/if}
          {#if thought.body}
            <div class="tag-body md">{@html md(thought.body)}</div>
          {/if}
        </div>
      </div>
    {:else if b.type === "plan"}
      {@const plan = visualPlanFromBlock(b)}
      {#if plan}
        <div class="block plan-block">
          <div class="plan-title">{planTitle(b)}</div>
          {#if plan.explanation}
            <div class="plan-explanation">{plan.explanation}</div>
          {/if}
          <div class="plan-items">
            {#each plan.items as item, i (`${item.status}:${item.step}:${i}`)}
              <div class="plan-item" class:active={item.status === "in_progress"}>
                <span class="plan-status">{planStatusIcon(item.status)}</span>
                <span>{item.step}</span>
              </div>
            {/each}
          </div>
        </div>
      {/if}
    {:else if b.type === "tool_use"}
      <div class="block tool-use">
        <ToolIcon name={b.toolName} />
        <span class="tool-name">{b.toolName ?? "tool"}</span>
        <code class="tool-input" title={inputPreview(b.toolInput)}>
          {inputPreview(b.toolInput)}
        </code>
      </div>
    {:else if b.type === "tool_result"}
      {@const cleaned = cleanVisualToolResultText(b.text)}
      {#if cleaned.body || cleaned.wrappedCodexChunk}
        <div class="block tool-result md" class:tool-result-empty={!cleaned.body}>
          <span class="muted small">{toolResultLabel(cleaned, b.toolName)}</span>
          {#if cleaned.body}
            {@html markdownCodeBlockHtml(cleaned.body, "text")}
          {:else}
            <span class="tool-result-empty-text">no output</span>
          {/if}
        </div>
      {/if}
    {:else if b.type === "media"}
      {@const src = mediaSourceUrl(b)}
      <figure
        class="block media-block"
        class:media-image={b.mediaKind === "image"}
      >
        {#if b.mediaKind === "image" && src}
          <button
            type="button"
            class="media-image-open"
            title={`Open ${mediaLabel(b)}`}
            aria-label={`Open ${mediaLabel(b)}`}
            on:click={() => openMediaViewer([b], 0)}
          >
            {@render renderImageAttachmentFrame(
              src,
              b.alt ?? mediaLabel(b),
              !!b.hasAlpha,
              m.role === "user"
                ? "composer-photo-frame media-photo-frame"
                : "media-photo-frame",
            )}
          </button>
          <figcaption>{mediaLabel(b)}</figcaption>
        {:else}
          <div class="media-artifact">
            <span class="tag-label">{b.mediaKind ?? "artifact"}</span>
            {#if src}
              <a href={src} target="_blank" rel="noopener noreferrer">
                {mediaLabel(b)}
              </a>
            {:else}
              <span>{mediaLabel(b)}</span>
            {/if}
            {#if b.mimeType}
              <span class="muted small">{b.mimeType}</span>
            {/if}
          </div>
          {#if b.text}
            <div class="media-note">{b.text}</div>
          {/if}
        {/if}
      </figure>
    {:else if b.type === "ide_context"}
      <div class="block ide-context" title={b.tagName}>
        <span class="tag-label">IDE · {b.tagName ?? "context"}</span>
        <span class="tag-body">{b.text}</span>
      </div>
    {:else if b.type === "system_reminder"}
      <div class="block sys-reminder" title={b.tagName}>
        <span class="tag-label">system reminder</span>
        <span class="tag-body">{b.text}</span>
      </div>
    {:else if b.type === "command"}
      <div class="block command" title={b.tagName}>
        <span class="tag-label">{b.tagName ?? "command"}</span>
        <span class="tag-body">{b.text}</span>
      </div>
    {:else if b.type === "marker"}
      <div class="block marker">{b.text}</div>
    {/if}
  {/each}
{/snippet}

{#snippet renderFileEditSummary(summary: VisualFileEditSummary)}
  <div class="work-file-edits">
    <div class="work-file-edits-title">
      <span class="work-file-edits-icon" aria-hidden="true">✎</span>
      <span>{summary.title}</span>
    </div>
    <div class="work-file-edit-list">
      {#each summary.files as file}
        {#if file.raw}
          <details class="work-file-edit-detail">
            <summary class="work-file-edit-row">
              <span class="work-file-action">{fileEditActionLabel(file.action)}</span>
              <span class="work-file-path" title={file.path}>
                {fileEditBasename(file.path)}
              </span>
              {#if file.additions !== undefined}
                <span class="work-file-add">+{file.additions}</span>
              {/if}
              {#if file.deletions !== undefined}
                <span class="work-file-del">-{file.deletions}</span>
              {/if}
            </summary>
            <div class="md work-file-raw">
              {@html markdownCodeBlockHtml(file.raw, "diff")}
            </div>
          </details>
        {:else}
          <div class="work-file-edit-row">
            <span class="work-file-action">{fileEditActionLabel(file.action)}</span>
            <span class="work-file-path" title={file.path}>
              {fileEditBasename(file.path)}
            </span>
            {#if file.additions !== undefined}
              <span class="work-file-add">+{file.additions}</span>
            {/if}
            {#if file.deletions !== undefined}
              <span class="work-file-del">-{file.deletions}</span>
            {/if}
          </div>
        {/if}
      {/each}
    </div>
  </div>
{/snippet}

{#snippet renderWorkEntryBlocks(blocks: NormalizedBlock[])}
  {#each blocks as b, blockIndex (visualBlockRenderKey(b, blockIndex))}
    {#if b.type === "text"}
      {#if b.text}
        <div class="work-step-text md">{@html md(b.text)}</div>
      {/if}
    {:else if b.type === "thinking"}
      {@const thought = thinkingDisplay(b.text)}
      <div class="work-step-detail">
        {@render renderThinkingIcon()}
        <div class="thinking-copy">
          {#if thought.title}
            <div class="thinking-title">{thought.title}</div>
          {/if}
          {#if thought.body}
            <div class="tag-body md">{@html md(thought.body)}</div>
          {/if}
        </div>
      </div>
    {:else if b.type === "plan"}
      {@const plan = visualPlanFromBlock(b)}
      {#if plan}
        <div class="work-step-detail work-plan-detail">
          <span class="tag-label">{planTitle(b)}</span>
          <div class="plan-items">
            {#each plan.items as item, i (`${item.status}:${item.step}:${i}`)}
              <div class="plan-item" class:active={item.status === "in_progress"}>
                <span class="plan-status">{planStatusIcon(item.status)}</span>
                <span>{item.step}</span>
              </div>
            {/each}
          </div>
        </div>
      {/if}
    {:else if b.type === "tool_use"}
      {@const inputCode = visualToolCallPayloadText(b)}
      {#if inputCode}
        <div class="md work-tool-code">
          <div class="work-tool-output-label">
            {b.toolName ?? "tool"} input
          </div>
          {@html markdownCodeBlockHtml(
            inputCode,
            visualToolCallPayloadLanguage(b),
          )}
        </div>
      {:else}
        <div class="work-tool-empty-text">
          {b.toolName ?? "tool"} input: no payload
        </div>
      {/if}
    {:else if b.type === "tool_result"}
      {@const cleaned = cleanVisualToolResultText(b.text)}
      {#if cleaned.body || cleaned.wrappedCodexChunk}
        <div class="md work-tool-output" class:work-tool-output-empty={!cleaned.body}>
          <div class="work-tool-output-label">
            {toolResultLabel(cleaned, b.toolName)}
          </div>
          {#if cleaned.body}
            {@html markdownCodeBlockHtml(cleaned.body, "text")}
          {:else}
            <span class="work-tool-empty-text">no output</span>
          {/if}
        </div>
      {/if}
    {:else if b.type === "media"}
      {@const src = mediaSourceUrl(b)}
      <div class="work-step-detail">
        <span class="tag-label">{b.mediaKind ?? "artifact"}</span>
        {#if src}
          <a href={src} target="_blank" rel="noopener noreferrer">
            {mediaLabel(b)}
          </a>
        {:else}
          <span>{mediaLabel(b)}</span>
        {/if}
      </div>
    {:else if b.type === "ide_context"}
      <div class="work-step-detail">
        <span class="tag-label">IDE · {b.tagName ?? "context"}</span>
        <span class="tag-body">{b.text}</span>
      </div>
    {:else if b.type === "system_reminder"}
      <div class="work-step-detail">
        <span class="tag-label">system reminder</span>
        <span class="tag-body">{b.text}</span>
      </div>
    {:else if b.type === "command"}
      <div class="work-step-detail">
        <span class="tag-label">{b.tagName ?? "command"}</span>
        <span class="tag-body">{b.text}</span>
      </div>
    {:else if b.type === "marker"}
      <div class="work-step-detail">{b.text}</div>
    {/if}
  {/each}
{/snippet}

<ul
  class="messages"
  class:terminal-transcript={transcriptSurface === "terminal"}
  bind:this={messagesEl}
  on:mouseenter={onMessagesEnter}
  on:mouseleave={onMessagesLeave}
  on:wheel={onMessagesWheel}
  on:scroll={onMessagesScroll}
  use:codeCopy
>
  {#each items as item, itemIndex (getVisualTranscriptItemKey(item, itemIndex))}
    {#if item.kind === "work"}
      {@const workKey = getVisualTranscriptItemKey(item, itemIndex)}
      <li class="work-row">
        <details
          class="work-foldout"
          class:work-foldout-live={item.open && !item.endedAt}
          open={item.open}
        >
          <summary>
            <span>{workDurationLabel(item, liveNowIso)}</span>
            {#if item.open && !item.endedAt}
              {@render renderLiveDots()}
            {/if}
            <span class="work-count">
              {item.entries.length}
              {item.entries.length === 1 ? "step" : "steps"}
            </span>
          </summary>
          <div class="work-foldout-body" on:wheel|capture={handOffNestedWheel}>
            {#each buildVisualWorkDisplayEntries(item.entries) as displayEntry (getVisualWorkDisplayEntryKey(displayEntry))}
              {@const entry = displayEntry.entry}
              {#if isPlainAssistantWorkText(entry)}
                <div class="work-entry-inline">
                  {@render renderWorkEntryBlocks(entry.blocks)}
                  {#if displayEntry.pairedResult}
                    {@render renderWorkEntryBlocks(displayEntry.pairedResult.blocks)}
                  {/if}
                </div>
              {:else if displayEntry.kind === "marker" && displayEntry.markerBlock}
                {@const markerBlock = displayEntry.markerBlock}
                <div
                  class="work-marker-pill"
                  class:complete={displayEntry.markerKind === "complete"}
                  class:started={displayEntry.markerKind === "started"}
                  class:compacted={displayEntry.markerKind === "compacted"}
                  class:aborted={displayEntry.markerKind === "aborted"}
                  title={markerBlock.text}
                >
                  <span class="work-marker-icon" aria-hidden="true">
                    {workMarkerIcon(displayEntry.markerKind)}
                  </span>
                  <span>{displayEntry.markerLabel}</span>
                  {#if entry.message.timestamp}
                    <span
                      class="muted small"
                      title={new Date(entry.message.timestamp).toLocaleString()}
                    >
                      {relTimeFromIso(entry.message.timestamp)}
                    </span>
                  {/if}
                </div>
              {:else}
                {@const toolBlock = workEntryToolUseBlock(entry)}
                {@const editSummary = workEntryFileEditSummary(entry)}
                {@const resultMeta = toolResultMeta(displayEntry.pairedResult)}
                {@const toolPreview = toolBlock ? workEntryToolPreview(toolBlock) : ""}
                {@const entryBlock = entry.blocks[0]}
                {@const resultBlock = workEntryToolResultBlock(entry)}
                {@const collapsedTitle = workEntryTitle(entry)}
                {@const collapsedPreview = workEntryCollapsedPreview(entry)}
                <details
                  class="work-entry"
                  open={forceOpenThinkingEntry(workKey, entry)}
                  on:toggle={(event) =>
                    onWorkEntryToggle(event, item, workKey, entry)}
                >
                  <summary>
                    {#if toolBlock}
                      {#if editSummary}
                        <span class="work-tool-chip icon-only file-edit">
                          <span class="work-file-edits-icon" aria-hidden="true">✎</span>
                        </span>
                      {:else}
                        <span
                          class="work-tool-chip"
                          class:icon-only={toolUsesInlineCommandLabel(toolBlock)}
                        >
                          <ToolIcon name={toolBlock.toolName} />
                          {#if !toolUsesInlineCommandLabel(toolBlock)}
                            <span>{toolBlock.toolName ?? "tool"}</span>
                          {/if}
                        </span>
                      {/if}
                      {#if editSummary}
                        <span
                          class="work-tool-preview work-file-edit-preview"
                          title={editSummary.files.map((file) => file.path).join("\n")}
                        >
                          {editSummary.title}
                        </span>
                      {:else if toolPreview}
                        <span class="work-tool-preview" title={toolPreview}>
                          {toolPreview}
                        </span>
                      {/if}
                      {#if resultMeta}
                        <span class="work-tool-meta">{resultMeta}</span>
                      {/if}
                    {:else if entryBlock?.type === "thinking"}
                      <span class="work-tool-chip icon-only work-thinking-chip">
                        {@render renderThinkingIcon()}
                      </span>
                      <span
                        class="work-tool-preview work-thinking-preview"
                        title={collapsedPreview || collapsedTitle}
                      >
                        {collapsedPreview || collapsedTitle}
                      </span>
                    {:else if entryBlock?.type === "tool_result"}
                      <span class="work-tool-chip">
                        <ToolIcon name={resultBlock?.toolName ?? "tool_result"} />
                        <span>{collapsedTitle}</span>
                      </span>
                      {#if collapsedPreview}
                        <span class="work-tool-preview" title={collapsedPreview}>
                          {collapsedPreview}
                        </span>
                      {/if}
                    {:else}
                      <span class="work-entry-title">{collapsedTitle}</span>
                      {#if collapsedPreview && collapsedPreview !== collapsedTitle}
                        <span class="work-tool-preview" title={collapsedPreview}>
                          {collapsedPreview}
                        </span>
                      {/if}
                    {/if}
                    {#if entry.message.timestamp}
                      <span
                        class="muted small work-entry-time"
                        title={new Date(entry.message.timestamp).toLocaleString()}
                      >
                        {relTimeFromIso(entry.message.timestamp)}
                      </span>
                    {/if}
                  </summary>
                  <div class="work-entry-body" on:wheel|capture={handOffNestedWheel}>
                    {#if editSummary}
                      {@render renderFileEditSummary(editSummary)}
                      <details class="work-raw-tool-details">
                        <summary>Raw tool input/output</summary>
                        {@render renderWorkEntryBlocks(entry.blocks)}
                        {#if displayEntry.pairedResult}
                          {@render renderWorkEntryBlocks(displayEntry.pairedResult.blocks)}
                        {/if}
                      </details>
                    {:else}
                      {@render renderWorkEntryBlocks(entry.blocks)}
                      {#if displayEntry.pairedResult}
                        {@render renderWorkEntryBlocks(displayEntry.pairedResult.blocks)}
                      {/if}
                    {/if}
                  </div>
                </details>
              {/if}
            {/each}
            {#if isLiveTailWork(item, itemIndex)}
              {@render renderLiveThinkingLine()}
            {/if}
          </div>
        </details>
      </li>
    {:else if item.kind === "marker"}
      <li class="marker-row">
        <div
          class="work-marker-pill transcript-marker-pill"
          class:complete={item.markerKind === "complete"}
          class:started={item.markerKind === "started"}
          class:compacted={item.markerKind === "compacted"}
          class:aborted={item.markerKind === "aborted"}
          title={item.markerBlock.text}
        >
          <span class="work-marker-icon" aria-hidden="true">
            {workMarkerIcon(item.markerKind)}
          </span>
          <span>{item.markerLabel}</span>
          {#if item.entry.message.timestamp}
            <span
              class="muted small"
              title={new Date(item.entry.message.timestamp).toLocaleString()}
            >
              {relTimeFromIso(item.entry.message.timestamp)}
            </span>
          {/if}
        </div>
      </li>
    {:else}
      {@const m = item.message}
      <li
        class="msg role-{m.role}"
        class:user-message={m.role === "user"}
        class:assistant-response={m.role === "assistant"}
        use:flyActualMessageFromComposer={{
          id: m.id,
          source: motionSourceForMessage(m),
        }}
      >
        <div class="msg-head">
          <span
            class="role"
            class:assistant={m.role === "assistant"}
            class:brand-claude={m.role === "assistant" && agent === "claude"}
            class:brand-codex={m.role === "assistant" && agent === "codex"}
            class:brand-ollama={m.role === "assistant" && agent === "ollama"}
            class:brand-copilot={m.role === "assistant" && agent === "copilot"}
          >
            {#if m.role === "assistant" && agent === "claude"}
              <img class="agent-icon" src="/agents/claude.svg" alt="" />
            {:else if m.role === "assistant" && agent === "codex"}
              <svg
                class="agent-icon agent-svg"
                viewBox="0 0 24 24"
                fill="currentColor"
                aria-hidden="true"
              >
                <path
                  d="M22.282 9.821a6 6 0 0 0-.516-4.91 6.05 6.05 0 0 0-6.51-2.9A6.065 6.065 0 0 0 4.981 4.18a6 6 0 0 0-3.998 2.9 6.05 6.05 0 0 0 .743 7.097 5.98 5.98 0 0 0 .51 4.911 6.05 6.05 0 0 0 6.515 2.9A6 6 0 0 0 13.26 24a6.06 6.06 0 0 0 5.772-4.206 6 6 0 0 0 3.997-2.9 6.06 6.06 0 0 0-.747-7.073M13.26 22.43a4.48 4.48 0 0 1-2.876-1.04l.141-.081 4.779-2.758a.8.8 0 0 0 .392-.681v-6.737l2.02 1.168a.07.07 0 0 1 .038.052v5.583a4.504 4.504 0 0 1-4.494 4.494M3.6 18.304a4.47 4.47 0 0 1-.535-3.014l.142.085 4.783 2.759a.77.77 0 0 0 .78 0l5.843-3.369v2.332a.08.08 0 0 1-.033.062L9.74 19.95a4.5 4.5 0 0 1-6.14-1.646M2.34 7.896a4.5 4.5 0 0 1 2.366-1.973V11.6a.77.77 0 0 0 .388.677l5.815 3.354-2.02 1.168a.08.08 0 0 1-.071 0l-4.83-2.786A4.504 4.504 0 0 1 2.34 7.872zm16.597 3.855-5.833-3.387L15.119 7.2a.08.08 0 0 1 .071 0l4.83 2.791a4.494 4.494 0 0 1-.676 8.105v-5.678a.79.79 0 0 0-.407-.667m2.01-3.023-.141-.085-4.774-2.782a.78.78 0 0 0-.785 0L9.409 9.23V6.897a.07.07 0 0 1 .028-.061l4.83-2.787a4.5 4.5 0 0 1 6.68 4.66zm-12.64 4.135-2.02-1.164a.08.08 0 0 1-.038-.057V6.075a4.5 4.5 0 0 1 7.375-3.453l-.142.08L8.704 5.46a.8.8 0 0 0-.393.681zm1.097-2.365 2.602-1.5 2.607 1.5v2.999l-2.597 1.5-2.607-1.5Z"
                />
              </svg>
            {:else if m.role === "assistant" && agent === "ollama"}
              <img class="agent-icon" src="/agents/ollama.svg" alt="" />
            {/if}
            {roleLabel(m.role, m.author)}
          </span>
          {#if m.timestamp}
            <span
              class="muted small"
              title={new Date(m.timestamp).toLocaleString()}
            >
              {relTimeFromIso(m.timestamp)}
            </span>
          {/if}
        </div>
        {#if isSteeredUserMessage(m)}
          <span class="user-intent-chip steered" title="Sent as steering">
            steered
          </span>
        {/if}
        {@render renderMessageBlocks(
          displayBlocksForMessage(item.blocks, m.role),
          m,
          item.messageIndex,
        )}
      </li>
    {/if}
  {/each}
  {#if showLiveThinkingLine && !liveThinkingAttachedToWork}
    <li class="live-thinking-row">
      {@render renderLiveThinkingLine()}
    </li>
  {/if}
</ul>

{#if openMediaBlock && openMediaSrc}
  <section
    use:portal
    class="attachment-media-scrim transcript-media-scrim"
    role="presentation"
    tabindex="-1"
    on:click={closeMediaViewer}
    on:keydown={onMediaModalKeydown}
  >
    <!-- svelte-ignore a11y_click_events_have_key_events -->
    <div
      class="attachment-media-modal attachment-media-modal-image"
      role="dialog"
      aria-modal="true"
      aria-label="Image attachment"
      tabindex="-1"
      on:click|stopPropagation
      on:dblclick|stopPropagation
    >
      <header class="attachment-media-head">
        <span class="attachment-media-title">{mediaLabel(openMediaBlock)}</span>
        {#if openMediaBlocks.length > 1}
          <button
            type="button"
            class="attachment-media-nav"
            aria-label="Previous image"
            title="Previous image"
            on:click={() => openMediaByStep(-1)}>‹</button
          >
          <button
            type="button"
            class="attachment-media-nav"
            aria-label="Next image"
            title="Next image"
            on:click={() => openMediaByStep(1)}>›</button
          >
          <span class="attachment-media-count">
            {openMediaIndex + 1} / {openMediaBlocks.length}
          </span>
        {/if}
        <button
          type="button"
          class="sticky-btn tiny"
          title="Close"
          aria-label="Close"
          on:click={closeMediaViewer}>×</button
        >
      </header>

      <div class="attachment-media-shell attachment-media-shell-image">
        <div class="attachment-media-body">
          <span
            class="sticky-photo-frame sticky-photo-frame-media"
            class:sticky-photo-frame-transparent={openMediaBlock.hasAlpha}
          >
            <img
              src={openMediaSrc}
              alt={openMediaBlock.alt ?? mediaLabel(openMediaBlock)}
              draggable="true"
            />
          </span>
        </div>
      </div>
    </div>
  </section>
{/if}

<style>
  .muted {
    color: var(--text-muted);
  }
  .small {
    font-size: 0.75rem;
  }
  .messages {
    list-style: none;
    padding: 1.6rem 0.5rem 0.4rem;
    margin: 0;
    flex: 1 1 0;
    min-height: 0;
    max-height: none;
    overflow: auto;
    display: flex;
    flex-direction: column;
    gap: 0.4rem;
    overscroll-behavior: auto contain;
  }
  .messages.terminal-transcript {
    gap: 0.18rem;
    padding: 1.1rem 0.45rem 0.35rem;
    font-family:
      "SF Mono", "JetBrains Mono", Menlo, Consolas, "Liberation Mono",
      monospace;
    font-size: 12px;
    line-height: 1.15;
  }
  .messages.terminal-transcript :global(*) {
    border-radius: 0 !important;
  }
  .messages.terminal-transcript .msg,
  .messages.terminal-transcript .msg.user-message,
  .messages.terminal-transcript .msg.assistant-response {
    align-self: stretch;
    width: auto;
    max-width: none;
    padding: 0.2rem 0.25rem;
    border: 0;
    background: transparent;
    font: inherit;
  }
  .messages.terminal-transcript .msg-head {
    display: flex;
    margin-bottom: 0.12rem;
  }
  .messages.terminal-transcript .msg.user-message {
    align-items: stretch;
  }
  .messages.terminal-transcript .msg.user-message .block.text {
    padding: 0;
    border: 0;
    background: transparent;
  }
  .messages.terminal-transcript .block,
  .messages.terminal-transcript .md,
  .messages.terminal-transcript .md :global(*) {
    font-family: inherit;
    line-height: inherit;
  }
  .messages.terminal-transcript .md :global(p) {
    margin: 0 0 1.15em;
  }
  .messages.terminal-transcript .md :global(p:last-child) {
    margin-bottom: 0;
  }
  .messages.terminal-transcript .role,
  .messages.terminal-transcript .role.assistant {
    font-family: inherit;
    font-size: 0.72rem;
    letter-spacing: 0;
    text-transform: none;
  }
  .messages.terminal-transcript .work-foldout > summary {
    border: 0;
    background: transparent;
    padding-inline: 0;
  }
  .messages.terminal-transcript .work-foldout-body,
  .messages.terminal-transcript .work-entry-body {
    border-left-color: color-mix(
      in srgb,
      var(--text-muted) 28%,
      transparent
    );
  }
  .messages.terminal-transcript .work-tool-chip,
  .messages.terminal-transcript .work-marker-pill,
  .messages.terminal-transcript .user-intent-chip,
  .messages.terminal-transcript .md :global(code),
  .messages.terminal-transcript .md :global(.md-code-frame) {
    background: color-mix(in srgb, var(--surface-2) 64%, transparent);
  }
  .messages.terminal-transcript .user-intent-chip {
    border-radius: 0;
    font-family: inherit;
  }
  .msg {
    align-self: stretch;
    padding: 0.45rem 0.6rem;
    border-radius: var(--radius-sm);
    background: var(--surface-0);
    border: 1px solid var(--surface-2);
    font-size: 0.82rem;
  }
  .msg.user-message {
    align-self: flex-end;
    display: flex;
    flex-direction: column;
    align-items: flex-end;
    gap: 0.35rem;
    width: fit-content;
    max-width: 80%;
    padding: 0;
    background: transparent;
    border-color: transparent;
  }
  .msg.user-message .msg-head {
    display: none;
  }
  .user-intent-chip {
    align-self: flex-end;
    display: inline-flex;
    align-items: center;
    gap: 0.25rem;
    padding: 0.1rem 0.42rem;
    border-radius: 999px;
    border: 1px solid color-mix(in srgb, var(--accent) 54%, transparent);
    background: color-mix(in srgb, var(--accent) 12%, transparent);
    color: color-mix(in srgb, var(--accent) 76%, var(--text));
    font-size: 0.66rem;
    font-weight: 700;
    line-height: 1.15;
    text-transform: uppercase;
    letter-spacing: 0;
  }
  .msg.user-message .block.text {
    padding: 0.45rem 0.7rem;
    border-radius: 1rem;
    background: color-mix(in srgb, var(--surface-3) 62%, var(--surface-1));
    border: 1px solid color-mix(in srgb, var(--surface-3) 80%, transparent);
    text-align: left;
  }
  .msg.user-message .media-block {
    margin: 0;
    max-width: min(16rem, 100%);
  }
  .msg.user-message .media-photo-frame img {
    max-height: 7.2rem;
  }
  .msg.user-message .media-block figcaption {
    display: none;
  }
  .msg.assistant-response {
    background: transparent;
    border-color: transparent;
    padding-inline: 0.25rem;
  }
  .msg.assistant-response .msg-head {
    margin-bottom: 0.15rem;
  }
  .msg-head {
    display: flex;
    gap: 0.5rem;
    align-items: baseline;
    margin-bottom: 0.3rem;
  }
  .role {
    text-transform: uppercase;
    letter-spacing: 0.05em;
    font-size: 0.7rem;
    color: var(--text-muted);
    font-weight: 600;
  }
  .role.assistant {
    text-transform: none;
    letter-spacing: 0;
    font-size: 0.8rem;
  }
  .role.brand-claude {
    color: var(--chip-orange-text);
  }
  .role .agent-icon {
    width: 1em;
    height: 1em;
    vertical-align: -0.12em;
    margin-right: 0.35em;
  }
  .role .agent-icon.agent-svg {
    display: inline-block;
  }
  .role.brand-codex {
    color: var(--chip-codex-text);
  }
  .role.brand-ollama {
    color: var(--chip-ollama-text);
  }
  .role.brand-copilot {
    color: var(--chip-default-text);
  }
  .block.text {
    word-break: break-word;
  }
  .work-row {
    align-self: stretch;
    list-style: none;
    padding: 0;
    margin: 0.15rem 0;
    min-width: 0;
  }
  .work-foldout,
  .work-entry {
    border-radius: var(--radius-sm);
    min-width: 0;
  }
  .work-foldout > summary,
  .work-entry > summary {
    display: flex;
    align-items: center;
    gap: 0.45rem;
    list-style: none;
    color: var(--text-muted);
    cursor: pointer;
    user-select: none;
  }
  .work-foldout > summary {
    width: fit-content;
    max-width: 100%;
    padding: 0.25rem 0.5rem;
    border: 1px solid color-mix(in srgb, var(--surface-3) 65%, transparent);
    border-radius: 999px;
    background: color-mix(in srgb, var(--surface-1) 75%, transparent);
    font-size: 0.72rem;
    line-height: 1.2;
    font-variant-numeric: tabular-nums;
    font-feature-settings: "tnum";
  }
  .work-foldout > summary:hover {
    color: var(--text-1);
    border-color: var(--surface-3);
  }
  .work-foldout[open] > summary {
    color: var(--text-1);
  }
  .work-foldout > summary::-webkit-details-marker,
  .work-entry > summary::-webkit-details-marker {
    display: none;
  }
  .work-foldout > summary::before,
  .work-entry > summary::before {
    content: "▸";
    display: inline-block;
    line-height: 1;
    color: var(--text-faint);
    font-size: 0.7rem;
    transition: transform 0.15s ease-out;
  }
  .work-foldout[open] > summary::before,
  .work-entry[open] > summary::before {
    transform: rotate(90deg);
  }
  .work-count {
    color: var(--text-faint);
    font-family: ui-monospace, monospace;
    font-size: 0.68rem;
    font-variant-numeric: tabular-nums;
    font-feature-settings: "tnum";
  }
  .work-foldout-body {
    display: grid;
    gap: 0.38rem;
    margin: 0.55rem 0 0.15rem 1.05rem;
    padding-left: 0.65rem;
    border-left: 1px solid color-mix(in srgb, var(--surface-3) 45%, transparent);
    min-width: 0;
    max-width: calc(100% - 1.7rem);
  }
  .work-foldout-live > .work-foldout-body {
    max-height: clamp(8rem, 28vh, 16rem);
    overflow-x: hidden;
    overflow-y: auto;
    padding-right: 0.35rem;
    overscroll-behavior-x: contain;
    overscroll-behavior-y: auto;
  }
  .work-entry {
    padding: 0;
    background: transparent;
    border: 0;
    min-width: 0;
  }
  .work-entry-inline {
    color: var(--text-2);
    font-size: 0.78rem;
    line-height: 1.45;
    min-width: 0;
    max-width: 100%;
  }
  .marker-row {
    display: flex;
    justify-content: center;
    margin: 0.7rem 0 0.4rem;
  }
  .work-marker-pill {
    display: inline-flex;
    align-items: center;
    gap: 0.4rem;
    width: fit-content;
    max-width: 100%;
    padding: 0.16rem 0.46rem 0.18rem;
    border-radius: 999px;
    border: 1px solid color-mix(in srgb, var(--surface-3) 48%, transparent);
    background: color-mix(in srgb, var(--surface-2) 48%, transparent);
    color: var(--text-muted);
    font-size: 0.74rem;
    line-height: 1.2;
  }
  .transcript-marker-pill {
    padding-inline: 0.62rem;
    font-size: 0.78rem;
  }
  .work-marker-pill.complete {
    border-color: color-mix(in srgb, var(--ok) 38%, var(--surface-3));
    background: color-mix(in srgb, var(--ok) 13%, transparent);
    color: color-mix(in srgb, var(--ok) 78%, var(--text-1));
  }
  .work-marker-pill.started {
    color: var(--text-faint);
  }
  .work-marker-pill.compacted {
    border-color: color-mix(in srgb, var(--accent, #6aa9ff) 28%, var(--surface-3));
    background: color-mix(in srgb, var(--accent, #6aa9ff) 9%, transparent);
    color: color-mix(in srgb, var(--accent, #6aa9ff) 62%, var(--text-1));
  }
  .work-marker-pill.aborted {
    border-color: color-mix(in srgb, var(--danger, #e5707a) 34%, var(--surface-3));
    background: color-mix(in srgb, var(--danger, #e5707a) 10%, transparent);
    color: color-mix(in srgb, var(--danger, #e5707a) 72%, var(--text-1));
  }
  .work-marker-icon {
    display: inline-grid;
    place-items: center;
    width: 0.95rem;
    height: 0.95rem;
    border-radius: 999px;
    background: color-mix(in srgb, currentColor 16%, transparent);
    font-size: 0.68rem;
    line-height: 1;
  }
  .work-entry > summary {
    justify-content: flex-start;
    min-height: 1.7rem;
    padding: 0.15rem 0.2rem;
    border-radius: 0.45rem;
    font-size: 0.76rem;
    line-height: 1.25;
  }
  .work-entry > summary:hover {
    background: color-mix(in srgb, var(--surface-1) 48%, transparent);
    color: var(--text-1);
  }
  .work-entry > summary > span:not(.work-tool-chip):first-child {
    min-width: 0;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }
  .work-entry-title {
    min-width: 0;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }
  .work-tool-chip {
    display: inline-flex;
    align-items: center;
    gap: 0.35rem;
    flex: 0 0 auto;
    padding: 0.1rem 0.38rem 0.12rem;
    border: 1px solid color-mix(in srgb, var(--surface-3) 55%, transparent);
    border-radius: 999px;
    background: color-mix(in srgb, var(--surface-2) 64%, transparent);
    color: var(--text-2);
    font-family:
      ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, "Liberation Mono",
      "Courier New", monospace;
    font-size: 0.74rem;
    line-height: 1.15;
  }
  .work-tool-chip.icon-only {
    padding: 0.14rem 0.32rem;
  }
  .work-tool-chip.file-edit {
    color: var(--text-muted);
  }
  .work-thinking-chip {
    color: color-mix(in srgb, var(--text-muted) 88%, var(--brand));
  }
  .work-thinking-chip .thinking-icon {
    width: 0.86rem;
    height: 0.86rem;
    margin: 0;
  }
  .work-tool-chip span {
    flex: 0 0 auto;
    white-space: nowrap;
  }
  .work-thinking-preview {
    font-family: inherit;
    font-size: 0.74rem;
  }
  .work-tool-preview {
    flex: 1 1 auto;
    min-width: 4rem;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
    color: var(--text-faint);
    font-family:
      ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, "Liberation Mono",
      "Courier New", monospace;
    font-size: 0.7rem;
  }
  .work-entry[open] > summary .work-tool-preview {
    display: none;
  }
  .work-file-edit-preview {
    color: var(--text-muted);
  }
  .work-tool-meta {
    flex: 0 1 auto;
    min-width: 0;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
    color: var(--text-faint);
    font-family:
      ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, "Liberation Mono",
      "Courier New", monospace;
    font-size: 0.7rem;
  }
  .work-entry-time {
    display: none;
    flex: 0 0 auto;
  }
  .work-entry[open] > summary .work-entry-time {
    display: inline;
  }
  .work-entry-body {
    display: grid;
    gap: 0.35rem;
    min-width: 0;
    max-width: 100%;
    margin: 0.25rem 0 0.45rem 0.9rem;
    padding-left: 0.55rem;
    border-left: 1px solid color-mix(in srgb, var(--surface-3) 35%, transparent);
    color: var(--text-2);
    font-size: 0.78rem;
    line-height: 1.45;
  }
  .work-file-edits {
    display: grid;
    gap: 0.45rem;
    min-width: 0;
    color: var(--text-2);
  }
  .work-file-edits-title,
  .work-file-edit-row {
    display: flex;
    align-items: baseline;
    gap: 0.42rem;
    min-width: 0;
  }
  .work-file-edits-title {
    color: var(--text-muted);
    font-size: 0.78rem;
  }
  .work-file-edits-icon {
    color: var(--text-faint);
    font-family: ui-monospace, monospace;
    line-height: 1;
  }
  .work-file-edit-list {
    display: grid;
    gap: 0.2rem;
    min-width: 0;
  }
  .work-file-edit-detail {
    min-width: 0;
  }
  .work-file-edit-detail > summary,
  .work-raw-tool-details > summary {
    list-style: none;
    cursor: pointer;
  }
  .work-file-edit-detail > summary::-webkit-details-marker,
  .work-raw-tool-details > summary::-webkit-details-marker {
    display: none;
  }
  .work-file-edit-detail > summary::before,
  .work-raw-tool-details > summary::before {
    content: "▸";
    display: inline-block;
    flex: 0 0 auto;
    color: var(--text-faint);
    line-height: 1;
    transition: transform 0.15s ease-out;
  }
  .work-file-edit-detail[open] > summary::before,
  .work-raw-tool-details[open] > summary::before {
    transform: rotate(90deg);
  }
  .work-file-action {
    flex: 0 0 auto;
    color: var(--text-muted);
  }
  .work-file-path {
    min-width: 0;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
    color: var(--accent, #6aa9ff);
  }
  .work-file-add,
  .work-file-del {
    flex: 0 0 auto;
    font-family: ui-monospace, monospace;
    font-size: 0.78rem;
  }
  .work-file-add {
    color: var(--ok, #31d078);
  }
  .work-file-del {
    color: var(--bad, #ff5a5a);
  }
  .work-file-raw {
    margin: 0.24rem 0 0.42rem 1.1rem;
    min-width: 0;
  }
  .work-raw-tool-details {
    display: grid;
    gap: 0.35rem;
    min-width: 0;
    margin-top: 0.15rem;
  }
  .work-raw-tool-details > summary {
    display: inline-flex;
    align-items: center;
    gap: 0.35rem;
    width: fit-content;
    color: var(--text-faint);
    font-size: 0.72rem;
  }
  .work-raw-tool-details > summary:hover {
    color: var(--text-muted);
  }
  .work-step-text,
  .work-step-detail,
  .work-tool-code,
  .work-tool-output {
    min-width: 0;
    max-width: 100%;
  }
  .work-step-detail {
    display: flex;
    align-items: baseline;
    gap: 0.45rem;
    color: var(--text-muted);
  }
  .work-step-detail .tag-body {
    min-width: 0;
    overflow-wrap: anywhere;
    color: var(--text-2);
  }
  .work-tool-code,
  .work-tool-output {
    display: grid;
    gap: 0.22rem;
  }
  .work-tool-output-label {
    color: var(--text-muted);
    font-family:
      ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, "Liberation Mono",
      "Courier New", monospace;
    font-size: 0.7rem;
    line-height: 1.2;
  }
  .work-tool-empty-text,
  .tool-result-empty-text {
    color: var(--text-faint);
    font-family:
      ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, "Liberation Mono",
      "Courier New", monospace;
    font-size: 0.74rem;
  }
  .work-foldout-body .md :global(.md-code-frame),
  .work-entry-body .md :global(.md-code-frame) {
    max-width: 100%;
    margin: 0.08rem 0;
  }
  .work-tool-code :global(.md-code-frame),
  .work-tool-output :global(.md-code-frame),
  .block.tool-result :global(.md-code-frame) {
    display: flex;
    flex-direction: column;
    max-height: min(26rem, 46vh);
  }
  .work-foldout-body .md :global(pre),
  .work-entry-body .md :global(pre) {
    max-width: 100%;
    font-size: 0.78rem;
  }
  .work-tool-code :global(pre),
  .work-tool-output :global(pre),
  .block.tool-result :global(pre) {
    flex: 1 1 auto;
    min-height: 0;
    max-height: 22rem;
    overflow: auto;
  }
  .work-foldout-body .md :global(p),
  .work-entry-body .md :global(p) {
    margin: 0.2em 0;
  }
  .md :global(p) {
    margin: 0.35em 0 0.55em;
  }
  .md :global(p:first-child) {
    margin-top: 0;
  }
  .md :global(p:last-child) {
    margin-bottom: 0;
  }
  .md :global(code) {
    background: color-mix(in srgb, var(--surface-2) 86%, transparent);
    border: 1px solid color-mix(in srgb, var(--surface-3) 72%, transparent);
    padding: 0.08em 0.35em;
    border-radius: 0.32rem;
    font-family: ui-monospace, monospace;
    font-size: 0.86em;
    color: var(--text-1);
  }
  .md :global(.md-code-frame) {
    margin: 0.65em 0;
    overflow: hidden;
    border: 1px solid color-mix(in srgb, var(--surface-3) 72%, transparent);
    border-radius: 0.7rem;
    background: color-mix(in srgb, var(--surface-2) 86%, transparent);
  }
  .md :global(.md-code-head) {
    display: flex;
    align-items: center;
    justify-content: space-between;
    min-height: 1.45rem;
    padding: 0.22rem 0.5rem 0.02rem;
    color: var(--text-muted);
    font-family: ui-monospace, monospace;
    font-size: 0.72rem;
  }
  .md :global(.md-code-lang) {
    min-width: 0;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }
  .md :global(.md-code-copy) {
    position: relative;
    display: inline-flex;
    align-items: center;
    justify-content: center;
    width: 1.32rem;
    height: 1.16rem;
    min-width: 1.32rem;
    padding: 0;
    border: 1px solid transparent;
    border-radius: 0.35rem;
    background: transparent;
    color: var(--text-muted);
    font: inherit;
    font-size: 0;
    cursor: pointer;
  }
  .md :global(.md-code-copy::before),
  .md :global(.md-code-copy::after) {
    content: "";
    position: absolute;
    width: 0.42rem;
    height: 0.52rem;
    border: 1.25px solid currentColor;
    border-radius: 0.11rem;
  }
  .md :global(.md-code-copy::before) {
    transform: translate(-0.08rem, 0.06rem);
  }
  .md :global(.md-code-copy::after) {
    transform: translate(0.09rem, -0.08rem);
    background: color-mix(in srgb, var(--surface-2) 86%, transparent);
  }
  .md :global(.md-code-copy:hover) {
    border-color: var(--surface-3);
    background: color-mix(in srgb, var(--surface-1) 80%, transparent);
    color: var(--text-1);
  }
  .md :global(pre) {
    margin: 0;
    padding: 0.22rem 0.65rem 0.62rem;
    overflow-x: auto;
    background: transparent;
    font-family: ui-monospace, monospace;
    font-size: 0.86em;
    line-height: 1.5;
  }
  .md :global(pre code) {
    display: block;
    border: 0;
    border-radius: 0;
    background: transparent;
    padding: 0;
    color: var(--text-1);
    font-size: inherit;
  }
  .md :global(ul),
  .md :global(ol) {
    padding-left: 1.4em;
    margin: 0.4em 0;
  }
  .md :global(li) {
    margin: 0.15em 0;
  }
  .md :global(h1),
  .md :global(h2),
  .md :global(h3),
  .md :global(h4) {
    margin: 0.6em 0 0.3em;
    font-weight: 600;
    line-height: 1.3;
  }
  .md :global(h1) {
    font-size: 1.15em;
  }
  .md :global(h2) {
    font-size: 1.05em;
  }
  .md :global(h3),
  .md :global(h4) {
    font-size: 1em;
  }
  .md :global(blockquote) {
    border-left: 2px solid var(--surface-3);
    padding-left: 0.65em;
    color: var(--text-muted);
    margin: 0.4em 0;
  }
  .md :global(a) {
    color: var(--brand);
    text-decoration: none;
  }
  .md :global(a:hover) {
    text-decoration: underline;
  }
  .md :global(hr) {
    border: 0;
    border-top: 1px solid var(--surface-2);
    margin: 0.5em 0;
  }
  .md :global(img) {
    max-width: 100%;
    max-height: 30vh;
    width: auto;
    height: auto;
    border-radius: var(--radius-sm);
    background: var(--surface-2);
    display: block;
    margin: 0.4em 0;
    font-size: 0.78em;
    color: var(--text-muted);
  }
  .md :global(table) {
    border-collapse: collapse;
    margin: 0.4em 0;
  }
  .md :global(th),
  .md :global(td) {
    border: 1px solid var(--surface-2);
    padding: 0.25em 0.5em;
    text-align: left;
  }
  .md :global(th) {
    background: var(--surface-2);
    font-weight: 600;
  }
  .block.tool-use {
    margin-top: 0.3rem;
    display: flex;
    gap: 0.45rem;
    align-items: center;
    font-family: ui-monospace, monospace;
    font-size: 0.78rem;
    color: var(--text-3);
    min-width: 0;
  }
  .tool-name {
    color: var(--text-2);
    flex: 0 0 auto;
  }
  .tool-input {
    color: var(--text-muted);
    flex: 1;
    min-width: 0;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }
  .block.tool-result {
    margin-top: 0.3rem;
  }
  .block.tool-result .muted {
    display: block;
    margin-bottom: 0.2rem;
  }
  .media-block {
    margin: 0.35rem 0 0;
    max-width: min(100%, 34rem);
  }
  .media-strip {
    display: flex;
    align-items: flex-end;
    flex-wrap: wrap;
    gap: 0.45rem;
    max-width: min(100%, 34rem);
  }
  .user-media-strip {
    justify-content: flex-end;
  }
  .media-block a {
    color: var(--brand);
    text-decoration: none;
  }
  .media-image-open {
    display: block;
    width: min(18rem, 100%);
    min-width: 0;
    padding: 0;
    border: 0;
    background: transparent;
    color: inherit;
    font: inherit;
    text-align: inherit;
    cursor: zoom-in;
  }
  .user-media-strip .media-image-open {
    width: 5.2rem;
    flex: 0 0 auto;
  }
  .media-block a:hover,
  .media-image-open:hover {
    text-decoration: underline;
  }
  .media-image-open:hover .sticky-photo-frame {
    transform: translateY(-1px);
    box-shadow:
      0 2px 4px rgba(0, 0, 0, 0.22),
      0 9px 18px rgba(0, 0, 0, 0.18);
  }
  .media-photo-frame {
    box-sizing: border-box;
  }
  .media-photo-frame img {
    max-height: 9rem;
  }
  .composer-photo-frame {
    box-sizing: border-box;
    width: 100%;
    padding: 5px 5px 14px;
  }
  .composer-photo-frame img {
    max-height: 3.1rem;
  }
  .media-block figcaption {
    margin-top: 0.2rem;
    font-size: 0.72rem;
    color: var(--text-muted);
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }
  .media-artifact {
    display: flex;
    align-items: center;
    gap: 0.45rem;
    min-width: 0;
    padding: 0.25rem 0.5rem;
    border-radius: var(--radius-sm);
    background: rgba(160, 160, 160, 0.06);
    color: var(--text-muted);
    font-size: 0.76rem;
  }
  .media-artifact > a,
  .media-artifact > span:not(.tag-label) {
    min-width: 0;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }
  .media-note {
    margin-top: 0.2rem;
    color: var(--text-faint);
    font-size: 0.72rem;
  }
  .block.ide-context,
  .block.sys-reminder,
  .block.command {
    display: flex;
    gap: 0.5rem;
    align-items: baseline;
    margin-top: 0.25rem;
    padding: 0.25rem 0.5rem;
    border-radius: var(--radius-sm);
    font-size: 0.72rem;
    line-height: 1.4;
  }
  .tag-label {
    flex: 0 0 auto;
    font-family: ui-monospace, monospace;
    text-transform: lowercase;
    font-weight: 600;
    color: var(--text-muted);
  }
  .tag-body {
    color: var(--text-muted);
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }
  .block.ide-context {
    background: rgba(37, 99, 235, 0.08);
  }
  .block.ide-context .tag-label {
    color: var(--chip-default-text);
  }
  .block.sys-reminder {
    background: rgba(217, 119, 6, 0.08);
  }
  .block.sys-reminder .tag-label {
    color: var(--chip-orange-text);
  }
  .block.command {
    background: rgba(22, 163, 74, 0.08);
  }
  .block.command .tag-label {
    color: var(--chip-green-text);
  }
  .block.thinking {
    display: flex;
    gap: 0.5rem;
    align-items: flex-start;
    margin-top: 0.25rem;
    padding: 0.25rem 0.5rem;
    background: rgba(160, 160, 160, 0.06);
    border-radius: var(--radius-sm);
    color: var(--text-muted);
    font-size: 0.78rem;
    line-height: 1.4;
  }
  .live-thinking-row {
    list-style: none;
    margin: 0.15rem 0 0;
  }
  .live-thinking-line {
    display: inline-flex;
    align-items: center;
    gap: 0.42rem;
    min-width: 0;
    color: var(--text-muted);
    font-size: 0.82rem;
    line-height: 1.35;
  }
  .live-thinking-line .thinking-icon {
    width: 0.95rem;
    height: 0.95rem;
    margin-top: 0;
    color: color-mix(in srgb, var(--text-muted) 78%, var(--brand));
  }
  .live-thinking-dots {
    display: inline-flex;
    width: 1.1em;
    overflow: hidden;
  }
  .live-thinking-dots span {
    animation: live-thinking-dot 1.25s infinite;
    opacity: 0.18;
  }
  .live-thinking-dots span:nth-child(2) {
    animation-delay: 0.16s;
  }
  .live-thinking-dots span:nth-child(3) {
    animation-delay: 0.32s;
  }
  @keyframes live-thinking-dot {
    0%,
    55%,
    100% {
      opacity: 0.18;
      transform: translateY(0);
    }
    25% {
      opacity: 1;
      transform: translateY(-0.05rem);
    }
  }
  .plan-block {
    display: grid;
    gap: 0.35rem;
    margin-top: 0.25rem;
    padding: 0.25rem 0.5rem;
    border-radius: var(--radius-sm);
    background: rgba(160, 160, 160, 0.06);
    color: var(--text-2);
    font-size: 0.78rem;
    line-height: 1.35;
  }
  .plan-title {
    color: var(--text-1);
    font-weight: 650;
  }
  .plan-explanation {
    color: var(--text-muted);
  }
  .plan-items {
    display: grid;
    gap: 0.16rem;
  }
  .plan-item {
    display: grid;
    grid-template-columns: auto minmax(0, 1fr);
    gap: 0.42rem;
    min-width: 0;
  }
  .plan-item.active {
    color: var(--text-1);
  }
  .plan-status {
    color: var(--text-faint);
    font-size: 0.82em;
  }
  .work-plan-detail {
    align-items: start;
  }
  .thinking-icon {
    flex: 0 0 auto;
    width: 1rem;
    height: 1rem;
    margin-top: 0.1rem;
    color: color-mix(in srgb, var(--text-muted) 88%, var(--brand));
    opacity: 0.9;
  }
  .thinking-copy {
    min-width: 0;
    display: grid;
    gap: 0.18rem;
  }
  .thinking-title {
    color: var(--text-2);
    font-weight: 650;
    font-style: normal;
  }
  .block.thinking .tag-body {
    color: var(--text-muted);
    overflow: visible;
    text-overflow: clip;
    white-space: normal;
    flex: 1;
  }
  .thinking-copy .tag-body {
    white-space: normal;
    overflow: visible;
    text-overflow: clip;
    overflow-wrap: anywhere;
    font-style: normal;
  }
  .thinking-copy .tag-body :global(p) {
    margin: 0 0 0.45rem;
  }
  .thinking-copy .tag-body :global(p:last-child) {
    margin-bottom: 0;
  }
  .work-step-detail .thinking-copy .tag-body {
    color: var(--text-muted);
  }
  .work-step-detail .thinking-icon {
    margin-top: 0.18rem;
  }
  .block.marker {
    margin-top: 0.2rem;
    font-style: italic;
    font-size: 0.75rem;
    color: var(--text-faint);
  }
  .ollama-waiting {
    color: var(--text-muted);
    min-height: 1.2rem;
    display: flex;
    align-items: center;
  }
</style>
