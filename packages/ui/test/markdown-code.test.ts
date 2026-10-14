import { describe, expect, it } from "bun:test";
import { Marked } from "marked";
import {
  markdownCodeBlockHtml,
  markdownCodeLanguage,
  markdownCodeLanguageClass,
  markdownSessionDirectiveExtension,
} from "../src/markdown-code";

describe("markdown code rendering", () => {
  it("renders writing blocks with email metadata and copyable Markdown bodies", () => {
    const markdown = new Marked(markdownSessionDirectiveExtension());
    const html = markdown.parse('Before\n\n:::writing{variant="email" id="12345" subject="Review" recipient="a@example.com"}\nHello **team**.\n\nThanks!\n:::\n\nAfter') as string;
    expect(html).toContain('class="md-code-frame md-writing-block"');
    expect(html).toContain('data-writing-body="Hello **team**.');
    expect(html).toContain("Review");
    expect(html).toContain("a@example.com");
    expect(html).toContain("<strong>team</strong>");
    expect(html).toContain('aria-label="Copy email"');
    expect(html).not.toContain(":::writing");
    expect(html).toContain("After");
  });

  it("renders writing tone alternatives separately and keeps an unfinished stream readable", () => {
    const markdown = new Marked(markdownSessionDirectiveExtension());
    const html = markdown.parse(':::writing{variant="chat_message" id="12345"}\n---tone Friendly\nHello!\n---tone Direct\nPlease review.\n:::') as string;
    expect(html).toContain('data-writing-body="Hello!"');
    expect(html).toContain('data-writing-body="Please review."');
    expect(html).toContain("Friendly");
    expect(html).not.toContain("---tone");
    expect(markdown.parse(':::writing{variant="document" id="12345"}\nDraft **continues**')).toContain("<strong>continues</strong>");
  });

  it("renders code comments with priority, Markdown explanation, and file range", () => {
    const markdown = new Marked(markdownSessionDirectiveExtension());
    const html = markdown.parse('::code-comment{title="[P2] Boundary" body="Use **the final row**." file="/repo/app.ts" start=10 end=11 priority=2}') as string;
    expect(html).toContain("[P2] Boundary");
    expect(html).toContain("<strong>the final row</strong>");
    expect(html).toContain('data-supergit-file-href="/repo/app.ts"');
    expect(html).toContain("app.ts:10–11");
    expect(html).not.toContain("::code-comment");
    expect(markdown.parse('::code-comment{title="No range" body="Check it." file="/repo/app.ts" start=10}')).toContain("app.ts:10");
  });

  it("consumes realtime display markers while preserving the message and code examples", () => {
    const markdown = new Marked(markdownSessionDirectiveExtension());
    const html = markdown.parse('::codex-realtime-inline{}\n### Result\nEverything is **ready**.') as string;
    expect(html).toContain("<h3>Result</h3>");
    expect(html).toContain("<strong>ready</strong>");
    expect(html).not.toContain("::codex-realtime-inline");
    expect(markdown.parse('`::codex-realtime-inline{}`')).toContain("::codex-realtime-inline{}");
    expect(markdown.parse('```text\n:::writing{variant="standard" id="12345"}\nDraft\n:::\n```')).not.toContain("md-writing-block");
  });

  it("does not close writing or create tone alternatives inside code examples", () => {
    const markdown = new Marked(markdownSessionDirectiveExtension());
    const html = markdown.parse(':::writing{variant="document" id="12345"}\n```text\n:::\n---tone Example\n```\nStill in the draft.\n:::\n\nOutside.') as string;
    expect(html.match(/md-writing-block/g)).toHaveLength(1);
    expect(html).toContain("---tone Example");
    expect(html).toContain("Still in the draft.");
    expect(html).toContain("Outside.");
    expect(markdown.parse('::code-comment{title="Bad" body="Check" file="javascript:alert(1)"}')).not.toContain("md-review-comment");
  });

  it("renders file citations through the existing path-chip and file-link contract", () => {
    const markdown = new Marked(markdownSessionDirectiveExtension());
    const html = markdown.parse('Verified :codex-file-citation{path="/repo/bsi/source.pdf" purpose="source"}.\n\n:codex-file-citation{purpose="output" path="/repo/Report with spaces.pdf"}');
    expect(html).toContain('class="work-preview-path"');
    expect(html).toContain('data-supergit-file-href="/repo/bsi/source.pdf"');
    expect(html).toContain('title="source · /repo/bsi/source.pdf"');
    expect(html).toContain('>source.pdf</a>');
    expect(html).toContain('>Report with spaces.pdf</a>');
    expect(html).not.toContain(":codex-file-citation");
  });

  it("preserves code examples and rejects malformed or non-file citations", () => {
    const markdown = new Marked(markdownSessionDirectiveExtension());
    const directive = ':codex-file-citation{path="/repo/a.pdf" purpose="source"}';
    const html = markdown.parse('`' + directive + '`\n\n```text\n' + directive + '\n```');
    expect(html).not.toContain("data-supergit-file-href");
    expect(html).toContain(":codex-file-citation");
    expect(markdown.parse(':codex-file-citation{purpose="source"}')).not.toContain("data-supergit-file-href");
    expect(markdown.parse(':codex-file-citation{path="javascript:alert(1)"}')).not.toContain("data-supergit-file-href");
  });

  it("escapes filenames and keeps sheet/range citation metadata", () => {
    const markdown = new Marked(markdownSessionDirectiveExtension());
    const html = markdown.parse(':codex-file-citation{path="/repo/<Report>.xlsx" purpose="source" sheet="Revenue Model" range="C27"}');
    expect(html).toContain('&lt;Report&gt;.xlsx');
    expect(html).toContain('Revenue Model · C27');
    expect(html).not.toContain("<Report>");
  });

  it("normalizes missing languages to text", () => {
    expect(markdownCodeLanguage(undefined)).toBe("text");
    expect(markdownCodeLanguage("")).toBe("text");
  });

  it("uses the first language token for fenced code metadata", () => {
    expect(markdownCodeLanguage("ts title=\"demo\"")).toBe("ts");
  });

  it("keeps language classes CSS-safe", () => {
    expect(markdownCodeLanguageClass("Type Script")).toBe("type-script");
    expect(markdownCodeLanguageClass("c++")).toBe("c++");
  });

  it("renders a language header, copy button, and escaped code", () => {
    expect(markdownCodeBlockHtml('const x = "<tag>";', "ts")).toBe(
      '<div class="md-code-frame"><div class="md-code-head"><span class="md-code-lang">ts</span><button type="button" class="md-code-copy" aria-label="Copy ts code">Copy</button></div><pre><code class="language-ts">const x = &quot;&lt;tag&gt;&quot;;</code></pre></div>',
    );
  });

  it("marks Mermaid fences for diagram rendering instead of showing source code", () => {
    expect(markdownCodeBlockHtml("graph TD\nA --> B", "mermaid")).toBe(
      '<div class="mermaid-diagram" role="img" aria-label="Mermaid diagram"><pre class="mermaid-source">graph TD\nA --&gt; B</pre></div>',
    );
  });
});
