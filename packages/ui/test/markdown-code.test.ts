import { describe, expect, it } from "bun:test";
import {
  markdownCodeBlockHtml,
  markdownCodeLanguage,
  markdownCodeLanguageClass,
} from "../src/markdown-code";

describe("markdown code rendering", () => {
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
});
