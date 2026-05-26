import { describe, expect, test } from "bun:test";
import {
  LARGE_PASTE_CHAR_THRESHOLD,
  expandNoteBodyForCopyAsync,
  expandNoteBodyForCopy,
  extractNoteClipboardPayloadFromHtml,
  fetchTextAttachment,
  noteBodyToEditText,
  makeNoteClipboardHtml,
  makeNoteClipboardPayload,
  makeImageAttachmentRef,
  makeTextAttachmentRef,
  parseInlineAttachments,
  restoreEditTextAttachments,
  shouldAttachPastedText,
  trailingImageAttachmentIndexes,
} from "../src/note-inline-attachments";

describe("note inline attachments", () => {
  test("mirrors Codex CLI's large paste cutoff", () => {
    expect(LARGE_PASTE_CHAR_THRESHOLD).toBe(1000);
    expect(shouldAttachPastedText("x".repeat(1000))).toBe(false);
    expect(shouldAttachPastedText("x".repeat(1001))).toBe(true);
  });

  test("round-trips a text paste reference through the supergit link family", () => {
    const ref = makeTextAttachmentRef({
      path: "/tmp/supergit/attachments/paste.txt",
      filename: "paste.txt",
      mimeType: "text/plain",
      size: 1016,
      charCount: 1016,
      source: {
        kind: "clipboard",
        types: ["text/plain", "text/html"],
      },
    });
    const parts = parseInlineAttachments(`before ${ref} after`);

    expect(ref).toMatch(/^\[Pasted Content, \d+ chars\]\(supergit:\/\/attachment\//);
    expect(ref).not.toContain("{{supergit:attachment:");
    expect(parts).toHaveLength(3);
    expect(parts[0]).toEqual({ kind: "text", text: "before " });
    expect(parts[2]).toEqual({ kind: "text", text: " after" });
    expect(parts[1]?.kind).toBe("attachment");
    if (parts[1]?.kind === "attachment") {
      expect(parts[1].attachment.kind).toBe("text");
      expect(parts[1].attachment.path).toBe("/tmp/supergit/attachments/paste.txt");
      expect(parts[1].attachment.charCount).toBe(1016);
      expect(parts[1].attachment.source?.types).toEqual(["text/plain", "text/html"]);
    }
  });

  test("round-trips an image attachment reference", () => {
    const ref = makeImageAttachmentRef({
      path: "/tmp/supergit/attachments/shot.png",
      filename: "shot.png",
      mimeType: "image/png",
      size: 123,
      source: { kind: "drop", types: ["Files"] },
    });
    const parts = parseInlineAttachments(ref);

    expect(ref).toMatch(/^\[shot\.png\]\(supergit:\/\/attachment\//);
    expect(parts).toHaveLength(1);
    expect(parts[0]?.kind).toBe("attachment");
    if (parts[0]?.kind === "attachment") {
      expect(parts[0].attachment.kind).toBe("image");
      expect(parts[0].attachment.path).toBe("/tmp/supergit/attachments/shot.png");
      expect(parts[0].attachment.filename).toBe("shot.png");
      expect(parts[0].attachment.mimeType).toBe("image/png");
      expect(parts[0].attachment.size).toBe(123);
    }
  });

  test("copy expansion restores hidden paste payloads and image paths", () => {
    const paste = makeTextAttachmentRef({
      path: "/tmp/paste.txt",
      charCount: 16,
    });
    const image = makeImageAttachmentRef({ path: "/tmp/a.png" });

    expect(expandNoteBodyForCopy(`A ${paste} B ${image}`)).toBe(
      "A /tmp/paste.txt B /tmp/a.png",
    );
  });

  test("path-backed text attachments expand through the provided reader", async () => {
    const paste = makeTextAttachmentRef({
      path: "/tmp/supergit/attachments/paste.txt",
      filename: "paste.txt",
      mimeType: "text/plain",
      size: 16,
      charCount: 16,
    });

    expect(expandNoteBodyForCopy(`A ${paste}`)).toBe(
      "A /tmp/supergit/attachments/paste.txt",
    );
    await expect(
      expandNoteBodyForCopyAsync(`A ${paste}`, async (path) => {
        expect(path).toBe("/tmp/supergit/attachments/paste.txt");
        return "hidden long text";
      }),
    ).resolves.toBe("A hidden long text");
  });

  test("text attachment reads fail instead of substituting another payload", async () => {
    const oldFetch = globalThis.fetch;
    globalThis.fetch = (async () => new Response("missing", { status: 404 })) as typeof fetch;
    try {
      await expect(fetchTextAttachment("/tmp/missing.txt")).rejects.toThrow(
        "attachment read failed: 404",
      );
    } finally {
      globalThis.fetch = oldFetch;
    }
  });

  test("edit mode shows compact placeholders that round-trip to stored tokens", () => {
    const paste = makeTextAttachmentRef({
      path: "/tmp/supergit/attachments/paste.txt",
      charCount: 16,
    });
    const image = makeImageAttachmentRef({
      path: "/tmp/supergit/attachments/shot.png",
      filename: "shot.png",
    });
    const body = `A ${paste}\nB ${image}`;

    const edit = noteBodyToEditText(body);

    expect(edit.text).toBe("A [Pasted Content, 16 chars]\nB [shot.png]");
    expect(edit.refs).toHaveLength(2);
    expect(restoreEditTextAttachments(edit.text, edit.refs)).toBe(body);
  });

  test("edit placeholders avoid clobbering literal note text", () => {
    const paste = makeTextAttachmentRef({
      path: "/tmp/supergit/attachments/paste.txt",
      charCount: 16,
    });
    const body = `[Pasted Content, 16 chars]\n${paste}`;

    const edit = noteBodyToEditText(body);

    expect(edit.text).toBe(
      "[Pasted Content, 16 chars]\n[Pasted Content, 16 chars] #2",
    );
    expect(restoreEditTextAttachments(edit.text, edit.refs)).toBe(body);
  });

  test("clipboard HTML carries note metadata in a robust compact envelope", () => {
    const body = makeTextAttachmentRef({
      path: "/tmp/supergit/attachments/paste.txt",
      charCount: 12,
    });
    const payload = makeNoteClipboardPayload({
      id: "n-1",
      body,
      text: "expanded text",
      copiedAt: "2026-05-26T12:00:00.000Z",
    });
    const html = makeNoteClipboardHtml(payload, "visible < text");

    expect(html).toContain("data-supergit-note=");
    expect(html).not.toContain(body);
    expect(extractNoteClipboardPayloadFromHtml(html)).toEqual(payload);
  });

  test("ignores malformed attachment references as plain text", () => {
    const body = "before [broken](supergit://attachment/not-base64) after";
    expect(parseInlineAttachments(body)).toEqual([{ kind: "text", text: body }]);
  });

  test("detects image attachments trailing at the end of note content", () => {
    const paste = makeTextAttachmentRef({
      path: "/tmp/paste.txt",
      filename: "paste.txt",
      charCount: 12,
    });
    const first = makeImageAttachmentRef({ path: "/tmp/a.png", filename: "a.png" });
    const second = makeImageAttachmentRef({ path: "/tmp/b.png", filename: "b.png" });

    const parts = parseInlineAttachments(`body ${paste}\n${first}\n${second}\n`);
    expect([...trailingImageAttachmentIndexes(parts)]).toEqual([3, 5]);

    const mixed = parseInlineAttachments(`${first}\ncaption`);
    expect([...trailingImageAttachmentIndexes(mixed)]).toEqual([]);
  });
});
