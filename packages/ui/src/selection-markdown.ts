import { writeClipboard } from "./clipboard-write";
import { apiUrl } from "./api";
import {
  resolveLocalFileMarkdownHref,
  shouldUseWindowOpenFallback,
} from "./open-url";
import {
  appendInlineAttachmentRef,
  makeImageAttachmentRef,
} from "./note-inline-attachments";

export const MARKDOWN_SOURCE_ATTR = "data-supergit-markdown-source";
const IMAGE_PATH_ATTR = "data-supergit-image-path";
export const CREATE_NOTE_EVENT = "supergit:create-note-from-selection";

export interface MarkdownSourceSegment {
  markdown: string;
  visibleText: string;
}

export interface MarkdownSelection {
  markdown: string;
  fromMarkdownSource: boolean;
  imagePaths?: string[];
}

function cleanSelectionText(text: string): string {
  return text.replace(/\s+/g, " ").trim();
}

export function markdownFromSelectedSources(
  selectedText: string,
  sources: readonly MarkdownSourceSegment[],
): MarkdownSelection | null {
  const selected = cleanSelectionText(selectedText);
  if (!selected) return null;
  const completeSources = sources.filter((source) => {
    const visible = cleanSelectionText(source.visibleText);
    return visible && selected.includes(visible);
  });
  if (completeSources.length === 0) {
    return { markdown: selectedText, fromMarkdownSource: false };
  }
  if (completeSources.length !== sources.length) {
    return { markdown: selectedText, fromMarkdownSource: false };
  }
  return {
    markdown: completeSources
      .map((source) => source.markdown.trim())
      .join("\n\n"),
    fromMarkdownSource: true,
  };
}

export function noteBodyFromSelection(selection: MarkdownSelection): string {
  let body = selection.markdown.trim();
  for (const path of selection.imagePaths ?? []) {
    body = appendInlineAttachmentRef(
      body,
      makeImageAttachmentRef({ path, filename: path.split(/[\\/]/).pop() }),
    );
  }
  return body;
}

export interface MarkdownClipboardData {
  setData(type: string, data: string): void;
}

export function writeMarkdownSelectionToClipboardData(
  clipboardData: MarkdownClipboardData,
  selection: MarkdownSelection,
): string {
  const body = noteBodyFromSelection(selection);
  clipboardData.setData("text/plain", body);
  clipboardData.setData("text/markdown", body);
  return body;
}

function elementsIntersectingRange<T extends HTMLElement>(
  owner: Document,
  selector: string,
  range: Range,
): T[] {
  return Array.from(owner.querySelectorAll<T>(selector)).filter((node) => {
    try {
      return range.intersectsNode(node);
    } catch {
      return false;
    }
  });
}

function imagePathFromUrl(src: string | null | undefined): string | null {
  if (!src) return null;
  try {
    const url = new URL(src, location.href);
    const path = url.searchParams.get("path");
    if (path && url.pathname.endsWith("/api/image")) return path;
  } catch {
    return null;
  }
  return null;
}

function selectedImagePaths(owner: Document, range: Range): string[] {
  const seen = new Set<string>();
  const paths: string[] = [];
  for (const node of elementsIntersectingRange<HTMLElement>(
    owner,
    `[${IMAGE_PATH_ATTR}], img`,
    range,
  )) {
    const attr = node.getAttribute(IMAGE_PATH_ATTR);
    const img =
      node instanceof HTMLImageElement ? node : node.querySelector("img");
    const path = attr || imagePathFromUrl(img?.getAttribute("src") || img?.src);
    if (!path || seen.has(path)) continue;
    seen.add(path);
    paths.push(path);
  }
  return paths;
}

function selectedMarkdown(
  selection: Selection | null,
): MarkdownSelection | null {
  if (!selection || selection.isCollapsed || selection.rangeCount === 0)
    return null;
  const selectedText = selection.toString();
  const range = selection.getRangeAt(0);
  const owner = range.commonAncestorContainer.ownerDocument ?? document;
  const sourceNodes = elementsIntersectingRange<HTMLElement>(
    owner,
    `[${MARKDOWN_SOURCE_ATTR}]`,
    range,
  );
  const imagePaths = selectedImagePaths(owner, range);
  if (sourceNodes.length === 0 && imagePaths.length === 0) return null;
  const markdown = markdownFromSelectedSources(
    selectedText,
    sourceNodes.map((node) => ({
      markdown: node.getAttribute(MARKDOWN_SOURCE_ATTR) ?? "",
      visibleText: node.innerText || node.textContent || "",
    })),
  );
  if (markdown) return { ...markdown, imagePaths };
  return imagePaths.length > 0
    ? { markdown: "", fromMarkdownSource: true, imagePaths }
    : null;
}

function syncCopy(text: string): boolean {
  const textarea = document.createElement("textarea");
  textarea.value = text;
  textarea.setAttribute("readonly", "");
  textarea.style.position = "fixed";
  textarea.style.left = "-9999px";
  textarea.style.top = "0";
  document.body.appendChild(textarea);
  textarea.select();
  let ok = false;
  try {
    ok = document.execCommand("copy");
  } finally {
    textarea.remove();
  }
  return ok;
}

function copyText(text: string): void {
  writeClipboard(text, {
    syncCopy,
    asyncWrite: navigator.clipboard?.writeText
      ? (value) => navigator.clipboard.writeText(value)
      : null,
    warn: (message) => console.warn(message),
  });
}

function isEditableTarget(target: EventTarget | null): boolean {
  const element = target instanceof Element ? target : null;
  return !!element?.closest("input, textarea, [contenteditable='true']");
}

export function platformFileManagerName(): string {
  if (/Mac|iPhone|iPad/.test(navigator.userAgent)) return "Finder";
  if (/Win/.test(navigator.userAgent)) return "Explorer";
  return "Files";
}

export function fileManagerOpenLabel(fileManagerName: string): string {
  return `Open in ${fileManagerName}`;
}

export interface MenuItem {
  label: string;
  action: () => void;
}

export interface ContextMenuTargets {
  markdownSelection: boolean;
  noteAnchor: boolean;
  filePath: boolean;
  fileManagerName: string;
}

export interface ContextMenuActions {
  copyMarkdown?: () => void;
  moveToNote?: () => void;
  openFile?: () => void;
  openInFileManager?: () => void;
}

export function buildContextMenuItemsForTargets(
  target: ContextMenuTargets,
  actions: ContextMenuActions,
): MenuItem[] {
  const items: MenuItem[] = [];
  if (target.markdownSelection) {
    if (actions.copyMarkdown) {
      items.push({ label: "Copy Markdown", action: actions.copyMarkdown });
    }
    if (target.noteAnchor && actions.moveToNote) {
      items.push({ label: "Move to note", action: actions.moveToNote });
    }
  }
  if (target.filePath) {
    if (actions.openFile) items.push({ label: "Open", action: actions.openFile });
    if (actions.openInFileManager) {
      items.push({
        label: fileManagerOpenLabel(target.fileManagerName),
        action: actions.openInFileManager,
      });
    }
  }
  return items;
}

function closestElement(target: EventTarget | null): Element | null {
  return target instanceof Element ? target : null;
}

function contextNoteAnchor(
  event: MouseEvent,
  selection: Selection | null,
): string | null {
  const target = closestElement(event.target);
  const targetRow = target?.closest<HTMLElement>("[data-wt-row]");
  const targetRowPath = targetRow?.dataset.wtRow;
  if (targetRowPath && !targetRowPath.includes("|none")) {
    return `worktree:${targetRowPath}`;
  }

  const range = selection?.rangeCount ? selection.getRangeAt(0) : null;
  const common =
    range?.commonAncestorContainer instanceof Element
      ? range.commonAncestorContainer
      : range?.commonAncestorContainer.parentElement;
  const row = common?.closest<HTMLElement>("[data-wt-row]");
  const rowPath = row?.dataset.wtRow;
  if (rowPath && !rowPath.includes("|none")) return `worktree:${rowPath}`;

  const session = (target ?? common)?.closest<HTMLElement>(
    "[data-supergit-session-cwd]",
  );
  const cwd = session?.dataset.supergitSessionCwd;
  return cwd && cwd.startsWith("/") ? `worktree:${cwd}` : null;
}

function contextDaemonId(target: EventTarget | null): string | undefined {
  return (
    closestElement(target)?.closest<HTMLElement>("[data-supergit-daemon-id]")
      ?.dataset.supergitDaemonId || undefined
  );
}

function contextFilePath(target: EventTarget | null): string | null {
  const element = closestElement(target);
  const fileLink = element?.closest<HTMLElement>("[data-supergit-file-href]");
  if (!fileLink) return null;
  const cwd = fileLink.closest<HTMLElement>("[data-supergit-session-cwd]")
    ?.dataset.supergitSessionCwd;
  return resolveLocalFileMarkdownHref(
    fileLink.getAttribute("data-supergit-file-href"),
    cwd,
  );
}

async function postJson(
  path: string,
  body: unknown,
  daemonId?: string,
): Promise<void> {
  const res = await fetch(apiUrl(path, daemonId), {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  if (!res.ok) {
    const data = await res.json().catch(() => ({}));
    throw new Error(data.error ?? `HTTP ${res.status}`);
  }
}

function openFile(path: string, daemonId?: string): void {
  void postJson("/api/open-default", { path }, daemonId).catch(() => {
    if (shouldUseWindowOpenFallback(path)) {
      window.open(path, "_blank", "noopener,noreferrer");
    }
  });
}

function revealFile(path: string, daemonId?: string): void {
  void postJson("/api/open", { path, app: "files" }, daemonId).catch(() => {});
}

export interface CreateNoteFromSelectionDetail {
  body: string;
  anchor: string;
  originRect: DOMRect;
}

export type CreateNoteFromSelectionEvent =
  CustomEvent<CreateNoteFromSelectionDetail>;

declare global {
  interface WindowEventMap {
    [CREATE_NOTE_EVENT]: CreateNoteFromSelectionEvent;
  }
}

function moveSelectionToNote(
  event: MouseEvent,
  selection: MarkdownSelection,
  anchor: string,
): void {
  window.dispatchEvent(
    new CustomEvent<CreateNoteFromSelectionDetail>(CREATE_NOTE_EVENT, {
      detail: {
        body: noteBodyFromSelection(selection),
        anchor,
        originRect: new DOMRect(event.clientX, event.clientY, 1, 1),
      },
    }),
  );
}

export function installMarkdownSelectionContextMenu(): () => void {
  let menu: HTMLDivElement | null = null;
  let activeSelection: MarkdownSelection | null = null;
  let activeContextEvent: MouseEvent | null = null;

  const close = () => {
    menu?.remove();
    menu = null;
    activeSelection = null;
    activeContextEvent = null;
  };

  const show = (
    event: MouseEvent,
    items: MenuItem[],
    selection?: MarkdownSelection,
  ) => {
    close();
    activeSelection = selection ?? null;
    activeContextEvent = event;
    menu = document.createElement("div");
    menu.className = "selection-context-menu";
    menu.style.left = `${event.clientX}px`;
    menu.style.top = `${event.clientY}px`;
    for (const item of items) {
      const button = document.createElement("button");
      button.type = "button";
      button.textContent = item.label;
      button.addEventListener("click", () => {
        item.action();
        close();
      });
      menu.appendChild(button);
    }
    document.body.appendChild(menu);
  };

  const onContextMenu = (event: MouseEvent) => {
    if (event.defaultPrevented || isEditableTarget(event.target)) return;
    const selection = selectedMarkdown(document.getSelection());
    const filePath = contextFilePath(event.target);
    const daemonId = filePath ? contextDaemonId(event.target) : undefined;
    if (!selection && !filePath) return;
    const noteAnchor = selection
      ? contextNoteAnchor(event, document.getSelection())
      : null;
    const items = buildContextMenuItemsForTargets(
      {
        markdownSelection: !!selection,
        noteAnchor: !!noteAnchor,
        filePath: !!filePath,
        fileManagerName: platformFileManagerName(),
      },
      {
        copyMarkdown: () => {
          if (activeSelection) copyText(noteBodyFromSelection(activeSelection));
        },
        moveToNote: () => {
          if (activeSelection && activeContextEvent && noteAnchor) {
            moveSelectionToNote(activeContextEvent, activeSelection, noteAnchor);
          }
        },
        openFile: filePath ? () => openFile(filePath, daemonId) : undefined,
        openInFileManager: filePath
          ? () => revealFile(filePath, daemonId)
          : undefined,
      },
    );
    if (items.length === 0) return;
    event.preventDefault();
    show(event, items, selection ?? undefined);
  };
  const onCopy = (event: ClipboardEvent) => {
    if (event.defaultPrevented || isEditableTarget(event.target)) return;
    const selection = selectedMarkdown(document.getSelection());
    if (!selection) return;
    if (event.clipboardData) {
      writeMarkdownSelectionToClipboardData(event.clipboardData, selection);
    } else {
      copyText(noteBodyFromSelection(selection));
    }
    event.preventDefault();
    close();
  };
  const onPointerDown = (event: PointerEvent) => {
    if (menu?.contains(event.target as Node | null)) return;
    close();
  };
  const onKeyDown = (event: KeyboardEvent) => {
    if (event.key === "Escape") close();
  };

  document.addEventListener("contextmenu", onContextMenu);
  document.addEventListener("copy", onCopy);
  document.addEventListener("pointerdown", onPointerDown, true);
  document.addEventListener("keydown", onKeyDown);
  window.addEventListener("scroll", close, true);
  window.addEventListener("resize", close);

  return () => {
    close();
    document.removeEventListener("contextmenu", onContextMenu);
    document.removeEventListener("copy", onCopy);
    document.removeEventListener("pointerdown", onPointerDown, true);
    document.removeEventListener("keydown", onKeyDown);
    window.removeEventListener("scroll", close, true);
    window.removeEventListener("resize", close);
  };
}
