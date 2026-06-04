import { apiUrl } from "./api";
import {
  isLikelyMissingStickerToken,
  stickerTokenLabel,
} from "./sticker-packs-core";

export const LARGE_PASTE_CHAR_THRESHOLD = 1000;
export const TEXT_ATTACHMENT_PREVIEW_LINE_LIMIT = 7;
export const INLINE_ATTACHMENT_DRAG_MIME =
  "application/x-supergit-inline-attachment+json";
export const LINK_TARGET_DRAG_MIME = "application/x-supergit-link-target+json";
export const SESSION_LINK_DRAG_MIME =
  "application/x-supergit-session-link+json";
/** Dragging an emoji/sticker out of the picker carries its token here so
 *  the notes layer can drop it as a sticky at the cursor. Plain token. */
export const STICKER_DRAG_MIME = "application/x-supergit-sticker+plain";
export const STAGE_PROMPT_EVENT = "supergit:stage-prompt";

const ATTACHMENT_LINK_RE =
  /\[((?:\\.|[^\]\n])*)\]\(supergit:\/\/attachment\/([A-Za-z0-9_-]+)\)/g;

export interface AttachmentSource {
  kind: "clipboard" | "drop" | "copy";
  types?: string[];
  filename?: string;
}

export interface TextInlineAttachment {
  kind: "text";
  path: string;
  filename?: string;
  mimeType?: string;
  size?: number;
  charCount: number;
  lineCount?: number;
  previewLines?: string[];
  source?: AttachmentSource;
}

export interface ImageInlineAttachment {
  kind: "image";
  path: string;
  filename?: string;
  mimeType?: string;
  size?: number;
  hasAlpha?: boolean;
  source?: AttachmentSource;
}

export interface NoteInlineAttachment {
  kind: "note";
  body: string;
}

export interface EmojiInlineAttachment {
  kind: "emoji";
  body: string;
}

export interface InlineLinkTarget {
  type: "url" | "commit" | "session" | "file" | "command";
  value: string;
  label?: string;
  subtitle?: string;
  meta?: string;
  agent?: string;
  provider?: string;
  repoId?: string;
  cwd?: string;
  command?: string;
  runMode?: "internal" | "external" | "shell";
}

export interface LinkInlineAttachment {
  kind: "link";
  target: InlineLinkTarget;
}

export interface CommandLinkSnapshot {
  id: string;
  kind?: string;
  cmd?: string;
  cwd?: string;
  runMode?: "internal" | "external" | "shell";
  name?: string;
}

export interface CommandLinkRepo {
  id: string;
  customLinks?: CommandLinkSnapshot[];
}

export type InlineAttachment =
  | TextInlineAttachment
  | ImageInlineAttachment
  | NoteInlineAttachment
  | EmojiInlineAttachment
  | LinkInlineAttachment;

export type InlineAttachmentPart =
  | { kind: "text"; text: string }
  | { kind: "attachment"; raw: string; attachment: InlineAttachment };

export interface TerminalPasteExpansionOptions {
  omitTargetSessionSource?: string;
}

export interface InlineAttachmentEditRef {
  placeholder: string;
  raw: string;
}

export interface NoteClipboardPayload {
  type: "supergit-note";
  id?: string;
  body: string;
  text: string;
  copiedAt: string;
  attachments: InlineAttachment[];
}

export interface CodexComposerDropPayload {
  text: string;
  attachments: ImageInlineAttachment[];
}

export function shouldAttachPastedText(text: string): boolean {
  return Array.from(text).length > LARGE_PASTE_CHAR_THRESHOLD;
}

export function countTextLines(text: string): number {
  if (text.length === 0) return 0;
  return text.split(/\r\n|\r|\n/).length;
}

export function inferPastedTextMimeType(
  text: string,
  sourceTypes: string[] = [],
): string {
  // Lightweight stopgap: good enough for attachment titles, but not
  // a real language detector. Replace this with Monaco, Shiki, or a
  // similar proven estimator once pasted snippets need richer typing.
  const lowerTypes = sourceTypes.map((type) => type.toLowerCase());
  const explicit = lowerTypes.find(
    (type) =>
      type.includes("javascript") ||
      type.includes("ecmascript") ||
      type.includes("typescript") ||
      type.includes("markdown") ||
      type.includes("json") ||
      type.includes("xml") ||
      type === "text/css",
  );
  if (explicit) return explicit;

  const trimmed = text.trim();
  if (trimmed) {
    if (
      (trimmed.startsWith("{") && trimmed.endsWith("}")) ||
      (trimmed.startsWith("[") && trimmed.endsWith("]"))
    ) {
      try {
        JSON.parse(trimmed);
        return "application/json";
      } catch {}
    }
    if (
      /^```/m.test(text) ||
      /^#{1,6}\s+\S/m.test(text) ||
      /^\s*[-*]\s+\S/m.test(text)
    ) {
      return "text/markdown";
    }
    if (/^\s*<([a-z][\w:-]*)(\s|>|\/>)/i.test(text)) {
      return "text/html";
    }
  }
  return "text/plain";
}

export function pastedTextFilenameForMime(mimeType: string): string {
  const mime = mimeType.toLowerCase();
  if (mime.includes("javascript") || mime.includes("ecmascript"))
    return "pasted-content.js";
  if (mime.includes("typescript")) return "pasted-content.ts";
  if (mime.includes("html")) return "pasted-content.html";
  if (mime.includes("css")) return "pasted-content.css";
  if (mime.includes("json")) return "pasted-content.json";
  if (mime.includes("markdown")) return "pasted-content.md";
  if (mime.includes("xml")) return "pasted-content.xml";
  return "pasted-content.txt";
}

export function pastedTextTitleForMime(mimeType?: string): string {
  const mime = (mimeType ?? "text/plain").toLowerCase();
  if (mime.includes("javascript") || mime.includes("ecmascript"))
    return "Pasted Javascript";
  if (mime.includes("typescript")) return "Pasted TypeScript";
  if (mime.includes("html")) return "Pasted HTML";
  if (mime.includes("css")) return "Pasted CSS";
  if (mime.includes("json")) return "Pasted JSON";
  if (mime.includes("markdown")) return "Pasted Markdown";
  if (mime.includes("xml")) return "Pasted XML";
  return "Pasted Text";
}

export function commandPowerLabel(target: InlineLinkTarget): string {
  const explicit = target.label?.trim();
  if (explicit) return explicit;
  const command = target.command?.trim();
  if (!command) return target.value || "command";
  return command;
}

export function commandPowerDisplay(
  target: InlineLinkTarget,
  live?: CommandLinkSnapshot | null,
): { label: string; subtitle: string } {
  const label = live?.name?.trim() || target.label?.trim();
  const command = live?.cmd?.trim() || target.command?.trim() || "";
  if (label) {
    return {
      label,
      subtitle: command && command !== label ? command : "",
    };
  }
  return {
    label: command || target.value || "command",
    subtitle: "",
  };
}

export function commandRunText(target: InlineLinkTarget): string {
  return target.command?.trim() || target.label?.trim() || target.value;
}

export function shellQuote(value: string): string {
  if (/^[A-Za-z0-9_./:@%+=,-]+$/.test(value)) return value;
  return `'${value.replace(/'/g, `'\\''`)}'`;
}

export function commandCopyText(
  target: InlineLinkTarget,
  live?: CommandLinkSnapshot | null,
): string {
  const command = live?.cmd?.trim() || commandRunText(target);
  const cwd = live?.cwd?.trim() || target.cwd?.trim();
  if (!cwd) return command;
  return `cd ${shellQuote(cwd)} && ${command}`;
}

export interface CommandUrlSatellite {
  host: string;
  port: string;
  isLocalhost: boolean;
}

function normalizeCommandUrlHost(host: string): string {
  const withoutWww = host.replace(/^www\./, "");
  if (withoutWww.startsWith("[") && withoutWww.endsWith("]")) {
    return withoutWww.slice(1, -1);
  }
  return withoutWww;
}

function isLocalCommandUrlHost(host: string): boolean {
  return host === "localhost" || host === "127.0.0.1" || host === "::1";
}

export function commandUrlSatellite(url: string): CommandUrlSatellite {
  try {
    const parsed = new URL(url);
    const host = normalizeCommandUrlHost(parsed.hostname);
    return {
      host,
      port: parsed.port,
      isLocalhost: isLocalCommandUrlHost(host),
    };
  } catch {
    const fallback = url
      .trim()
      .match(/^[A-Za-z][A-Za-z0-9+.-]*:\/\/(\[[^\]]+\]|[^/?#:]+)(?::(\d+))?/);
    if (fallback?.[1]) {
      const host = normalizeCommandUrlHost(fallback[1]);
      return {
        host,
        port: fallback[2] ?? "",
        isLocalhost: isLocalCommandUrlHost(host),
      };
    }
    return { host: "url", port: "", isLocalhost: false };
  }
}

export function resolveLiveCommandLink(
  target: InlineLinkTarget | undefined,
  repos: readonly CommandLinkRepo[],
): { repo: CommandLinkRepo; link: CommandLinkSnapshot } | null {
  if (target?.type !== "command") return null;
  const pinnedRepo = target.repoId
    ? repos.find((repo) => repo.id === target.repoId)
    : undefined;
  const candidateRepos = pinnedRepo ? [pinnedRepo] : repos;
  const command = target.command?.trim();
  const label = target.label?.trim();
  for (const repo of candidateRepos) {
    const links = (repo.customLinks ?? []).filter(
      (link) => link.kind === "command",
    );
    const byId = links.find((link) => link.id === target.value);
    if (byId) return { repo, link: byId };
    if (command) {
      const byCommand = links.find((link) => link.cmd?.trim() === command);
      if (byCommand) return { repo, link: byCommand };
    }
    if (label) {
      const byLabel = links.find(
        (link) => link.name?.trim() === label || link.cmd?.trim() === label,
      );
      if (byLabel) return { repo, link: byLabel };
    }
  }
  return null;
}

export function humanAttachmentBytes(bytes: number): string {
  const units = ["B", "KB", "MB", "GB"];
  let value = bytes;
  let unit = 0;
  while (value >= 1024 && unit < units.length - 1) {
    value /= 1024;
    unit++;
  }
  return `${value >= 10 || unit === 0 ? Math.round(value) : value.toFixed(1)} ${units[unit]}`;
}

export function textAttachmentMeta(
  attachment: TextInlineAttachment,
  stats?: { lineCount?: number; charCount?: number },
): string {
  const lineCount =
    typeof attachment.lineCount === "number"
      ? attachment.lineCount
      : stats?.lineCount;
  const lines =
    typeof lineCount === "number"
      ? `${lineCount.toLocaleString()} ${lineCount === 1 ? "line" : "lines"}`
      : "";
  if (typeof attachment.size === "number") {
    const size = humanAttachmentBytes(attachment.size);
    return lines ? `${lines}, ${size}` : size;
  }
  if (lines) return lines;
  const charCount = stats?.charCount ?? attachment.charCount;
  return `${charCount.toLocaleString()} chars`;
}

export function textAttachmentPreviewLines(
  text: string,
  maxLines = TEXT_ATTACHMENT_PREVIEW_LINE_LIMIT,
): string[] {
  const lines = text.replace(/\r\n?/g, "\n").split("\n");
  while (lines.length > 0 && !lines[0]!.trim()) lines.shift();
  const preview = lines
    .slice(0, maxLines)
    .map((line) => line.replace(/\t/g, "  ").trimEnd().slice(0, 160));
  return preview.some((line) => line.trim()) ? preview : ["(empty)"];
}

export function makeTextAttachmentRef(
  input: {
    path: string;
    filename?: string;
    mimeType?: string;
    size?: number;
    charCount: number;
    lineCount?: number;
    previewLines?: string[];
     source?: AttachmentSource;
   },
): string {
  return makeAttachmentRef({
    kind: "text",
    path: input.path,
    ...(input.filename ? { filename: input.filename } : {}),
    ...(input.mimeType ? { mimeType: input.mimeType } : {}),
    ...(typeof input.size === "number" ? { size: input.size } : {}),
    charCount: input.charCount,
    ...(typeof input.lineCount === "number" ? { lineCount: input.lineCount } : {}),
    ...(input.previewLines
      ? { previewLines: input.previewLines.slice(0, TEXT_ATTACHMENT_PREVIEW_LINE_LIMIT) }
      : {}),
    ...(input.source ? { source: input.source } : {}),
  });
}

export function makeImageAttachmentRef(input: {
  path: string;
  filename?: string;
  mimeType?: string;
  size?: number;
  hasAlpha?: boolean;
  source?: AttachmentSource;
}): string {
  return makeAttachmentRef({
    kind: "image",
    path: input.path,
    ...(input.filename ? { filename: input.filename } : {}),
    ...(input.mimeType ? { mimeType: input.mimeType } : {}),
    ...(typeof input.size === "number" ? { size: input.size } : {}),
    ...(input.hasAlpha ? { hasAlpha: true } : {}),
    ...(input.source ? { source: input.source } : {}),
  });
}

export function makeNoteAttachmentRef(input: { body: string }): string {
  return makeAttachmentRef({ kind: "note", body: input.body });
}

export function makeEmojiAttachmentRef(input: { body: string }): string {
  return makeAttachmentRef({ kind: "emoji", body: input.body });
}

export function makeLinkAttachmentRef(input: {
  target: InlineLinkTarget;
}): string {
  return makeAttachmentRef({ kind: "link", target: input.target });
}

export function parseInlineAttachments(body: string): InlineAttachmentPart[] {
  const parts: InlineAttachmentPart[] = [];
  const matches = attachmentMatches(body);
  let last = 0;
  for (const match of matches) {
    if (match.start < last) continue;
    if (match.start > last)
      parts.push({ kind: "text", text: body.slice(last, match.start) });
    parts.push({
      kind: "attachment",
      raw: match.raw,
      attachment: match.attachment,
    });
    last = match.start + match.raw.length;
  }
  if (last < body.length) parts.push({ kind: "text", text: body.slice(last) });
  return parts.length > 0 ? parts : [{ kind: "text", text: body }];
}

export function trailingVisualAttachmentIndexes(
  parts: readonly InlineAttachmentPart[],
): Set<number> {
  const indexes: number[] = [];
  for (let i = parts.length - 1; i >= 0; i--) {
    const part = parts[i];
    if (!part) break;
    if (part.kind === "text") {
      if (part.text.trim() === "") continue;
      break;
    }
    if (part.attachment.kind === "image" || part.attachment.kind === "emoji") {
      indexes.push(i);
      continue;
    }
    if (indexes.length > 0) break;
    break;
  }
  return new Set(indexes.reverse());
}

export const trailingImageAttachmentIndexes = trailingVisualAttachmentIndexes;

export function visualAttachmentIndexes(
  parts: readonly InlineAttachmentPart[],
): Set<number> {
  const indexes: number[] = [];
  parts.forEach((part, i) => {
    if (
      part.kind === "attachment" &&
      (part.attachment.kind === "image" ||
        part.attachment.kind === "text" ||
        part.attachment.kind === "emoji" ||
        part.attachment.kind === "note" ||
        part.attachment.kind === "link")
    ) {
      indexes.push(i);
    }
  });
  return new Set(indexes);
}

export function standaloneAttachmentKind(
  body: string,
): InlineAttachment["kind"] | null {
  const parts = parseInlineAttachments(body);
  const part = parts.length === 1 ? parts[0] : null;
  return part?.kind === "attachment" ? part.attachment.kind : null;
}

export function removeInlineAttachmentRef(body: string, raw: string): string {
  if (!raw) return body;
  const parts = parseInlineAttachments(body);
  let removed = false;
  return parts
    .map((part) => {
      if (!removed && part.kind === "attachment" && part.raw === raw) {
        removed = true;
        return "";
      }
      return part.kind === "text" ? part.text : part.raw;
    })
    .join("");
}

export function singleInlineAttachmentPart(
  body: string,
): Extract<InlineAttachmentPart, { kind: "attachment" }> | null {
  let found: Extract<InlineAttachmentPart, { kind: "attachment" }> | null = null;
  for (const part of parseInlineAttachments(body)) {
    if (part.kind === "text") {
      if (part.text.trim()) return null;
      continue;
    }
    if (found) return null;
    found = part;
  }
  return found;
}

export function moveInlineAttachmentRefToEnd(body: string, raw: string): string {
  const without = removeInlineAttachmentRef(body, raw);
  if (without === body) return body;
  return appendInlineAttachmentRef(without, raw);
}

export function moveInlineAttachmentRefBefore(
  body: string,
  raw: string,
  beforeRaw: string,
): string {
  if (!raw || !beforeRaw || raw === beforeRaw) return body;
  const without = removeInlineAttachmentRef(body, raw);
  if (without === body) return body;
  const parts = parseInlineAttachments(without);
  let inserted = false;
  const moved = parts
    .map((part) => {
      if (part.kind === "attachment" && part.raw === beforeRaw) {
        inserted = true;
        return `${raw}${part.raw}`;
      }
      return part.kind === "text" ? part.text : part.raw;
    })
    .join("");
  return inserted ? moved : appendInlineAttachmentRef(without, raw);
}

export function appendInlineAttachmentRef(body: string, raw: string): string {
  const sep = body && !body.endsWith("\n") ? "\n" : "";
  return `${body}${sep}${raw}`;
}

export function codexAppInputFromComposer(
  text: string,
  attachments: readonly InlineAttachment[] = [],
): Record<string, unknown>[] {
  const input: Record<string, unknown>[] = [
    { type: "text", text, text_elements: [] },
  ];
  const seen = new Set<string>();
  const appendImage = (path: string) => {
    const trimmed = path.trim();
    if (!trimmed || seen.has(trimmed)) return;
    seen.add(trimmed);
    input.push({ type: "localImage", path: trimmed });
  };

  const imageRe =
    /\[Image:\s*source:\s*([^\]]+?\.(?:png|jpe?g|gif|webp|svg|bmp))\s*\]/gi;
  let match: RegExpExecArray | null;
  while ((match = imageRe.exec(text)) !== null) {
    appendImage(match[1] ?? "");
  }
  for (const attachment of attachments) {
    if (attachment.kind === "image") appendImage(attachment.path);
  }
  return input;
}

export function codexComposerDropPayloadFromNoteBody(
  body: string,
): CodexComposerDropPayload {
  const textChunks: string[] = [];
  const attachments: ImageInlineAttachment[] = [];
  const seenImages = new Set<string>();
  const appendImage = (attachment: ImageInlineAttachment) => {
    const path = attachment.path.trim();
    if (!path || seenImages.has(path)) return;
    seenImages.add(path);
    attachments.push({ ...attachment, path });
  };

  for (const part of parseInlineAttachments(body)) {
    if (part.kind === "text") {
      textChunks.push(part.text);
    } else if (part.attachment.kind === "image") {
      appendImage(part.attachment);
    } else if (part.attachment.kind === "note") {
      const nested = codexComposerDropPayloadFromNoteBody(part.attachment.body);
      textChunks.push(nested.text);
      for (const image of nested.attachments) appendImage(image);
    } else {
      textChunks.push(inlineAttachmentCopyText(part.attachment));
    }
  }

  return {
    text: textChunks.join("").trim(),
    attachments,
  };
}

export function codexComposerDropPayloadFromInlineAttachment(
  attachment: InlineAttachment,
): CodexComposerDropPayload {
  if (attachment.kind === "image") {
    return { text: "", attachments: [{ ...attachment }] };
  }
  if (attachment.kind === "note") {
    return codexComposerDropPayloadFromNoteBody(attachment.body);
  }
  return { text: inlineAttachmentCopyText(attachment).trim(), attachments: [] };
}

export function expandNoteBodyForCopy(body: string): string {
  return parseInlineAttachments(body)
    .map((part) => {
      if (part.kind === "text") return part.text;
      return inlineAttachmentCopyText(part.attachment);
    })
    .join("");
}

export async function expandNoteBodyForCopyAsync(
  body: string,
  readTextAttachment: (path: string) => Promise<string>,
): Promise<string> {
  const chunks: string[] = [];
  for (const part of parseInlineAttachments(body)) {
    if (part.kind === "text") {
      chunks.push(part.text);
    } else if (part.attachment.kind === "text") {
      chunks.push(await readTextAttachment(part.attachment.path));
    } else if (part.attachment.kind === "image") {
      chunks.push(part.attachment.path);
    } else {
      chunks.push(inlineAttachmentCopyText(part.attachment));
    }
  }
  return chunks.join("");
}

export async function expandNoteBodyForTerminalPasteChunks(
  body: string,
  readTextAttachment: (path: string) => Promise<string>,
  opts: TerminalPasteExpansionOptions = {},
): Promise<string[]> {
  const chunks: string[] = [];
  let text = "";
  let skipNextLeadingNewline = false;
  const flushText = () => {
    if (!text) return;
    chunks.push(text);
    text = "";
  };

  for (const part of parseInlineAttachments(body)) {
    if (part.kind === "text") {
      const nextText =
        skipNextLeadingNewline && text.endsWith("\n")
          ? part.text.replace(/^\r?\n/, "")
          : part.text;
      skipNextLeadingNewline = false;
      text += nextText;
    } else if (part.attachment.kind === "text") {
      skipNextLeadingNewline = false;
      flushText();
      chunks.push(await readTextAttachment(part.attachment.path));
    } else if (part.attachment.kind === "image") {
      skipNextLeadingNewline = false;
      flushText();
      chunks.push(part.attachment.path);
    } else if (part.attachment.kind === "emoji") {
      continue;
    } else if (shouldOmitFromTerminalPaste(part.attachment, opts)) {
      skipNextLeadingNewline = true;
      continue;
    } else {
      skipNextLeadingNewline = false;
      text += inlineAttachmentCopyText(part.attachment);
    }
  }
  flushText();
  return chunks;
}

function shouldOmitFromTerminalPaste(
  attachment: InlineAttachment,
  opts: TerminalPasteExpansionOptions,
): boolean {
  return (
    attachment.kind === "link" &&
    attachment.target.type === "session" &&
    sessionLinkTargetMatchesSource(
      attachment.target,
      opts.omitTargetSessionSource,
    )
  );
}

export function sessionLinkTargetMatchesSource(
  target: InlineLinkTarget,
  source?: string,
): boolean {
  if (target.type !== "session" || !source) return false;
  if (target.value === source) return true;
  const sourceBasename = source
    .split("/")
    .pop()
    ?.replace(/\.jsonl$/i, "");
  return !!sourceBasename && target.value === sourceBasename;
}

/** Normalize a session-link value to the bare session id. The value
 *  may be a full JSONL source path (`/repo/.../<id>.jsonl`, what older
 *  dragged-session attachments stored) or already the bare id. We key
 *  session links on the id rather than the path so the link survives
 *  the worktree/repo being renamed or moved — the path changes, the
 *  id baked into the JSONL filename doesn't. */
export function sessionIdFromValue(value: string): string {
  const match = value.match(/\/([^/]+?)\.jsonl$/i);
  if (match?.[1]) return match[1];
  const base = value.split("/").pop() ?? value;
  return base.replace(/\.jsonl$/i, "");
}

export interface SessionAgentRef {
  source: string;
  sessionId?: string;
}

/** Resolve a stored session-link value (a bare id OR a possibly-stale
 *  full path) to the matching live agent from the current snapshot.
 *  Match priority: the daemon's authoritative `sessionId`, then a
 *  source path ending in `<id>.jsonl` (sessions whose `sessionId`
 *  isn't populated yet), then an exact source-path match (legacy
 *  attachments that stored the full path as the value). Returns null
 *  when nothing matches — the session is gone or not loaded yet. */
export function resolveSessionAgent<T extends SessionAgentRef>(
  value: string,
  agents: readonly T[],
): T | null {
  const id = sessionIdFromValue(value);
  const suffix = `/${id}.jsonl`;
  return (
    agents.find((a) => a.sessionId === id) ??
    agents.find((a) => a.source.endsWith(suffix)) ??
    agents.find((a) => a.source === value) ??
    null
  );
}

export async function fetchTextAttachment(
  path: string,
  daemonId?: string,
): Promise<string> {
  const res = await fetch(
    apiUrl(`/api/attachment?path=${encodeURIComponent(path)}`, daemonId),
  );
  if (!res.ok) throw new Error(`attachment read failed: ${res.status}`);
  return res.text();
}

export async function fetchTextAttachmentPreview(path: string): Promise<string> {
  const res = await fetch(`/api/attachment/preview?path=${encodeURIComponent(path)}`);
  if (!res.ok) throw new Error(`attachment preview read failed: ${res.status}`);
  return res.text();
}

export function inlineAttachmentLabel(attachment: InlineAttachment): string {
  if (attachment.kind === "text") {
    return `Pasted Content, ${attachment.charCount} chars`;
  }
  if (attachment.kind === "image") {
    return (
      attachment.filename ??
      attachment.path.split("/").pop() ??
      "Image attachment"
    );
  }
  if (attachment.kind === "emoji") {
    return (
      stickerTokenLabel(attachment.body) ??
      (isLikelyMissingStickerToken(attachment.body)
        ? `Missing sticker: ${attachment.body}`
        : attachment.body || "Emoji")
    );
  }
  if (attachment.kind === "note") {
    const firstLine = attachment.body.trim().split(/\r?\n/)[0]?.trim();
    return firstLine ? `Note: ${firstLine.slice(0, 40)}` : "Note";
  }
  if (attachment.target.type === "command") {
    return (
      attachment.target.label ??
      attachment.target.command ??
      attachment.target.value
    );
  }
  return attachment.target.label ?? attachment.target.value;
}

export function attachmentMediaTitle(attachment: InlineAttachment): string {
  if (attachment.kind === "image") {
    return (
      attachment.filename ??
      attachment.path.split("/").pop() ??
      "Image attachment"
    );
  }
  if (attachment.kind === "text") {
    return attachment.filename ?? inlineAttachmentLabel(attachment);
  }
  return "";
}

export function noteBodyToEditText(
  body: string,
  opts: {
    existingRefs?: InlineAttachmentEditRef[];
    usedText?: string;
  } = {},
): { text: string; refs: InlineAttachmentEditRef[] } {
  let usedText = opts.usedText ?? "";
  const refs: InlineAttachmentEditRef[] = [];
  const existingRefs = opts.existingRefs ?? [];
  const text = parseInlineAttachments(body)
    .map((part) => {
      if (part.kind === "text") {
        usedText += part.text;
        return part.text;
      }
      if (part.attachment.kind !== "emoji") {
        usedText += part.raw;
        return part.raw;
      }
      const base = `[${part.attachment.body || "Emoji"}]`;
      const placeholder = uniqueEditPlaceholder(base, usedText, existingRefs, refs);
      refs.push({ placeholder, raw: part.raw });
      usedText += placeholder;
      return placeholder;
    })
    .join("");
  return { text, refs };
}

export function restoreEditTextAttachments(
  text: string,
  refs: InlineAttachmentEditRef[],
): string {
  let body = text;
  for (const ref of refs) {
    body = body.replace(ref.placeholder, ref.raw);
  }
  return body;
}

function uniqueEditPlaceholder(
  base: string,
  usedText: string,
  existingRefs: InlineAttachmentEditRef[],
  refs: InlineAttachmentEditRef[],
): string {
  let placeholder = base;
  let suffix = 2;
  const hasPlaceholder = (value: string) =>
    usedText.includes(value) ||
    existingRefs.some((ref) => ref.placeholder === value) ||
    refs.some((ref) => ref.placeholder === value);
  while (hasPlaceholder(placeholder)) {
    placeholder = `${base.slice(0, -1)} #${suffix++}]`;
  }
  return placeholder;
}

export function makeNoteClipboardPayload(input: {
  id?: string;
  body: string;
  text?: string;
  copiedAt?: string;
}): NoteClipboardPayload {
  return {
    type: "supergit-note",
    ...(input.id ? { id: input.id } : {}),
    body: input.body,
    text: input.text ?? expandNoteBodyForCopy(input.body),
    copiedAt: input.copiedAt ?? new Date().toISOString(),
    attachments: parseInlineAttachments(input.body)
      .filter(
        (part): part is Extract<InlineAttachmentPart, { kind: "attachment" }> =>
          part.kind === "attachment",
      )
      .map((part) => part.attachment),
  };
}

export function makeNoteClipboardHtml(
  payload: NoteClipboardPayload,
  visibleText: string,
): string {
  return `<span data-supergit-note="${encodeBase64Url(JSON.stringify(payload))}">${escapeHtml(visibleText)}</span>`;
}

export function extractNoteClipboardPayloadFromHtml(
  html: string,
): NoteClipboardPayload | null {
  const match = html.match(/\bdata-supergit-note="([^"]+)"/);
  if (!match) return null;
  try {
    const value = JSON.parse(decodeBase64Url(match[1]!)) as unknown;
    if (!value || typeof value !== "object") return null;
    const obj = value as Record<string, unknown>;
    if (obj.type !== "supergit-note" || typeof obj.body !== "string")
      return null;
    return makeNoteClipboardPayload({
      ...(typeof obj.id === "string" ? { id: obj.id } : {}),
      body: obj.body,
      text: typeof obj.text === "string" ? obj.text : undefined,
      copiedAt: typeof obj.copiedAt === "string" ? obj.copiedAt : undefined,
    });
  } catch {
    return null;
  }
}

function makeAttachmentRef(attachment: InlineAttachment): string {
  const payload = encodeBase64Url(JSON.stringify(attachment));
  return `[${escapeMarkdownLabel(inlineAttachmentLabel(attachment))}](supergit://attachment/${payload})`;
}

function attachmentMatches(body: string): Array<{
  start: number;
  raw: string;
  attachment: InlineAttachment;
}> {
  const matches: Array<{
    start: number;
    raw: string;
    attachment: InlineAttachment;
  }> = [];
  for (const match of body.matchAll(ATTACHMENT_LINK_RE)) {
    const attachment = parseAttachmentPayload(match[2]!);
    if (attachment) {
      matches.push({ start: match.index ?? 0, raw: match[0]!, attachment });
    }
  }
  return matches.sort((a, b) => a.start - b.start);
}

function parseAttachmentPayload(payload: string): InlineAttachment | null {
  try {
    const value = JSON.parse(decodeBase64Url(payload)) as unknown;
    if (!value || typeof value !== "object") return null;
    const obj = value as Record<string, unknown>;
    const source = parseSource(obj.source);
    if (obj.kind === "text" && typeof obj.path === "string" && obj.path) {
      const charCount = typeof obj.charCount === "number" ? obj.charCount : 0;
      return {
        kind: "text",
        path: obj.path,
        ...(typeof obj.filename === "string" && obj.filename
          ? { filename: obj.filename }
          : {}),
        ...(typeof obj.mimeType === "string" && obj.mimeType
          ? { mimeType: obj.mimeType }
          : {}),
        ...(typeof obj.size === "number" ? { size: obj.size } : {}),
        charCount,
        ...(typeof obj.lineCount === "number" ? { lineCount: obj.lineCount } : {}),
        ...(Array.isArray(obj.previewLines)
          ? {
              previewLines: obj.previewLines
                .filter((x): x is string => typeof x === "string")
                .slice(0, TEXT_ATTACHMENT_PREVIEW_LINE_LIMIT),
            }
          : {}),
        ...(source ? { source } : {}),
      };
    }
    if (obj.kind === "image" && typeof obj.path === "string" && obj.path) {
      return {
        kind: "image",
        path: obj.path,
        ...(typeof obj.filename === "string" && obj.filename
          ? { filename: obj.filename }
          : {}),
        ...(typeof obj.mimeType === "string" && obj.mimeType
          ? { mimeType: obj.mimeType }
          : {}),
        ...(typeof obj.size === "number" ? { size: obj.size } : {}),
        ...(obj.hasAlpha === true ? { hasAlpha: true } : {}),
        ...(source ? { source } : {}),
      };
    }
    if (obj.kind === "note" && typeof obj.body === "string") {
      return { kind: "note", body: obj.body };
    }
    if (obj.kind === "emoji" && typeof obj.body === "string") {
      return { kind: "emoji", body: obj.body };
    }
    if (obj.kind === "link") {
      const target = parseLinkTarget(obj.target);
      if (target) return { kind: "link", target };
    }
  } catch {
    return null;
  }
  return null;
}

function parseLinkTarget(value: unknown): InlineLinkTarget | null {
  if (!value || typeof value !== "object") return null;
  const obj = value as Record<string, unknown>;
  if (
    obj.type !== "url" &&
    obj.type !== "commit" &&
    obj.type !== "session" &&
    obj.type !== "file" &&
    obj.type !== "command"
  ) {
    return null;
  }
  if (typeof obj.value !== "string" || obj.value.length === 0) return null;
  return {
    type: obj.type,
    value: obj.value,
    ...(typeof obj.label === "string" ? { label: obj.label } : {}),
    ...(typeof obj.subtitle === "string" ? { subtitle: obj.subtitle } : {}),
    ...(typeof obj.meta === "string" ? { meta: obj.meta } : {}),
    ...(typeof obj.agent === "string" ? { agent: obj.agent } : {}),
    ...(typeof obj.provider === "string" ? { provider: obj.provider } : {}),
    ...(typeof obj.repoId === "string" ? { repoId: obj.repoId } : {}),
    ...(typeof obj.cwd === "string" ? { cwd: obj.cwd } : {}),
    ...(typeof obj.command === "string" ? { command: obj.command } : {}),
    ...(obj.runMode === "internal" ||
    obj.runMode === "external" ||
    obj.runMode === "shell"
      ? { runMode: obj.runMode }
      : {}),
  };
}

function inlineAttachmentCopyText(attachment: InlineAttachment): string {
  switch (attachment.kind) {
    case "text":
    case "image":
      return attachment.path;
    case "note":
    case "emoji":
      return attachment.body;
    case "link":
      if (attachment.target.type === "session") {
        return `Session: ${attachment.target.value}`;
      }
      if (attachment.target.type === "command") {
        return `Command: ${attachment.target.command ?? attachment.target.label ?? attachment.target.value}`;
      }
      return attachment.target.label ?? attachment.target.value;
  }
}

function parseSource(value: unknown): AttachmentSource | undefined {
  if (!value || typeof value !== "object") return undefined;
  const obj = value as Record<string, unknown>;
  if (obj.kind !== "clipboard" && obj.kind !== "drop" && obj.kind !== "copy") {
    return undefined;
  }
  return {
    kind: obj.kind,
    ...(Array.isArray(obj.types)
      ? { types: obj.types.filter((x): x is string => typeof x === "string") }
      : {}),
    ...(typeof obj.filename === "string" && obj.filename
      ? { filename: obj.filename }
      : {}),
  };
}

function encodeBase64Url(s: string): string {
  let binary = "";
  for (const byte of new TextEncoder().encode(s)) {
    binary += String.fromCharCode(byte);
  }
  return btoa(binary)
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=+$/g, "");
}

function decodeBase64Url(s: string): string {
  const padded = s
    .replace(/-/g, "+")
    .replace(/_/g, "/")
    .padEnd(Math.ceil(s.length / 4) * 4, "=");
  const binary = atob(padded);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  return new TextDecoder().decode(bytes);
}

function escapeHtml(s: string): string {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

function escapeMarkdownLabel(s: string): string {
  return s.replace(/\\/g, "\\\\").replace(/\]/g, "\\]");
}
