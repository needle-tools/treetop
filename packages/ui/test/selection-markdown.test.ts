import { describe, expect, test } from "bun:test";
import {
  buildContextMenuItemsForTargets,
  markdownFromSelectedSources,
  noteBodyFromSelection,
  writeMarkdownSelectionToClipboardData,
} from "../src/selection-markdown";
import { parseInlineAttachments } from "../src/note-inline-attachments";

describe("markdownFromSelectedSources", () => {
  test("copies source markdown when the selection covers the rendered block", () => {
    expect(
      markdownFromSelectedSources("Hello bold friend", [
        { markdown: "Hello **bold** friend", visibleText: "Hello bold friend" },
      ]),
    ).toEqual({
      markdown: "Hello **bold** friend",
      fromMarkdownSource: true,
    });
  });

  test("joins multiple covered markdown blocks in visual order", () => {
    expect(
      markdownFromSelectedSources("First paragraph\nSecond item", [
        { markdown: "First **paragraph**", visibleText: "First paragraph" },
        { markdown: "- Second item", visibleText: "Second item" },
      ]),
    ).toEqual({
      markdown: "First **paragraph**\n\n- Second item",
      fromMarkdownSource: true,
    });
  });

  test("keeps partial selections as selected text", () => {
    expect(
      markdownFromSelectedSources("bold", [
        { markdown: "Hello **bold** friend", visibleText: "Hello bold friend" },
      ]),
    ).toEqual({
      markdown: "bold",
      fromMarkdownSource: false,
    });
  });

  test("does not invent markdown when no source block is covered", () => {
    expect(markdownFromSelectedSources("ordinary selection", [])).toEqual({
      markdown: "ordinary selection",
      fromMarkdownSource: false,
    });
  });

  test("builds note body with selected image attachments", () => {
    const body = noteBodyFromSelection({
      markdown: "Selected **text**",
      fromMarkdownSource: true,
      imagePaths: ["/tmp/screenshot.png"],
    });

    expect(body.startsWith("Selected **text**\n")).toBe(true);
    const attachments = parseInlineAttachments(body).filter(
      (part) => part.kind === "attachment",
    );
    expect(attachments).toHaveLength(1);
    expect(attachments[0]?.attachment).toMatchObject({
      kind: "image",
      path: "/tmp/screenshot.png",
      filename: "screenshot.png",
    });
  });

  test("writes markdown to both plain text and markdown clipboard types", () => {
    const data = new Map<string, string>();
    const body = writeMarkdownSelectionToClipboardData(
      {
        setData(type, value) {
          data.set(type, value);
        },
      },
      {
        markdown: "Selected **text**",
        fromMarkdownSource: true,
        imagePaths: ["/tmp/screenshot.png"],
      },
    );

    expect(data.get("text/plain")).toBe(body);
    expect(data.get("text/markdown")).toBe(body);
    expect(body).toContain("Selected **text**");
    expect(
      parseInlineAttachments(body).filter((part) => part.kind === "attachment"),
    ).toHaveLength(1);
  });

  test("keeps file actions when a markdown selection is on a file target", () => {
    expect(
      buildContextMenuItemsForTargets(
        {
          markdownSelection: true,
          noteAnchor: true,
          filePath: true,
          fileManagerName: "Finder",
        },
        {
          copyMarkdown() {},
          moveToNote() {},
          openFile() {},
          openInFileManager() {},
        },
      ).map((item) => item.label),
    ).toEqual([
      "Copy Markdown",
      "Move to note",
      "Open",
      "Open in Finder",
    ]);
  });

  test("uses the platform file manager name for file context actions", () => {
    expect(
      buildContextMenuItemsForTargets(
        {
          markdownSelection: false,
          noteAnchor: false,
          filePath: true,
          fileManagerName: "Explorer",
        },
        {
          openFile() {},
          openInFileManager() {},
        },
      ).map((item) => item.label),
    ).toEqual(["Open", "Open in Explorer"]);
  });
});
