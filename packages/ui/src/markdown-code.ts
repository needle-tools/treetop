import type { MarkedExtension, Token } from "marked";
import { isLocalFileMarkdownHref } from "./open-url";

export function markdownSessionDirectiveExtension(): MarkedExtension {
  return { extensions: [{
    name: "sessionWriting",
    level: "block",
    start(source) { return source.indexOf(":::writing{"); },
    tokenizer(source) {
      const directive = sessionDirective(source, ":::writing");
      if (!directive || !/^\r?\n/.test(source.slice(directive.raw.length))) return;
      const { variant, id } = directive.attributes;
      if (!variant || !id) return;
      const bodyStart = directive.raw.length + (source[directive.raw.length] === "\r" ? 2 : 1);
      const tail = source.slice(bodyStart);
      let closing = tail.length;
      let consumed = tail.length;
      let fence = "";
      let offset = 0;
      for (const line of tail.split(/(?<=\n)/)) {
        const nextFence = /^\s*(`{3,}|~{3,})/.exec(line)?.[1];
        if (nextFence) {
          fence = fence && nextFence[0] === fence[0] && nextFence.length >= fence.length ? "" : fence || nextFence;
        } else if (!fence && /^:::[ \t]*(?:\r?\n)?$/.test(line)) {
          closing = offset;
          consumed = offset + line.length;
          break;
        }
        offset += line.length;
      }
      const body = tail.slice(0, closing).trim();
      const sections: { label: string; body: string; tokens: Token[] }[] = [];
      let label = "";
      let content: string[] = [];
      fence = "";
      const flush = () => {
        const text = content.join("\n").trim();
        if (text) sections.push({ label, body: text, tokens: this.lexer.blockTokens(text) });
        content = [];
      };
      for (const line of body.split(/\r?\n/)) {
        const nextFence = /^\s*(`{3,}|~{3,})/.exec(line)?.[1];
        if (nextFence) fence = fence && nextFence[0] === fence[0] && nextFence.length >= fence.length ? "" : fence || nextFence;
        const tone = !fence && /^---tone\s+(.+)$/.exec(line);
        if (tone) { flush(); label = tone[1]!; }
        else content.push(line);
      }
      flush();
      return { type: "sessionWriting", raw: source.slice(0, bodyStart + consumed), attributes: directive.attributes, sections };
    },
    renderer(token) {
      const attributes = token.attributes as Record<string, string>;
      const variant = attributes.variant!.replace(/_/g, " ");
      const kind = { email: "Email", chat_message: "Message", social_post: "Post", document: "Document", standard: "Draft" }[attributes.variant!] ?? "Draft";
      const sections = token.sections as { label: string; body: string; tokens: Token[] }[];
      return sections.map(section => {
        const label = section.label || attributes.subject || kind;
        const metadata = [section.label ? attributes.subject : undefined,
          ...["recipient", "cc", "bcc"].flatMap(key => attributes[key] ? [`${key}: ${attributes[key]}`] : [])].filter(Boolean);
        const header = `<div class="md-code-head"><span class="md-code-lang">${escapeMarkdownCodeHtml(label)}</span><button type="button" class="md-code-copy" aria-label="Copy ${escapeMarkdownCodeHtml(variant)}">Copy</button></div>`;
        const details = metadata.length ? `<div class="md-directive-meta">${metadata.map(escapeMarkdownCodeHtml).join(" · ")}</div>` : "";
        return `<section class="md-code-frame md-writing-block" data-writing-body="${escapeMarkdownCodeHtml(section.body)}">${header}${details}<div class="md-directive-body">${this.parser.parse(section.tokens)}</div></section>`;
      }).join("\n");
    },
  }, {
    name: "sessionCodeComment",
    level: "block",
    start(source) { return source.indexOf("::code-comment{"); },
    tokenizer(source) {
      const directive = sessionDirective(source, "::code-comment");
      if (!directive?.attributes.title || !directive.attributes.body || !directive.attributes.file || !isLocalFileMarkdownHref(directive.attributes.file)) return;
      return { type: "sessionCodeComment", raw: directive.raw, attributes: directive.attributes,
        tokens: this.lexer.inlineTokens(directive.attributes.body) };
    },
    renderer(token) {
      const attributes = token.attributes as Record<string, string>;
      const path = attributes.file!;
      const basename = path.replace(/\\/g, "/").split("/").pop() || path;
      const start = /^[1-9]\d*$/.test(attributes.start ?? "") ? attributes.start : undefined;
      const end = /^[1-9]\d*$/.test(attributes.end ?? "") ? attributes.end : start;
      const range = start ? `:${start}${end && end !== start ? `–${end}` : ""}` : "";
      const priority = /^[0-3]$/.test(attributes.priority ?? "") && !/^\[P[0-3]\]/.test(attributes.title!) ? `[P${attributes.priority}] ` : "";
      return `<section class="md-code-frame md-review-comment"><div class="md-code-head"><span class="md-code-lang">${escapeMarkdownCodeHtml(priority + attributes.title)}</span><a class="work-preview-path" href="${escapeMarkdownCodeHtml(path)}" data-supergit-file-href="${escapeMarkdownCodeHtml(path)}" title="${escapeMarkdownCodeHtml(path + range)}">${escapeMarkdownCodeHtml(basename + range)}</a></div><div class="md-directive-body">${this.parser.parseInline(token.tokens!)}</div></section>`;
    },
  }, {
    name: "sessionRealtimeInline",
    level: "block",
    start(source) { return source.indexOf("::codex-realtime-inline{}"); },
    tokenizer(source) {
      const match = /^::codex-realtime-inline\{\}[ \t]*(?:\r?\n|$)/.exec(source);
      if (match) return { type: "sessionRealtimeInline", raw: match[0] };
    },
    renderer() { return ""; },
  }, {
    name: "codexFileCitation",
    level: "inline",
    start(source) { return source.indexOf(":codex-file-citation{"); },
    tokenizer(source) {
      const directive = sessionDirective(source, ":codex-file-citation");
      if (!directive) return;
      const attributes = directive.attributes;
      if (!attributes.path || !isLocalFileMarkdownHref(attributes.path)) return;
      return { type: "codexFileCitation", raw: directive.raw, attributes };
    },
    renderer(token) {
      const attributes = token.attributes as Record<string, string>;
      const path = attributes.path!;
      const label = path.replace(/\\/g, "/").split("/").pop() || path;
      const title = [attributes.purpose, path, attributes.sheet, attributes.range].filter(Boolean).join(" · ");
      return `<a class="work-preview-path" href="${escapeMarkdownCodeHtml(path)}" data-supergit-file-href="${escapeMarkdownCodeHtml(path)}" title="${escapeMarkdownCodeHtml(title)}">${escapeMarkdownCodeHtml(label)}</a>`;
    },
  }] };
}

function sessionDirective(source: string, name: string): { raw: string; attributes: Record<string, string> } | undefined {
  if (!source.startsWith(name + "{")) return;
  const match = /^\{((?:[^}"']|"(?:\\.|[^"\\])*"|'(?:\\.|[^'\\])*')*)\}/.exec(source.slice(name.length));
  if (!match) return;
  const attributes: Record<string, string> = {};
  for (const attribute of match[1]!.matchAll(/([\w-]+)\s*=\s*("(?:\\.|[^"\\])*"|'(?:\\.|[^'\\])*'|\d+)/g)) {
    const literal = attribute[2]!;
    let value = /^['"]/.test(literal) ? literal.slice(1, -1) : literal;
    if (literal.startsWith('"')) {
      try { value = JSON.parse(literal); } catch { /* Preserve literal path backslashes. */ }
    }
    attributes[attribute[1]!] = value;
  }
  return { raw: name + match[0], attributes };
}

export function escapeMarkdownCodeHtml(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

export function markdownCodeLanguage(lang: string | null | undefined): string {
  const first = (lang ?? "").trim().split(/\s+/)[0]?.trim();
  return first || "text";
}

export function markdownCodeLanguageClass(lang: string): string {
  return lang.toLowerCase().replace(/[^a-z0-9#+.-]+/g, "-");
}

export function markdownCodeBlockHtml(
  code: string,
  lang: string | null | undefined,
): string {
  const label = markdownCodeLanguage(lang);
  if (label.toLowerCase() === "mermaid") {
    return `<div class="mermaid-diagram" role="img" aria-label="Mermaid diagram"><pre class="mermaid-source">${escapeMarkdownCodeHtml(code)}</pre></div>`;
  }
  const className = markdownCodeLanguageClass(label);
  const escapedLabel = escapeMarkdownCodeHtml(label);
  return `<div class="md-code-frame"><div class="md-code-head"><span class="md-code-lang">${escapedLabel}</span><button type="button" class="md-code-copy" aria-label="Copy ${escapedLabel} code">Copy</button></div><pre><code class="language-${escapeMarkdownCodeHtml(className)}">${escapeMarkdownCodeHtml(code)}</code></pre></div>`;
}
