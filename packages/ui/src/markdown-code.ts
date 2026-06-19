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
  const className = markdownCodeLanguageClass(label);
  const escapedLabel = escapeMarkdownCodeHtml(label);
  return `<div class="md-code-frame"><div class="md-code-head"><span class="md-code-lang">${escapedLabel}</span><button type="button" class="md-code-copy" aria-label="Copy ${escapedLabel} code">Copy</button></div><pre><code class="language-${escapeMarkdownCodeHtml(className)}">${escapeMarkdownCodeHtml(code)}</code></pre></div>`;
}
