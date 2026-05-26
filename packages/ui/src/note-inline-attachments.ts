export const LARGE_PASTE_CHAR_THRESHOLD = 1000;
export const INLINE_ATTACHMENT_DRAG_MIME =
  "application/x-supergit-inline-attachment+json";
export const SESSION_LINK_DRAG_MIME =
  "application/x-supergit-session-link+json";
export const STAGE_PROMPT_EVENT = "supergit:stage-prompt";

const ATTACHMENT_LINK_RE = /\[((?:\\.|[^\]\n])*)\]\(supergit:\/\/attachment\/([A-Za-z0-9_-]+)\)/g;

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
  source?: AttachmentSource;
}

export interface ImageInlineAttachment {
  kind: "image";
  path: string;
  filename?: string;
  mimeType?: string;
  size?: number;
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
  type: "url" | "commit" | "session" | "file";
  value: string;
  label?: string;
  subtitle?: string;
  meta?: string;
  agent?: string;
  provider?: string;
}

export interface LinkInlineAttachment {
  kind: "link";
  target: InlineLinkTarget;
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

export function shouldAttachPastedText(text: string): boolean {
  return Array.from(text).length > LARGE_PASTE_CHAR_THRESHOLD;
}

export function makeTextAttachmentRef(
  input: {
    path: string;
    filename?: string;
    mimeType?: string;
    size?: number;
    charCount: number;
    lineCount?: number;
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
    ...(input.source ? { source: input.source } : {}),
  });
}

export function makeImageAttachmentRef(input: {
  path: string;
  filename?: string;
  mimeType?: string;
  size?: number;
  source?: AttachmentSource;
}): string {
  return makeAttachmentRef({
    kind: "image",
    path: input.path,
    ...(input.filename ? { filename: input.filename } : {}),
    ...(input.mimeType ? { mimeType: input.mimeType } : {}),
    ...(typeof input.size === "number" ? { size: input.size } : {}),
    ...(input.source ? { source: input.source } : {}),
  });
}

export function makeNoteAttachmentRef(input: { body: string }): string {
  return makeAttachmentRef({ kind: "note", body: input.body });
}

export function makeEmojiAttachmentRef(input: { body: string }): string {
  return makeAttachmentRef({ kind: "emoji", body: input.body });
}

export function makeLinkAttachmentRef(input: { target: InlineLinkTarget }): string {
  return makeAttachmentRef({ kind: "link", target: input.target });
}

export function parseInlineAttachments(body: string): InlineAttachmentPart[] {
  const parts: InlineAttachmentPart[] = [];
  const matches = attachmentMatches(body);
  let last = 0;
  for (const match of matches) {
    if (match.start < last) continue;
    if (match.start > last) parts.push({ kind: "text", text: body.slice(last, match.start) });
    parts.push({ kind: "attachment", raw: match.raw, attachment: match.attachment });
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
): Promise<string[]> {
  const chunks: string[] = [];
  let text = "";
  const flushText = () => {
    if (!text) return;
    chunks.push(text);
    text = "";
  };

  for (const part of parseInlineAttachments(body)) {
    if (part.kind === "text") {
      text += part.text;
    } else if (part.attachment.kind === "text") {
      flushText();
      chunks.push(await readTextAttachment(part.attachment.path));
    } else if (part.attachment.kind === "image") {
      flushText();
      chunks.push(part.attachment.path);
    } else {
      text += inlineAttachmentCopyText(part.attachment);
    }
  }
  flushText();
  return chunks;
}

export async function fetchTextAttachment(path: string): Promise<string> {
  const res = await fetch(`/api/attachment?path=${encodeURIComponent(path)}`);
  if (!res.ok) throw new Error(`attachment read failed: ${res.status}`);
  return res.text();
}

export function inlineAttachmentLabel(attachment: InlineAttachment): string {
  if (attachment.kind === "text") {
    return `Pasted Content, ${attachment.charCount} chars`;
  }
  if (attachment.kind === "image") {
    return attachment.filename ?? attachment.path.split("/").pop() ?? "Image attachment";
  }
  if (attachment.kind === "emoji") return attachment.body || "Emoji";
  if (attachment.kind === "note") {
    const firstLine = attachment.body.trim().split(/\r?\n/)[0]?.trim();
    return firstLine ? `Note: ${firstLine.slice(0, 40)}` : "Note";
  }
  return attachment.target.label ?? attachment.target.value;
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
      const base = `[${inlineAttachmentLabel(part.attachment)}]`;
      const placeholder = uniquePlaceholder(base, usedText, existingRefs, refs);
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
      .filter((part): part is Extract<InlineAttachmentPart, { kind: "attachment" }> =>
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
    if (obj.type !== "supergit-note" || typeof obj.body !== "string") return null;
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
  const matches: Array<{ start: number; raw: string; attachment: InlineAttachment }> = [];
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
      const charCount =
        typeof obj.charCount === "number"
          ? obj.charCount
          : 0;
      return {
        kind: "text",
        path: obj.path,
        ...(typeof obj.filename === "string" && obj.filename ? { filename: obj.filename } : {}),
        ...(typeof obj.mimeType === "string" && obj.mimeType ? { mimeType: obj.mimeType } : {}),
        ...(typeof obj.size === "number" ? { size: obj.size } : {}),
        charCount,
        ...(typeof obj.lineCount === "number" ? { lineCount: obj.lineCount } : {}),
        ...(source ? { source } : {}),
      };
    }
    if (obj.kind === "image" && typeof obj.path === "string" && obj.path) {
      return {
        kind: "image",
        path: obj.path,
        ...(typeof obj.filename === "string" && obj.filename ? { filename: obj.filename } : {}),
        ...(typeof obj.mimeType === "string" && obj.mimeType ? { mimeType: obj.mimeType } : {}),
        ...(typeof obj.size === "number" ? { size: obj.size } : {}),
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
    obj.type !== "file"
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
    ...(typeof obj.filename === "string" && obj.filename ? { filename: obj.filename } : {}),
  };
}

function uniquePlaceholder(
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
    placeholder = `${base} #${suffix++}`;
  }
  return placeholder;
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
  const padded = s.replace(/-/g, "+").replace(/_/g, "/").padEnd(
    Math.ceil(s.length / 4) * 4,
    "=",
  );
  const binary = atob(padded);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  return new TextDecoder().decode(bytes);
}

function escapeHtml(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;");
}

function escapeMarkdownLabel(s: string): string {
  return s.replace(/\\/g, "\\\\").replace(/\]/g, "\\]");
}
