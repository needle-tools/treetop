import { describe, expect, test } from "bun:test";
import {
  LARGE_PASTE_CHAR_THRESHOLD,
  appendInlineAttachmentRef,
  commandCopyText,
  commandPowerLabel,
  commandRunText,
  countTextLines,
  expandNoteBodyForTerminalPasteChunks,
  expandNoteBodyForCopyAsync,
  expandNoteBodyForCopy,
  extractNoteClipboardPayloadFromHtml,
  fetchTextAttachment,
  inferPastedTextMimeType,
  inlineAttachmentLabel,
  noteBodyToEditText,
  makeNoteClipboardHtml,
  makeNoteClipboardPayload,
  makeEmojiAttachmentRef,
  makeImageAttachmentRef,
  makeLinkAttachmentRef,
  makeNoteAttachmentRef,
  makeTextAttachmentRef,
  moveInlineAttachmentRefBefore,
  moveInlineAttachmentRefToEnd,
  parseInlineAttachments,
  removeInlineAttachmentRef,
  restoreEditTextAttachments,
  resolveLiveCommandLink,
  shouldAttachPastedText,
  textAttachmentMeta,
  trailingImageAttachmentIndexes,
  trailingVisualAttachmentIndexes,
  visualAttachmentIndexes,
  pastedTextTitleForMime,
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
      lineCount: 45,
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
      expect(parts[1].attachment.lineCount).toBe(45);
      expect(parts[1].attachment.source?.types).toEqual(["text/plain", "text/html"]);
    }
  });

  test("formats pasted text cards with line count and size", () => {
    const ref = makeTextAttachmentRef({
      path: "/tmp/supergit/attachments/paste.txt",
      filename: "paste.txt",
      mimeType: "text/plain",
      size: 1229,
      charCount: 1229,
      lineCount: 45,
    });
    const part = parseInlineAttachments(ref)[0];

    expect(part?.kind).toBe("attachment");
    if (part?.kind === "attachment" && part.attachment.kind === "text") {
      expect(textAttachmentMeta(part.attachment)).toBe("45 lines, 1.2 KB");
    }
  });

  test("formats legacy pasted text cards after lazy stats load", () => {
    const ref = makeTextAttachmentRef({
      path: "/tmp/supergit/attachments/paste.txt",
      filename: "paste.txt",
      mimeType: "text/plain",
      size: 1229,
      charCount: 1229,
    });
    const part = parseInlineAttachments(ref)[0];

    expect(part?.kind).toBe("attachment");
    if (part?.kind === "attachment" && part.attachment.kind === "text") {
      expect(textAttachmentMeta(part.attachment, { lineCount: 45, charCount: 1229 })).toBe(
        "45 lines, 1.2 KB",
      );
    }
  });

  test("infers pasted text types for human labels", () => {
    expect(countTextLines("a\nb\r\nc")).toBe(3);
    expect(inferPastedTextMimeType('{"ok": true}', ["text/plain"])).toBe("application/json");
    expect(inferPastedTextMimeType("# Title\n\nbody", ["text/plain"])).toBe("text/markdown");
    expect(pastedTextTitleForMime("application/json")).toBe("Pasted JSON");
    expect(pastedTextTitleForMime("text/markdown")).toBe("Pasted Markdown");
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

  test("uses image filenames instead of absolute paths for attachment labels", () => {
    const ref = makeImageAttachmentRef({
      path: "/Users/herbst/supergit/workspaces/default/attachments/events-overlay-sheet.jpg",
      mimeType: "image/jpeg",
      size: 123,
      source: { kind: "drop", types: ["Files"] },
    });
    const parts = parseInlineAttachments(ref);

    expect(parts[0]?.kind).toBe("attachment");
    if (parts[0]?.kind === "attachment") {
      expect(inlineAttachmentLabel(parts[0].attachment)).toBe("events-overlay-sheet.jpg");
    }
  });

  test("round-trips note, emoji, and link attachment references", () => {
    const noteRef = makeNoteAttachmentRef({ body: "nested note\nbody" });
    const emojiRef = makeEmojiAttachmentRef({ body: "✨" });
    const linkRef = makeLinkAttachmentRef({
      target: {
        type: "session",
        value: "/tmp/session.jsonl",
        label: "Session title",
        agent: "codex",
      },
    });
    const parts = parseInlineAttachments(`${noteRef} ${emojiRef} ${linkRef}`);

    expect(parts.filter((part) => part.kind === "attachment")).toHaveLength(3);
    if (parts[0]?.kind === "attachment") {
      expect(parts[0].attachment).toEqual({
        kind: "note",
        body: "nested note\nbody",
      });
    }
    if (parts[2]?.kind === "attachment") {
      expect(parts[2].attachment).toEqual({ kind: "emoji", body: "✨" });
    }
    if (parts[4]?.kind === "attachment") {
      expect(parts[4].attachment).toEqual({
        kind: "link",
        target: {
          type: "session",
          value: "/tmp/session.jsonl",
          label: "Session title",
          agent: "codex",
        },
      });
    }
  });

  test("round-trips command link attachment references", () => {
    const ref = makeLinkAttachmentRef({
      target: {
        type: "command",
        value: "cmd-1",
        label: "build:launch",
        repoId: "repo-a",
        cwd: "/tmp/project",
        command: "npm run build:launch",
        runMode: "internal",
      },
    });
    const parts = parseInlineAttachments(ref);

    expect(parts).toHaveLength(1);
    expect(parts[0]?.kind).toBe("attachment");
    if (parts[0]?.kind === "attachment") {
      expect(parts[0].attachment).toEqual({
        kind: "link",
        target: {
          type: "command",
          value: "cmd-1",
          label: "build:launch",
          repoId: "repo-a",
          cwd: "/tmp/project",
          command: "npm run build:launch",
          runMode: "internal",
        },
      });
      expect(inlineAttachmentLabel(parts[0].attachment)).toBe("build:launch");
    }
  });

  test("derives short command power-button labels", () => {
    expect(commandPowerLabel({
      type: "command",
      value: "cmd-1",
      command: "npm run build:launch",
    })).toBe("build:launch");
    expect(commandPowerLabel({
      type: "command",
      value: "cmd-2",
      command: "bun run scripts/build-launch.ts",
      label: "Relaunch",
    })).toBe("Relaunch");
  });

  test("copies command references as the runnable command text", () => {
    expect(commandRunText({
      type: "command",
      value: "cmd-1",
      label: "Relaunch",
      command: "npm run build:launch",
    })).toBe("npm run build:launch");
  });

  test("copies command references with cwd when available", () => {
    expect(commandCopyText({
      type: "command",
      value: "cmd-1",
      command: "npm run build:launch",
      cwd: "/Users/herbst/git/supergit",
    })).toBe("cd /Users/herbst/git/supergit && npm run build:launch");

    expect(commandCopyText({
      type: "command",
      value: "cmd-1",
      command: "npm test",
      cwd: "/tmp/has space/it's fine",
    })).toBe("cd '/tmp/has space/it'\\''s fine' && npm test");

    expect(commandCopyText({
      type: "command",
      value: "stale",
      command: "npm run old",
      cwd: "/tmp/old",
    }, {
      id: "live",
      kind: "command",
      cmd: "npm run build:launch",
      cwd: "/Users/herbst/git/supergit",
    })).toBe("cd /Users/herbst/git/supergit && npm run build:launch");
  });

  test("resolves pinned command references against live toolbar commands", () => {
    const repos = [
      {
        id: "repo-a",
        customLinks: [
          {
            id: "cmd-old",
            kind: "command",
            cmd: "npm run dev",
            name: "dev",
            runMode: "internal" as const,
          },
        ],
      },
      {
        id: "repo-b",
        customLinks: [
          {
            id: "cmd-live",
            kind: "command",
            cmd: "npm run build:launch",
            name: "launch",
            runMode: "shell" as const,
          },
        ],
      },
    ];

    expect(resolveLiveCommandLink({
      type: "command",
      value: "cmd-live",
      repoId: "repo-b",
    }, repos)?.link.id).toBe("cmd-live");

    expect(resolveLiveCommandLink({
      type: "command",
      value: "stale-id",
      repoId: "repo-b",
      command: "npm run build:launch",
    }, repos)?.link.id).toBe("cmd-live");

    expect(resolveLiveCommandLink({
      type: "command",
      value: "stale-id",
      label: "launch",
    }, repos)?.repo.id).toBe("repo-b");
  });

  test("copy expansion restores hidden paste payloads and image paths", () => {
    const paste = makeTextAttachmentRef({
      path: "/tmp/paste.txt",
      charCount: 16,
    });
    const image = makeImageAttachmentRef({ path: "/tmp/a.png" });
    const emoji = makeEmojiAttachmentRef({ body: "✨" });
    const note = makeNoteAttachmentRef({ body: "nested" });

    expect(expandNoteBodyForCopy(`A ${paste} B ${image} C ${emoji} D ${note}`)).toBe(
      "A /tmp/paste.txt B /tmp/a.png C ✨ D nested",
    );
  });

  test("copy expansion keeps session links as explicit session references", () => {
    const session = makeLinkAttachmentRef({
      target: {
        type: "session",
        value: "/Users/me/.codex/sessions/abc123.jsonl",
        label: "Fix the thing",
        agent: "codex",
      },
    });

    expect(expandNoteBodyForCopy(`See ${session}`)).toBe(
      "See Session: /Users/me/.codex/sessions/abc123.jsonl",
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

  test("terminal paste keeps text and images as separate chunks", async () => {
    const paste = makeTextAttachmentRef({
      path: "/tmp/supergit/attachments/paste.txt",
      filename: "paste.txt",
      mimeType: "text/plain",
      size: 16,
      charCount: 16,
    });
    const image = makeImageAttachmentRef({
      path: "/tmp/supergit/attachments/shot.png",
      filename: "shot.png",
    });

    await expect(
      expandNoteBodyForTerminalPasteChunks(`A ${paste}\n${image}\nthanks`, async (path) => {
        expect(path).toBe("/tmp/supergit/attachments/paste.txt");
        return "hidden long text";
      }),
    ).resolves.toEqual([
      "A ",
      "hidden long text",
      "\n",
      "/tmp/supergit/attachments/shot.png",
      "\nthanks",
    ]);
  });

  test("terminal paste skips emoji attachments", async () => {
    const emoji = makeEmojiAttachmentRef({ body: "✨" });
    const paste = makeTextAttachmentRef({
      path: "/tmp/supergit/attachments/paste.txt",
      filename: "paste.txt",
      mimeType: "text/plain",
      size: 16,
      charCount: 16,
    });

    await expect(
      expandNoteBodyForTerminalPasteChunks(`A ${emoji}\n${paste}\n${emoji} B`, async (path) => {
        expect(path).toBe("/tmp/supergit/attachments/paste.txt");
        return "hidden long text";
      }),
    ).resolves.toEqual(["A \n", "hidden long text", "\n B"]);
  });

  test("terminal paste skips the target session reference only", async () => {
    const targetSession = makeLinkAttachmentRef({
      target: {
        type: "session",
        value: "/Users/me/.codex/sessions/current.jsonl",
        label: "Current session",
      },
    });
    const otherSession = makeLinkAttachmentRef({
      target: {
        type: "session",
        value: "/Users/me/.codex/sessions/other.jsonl",
        label: "Other session",
      },
    });

    await expect(
      expandNoteBodyForTerminalPasteChunks(
        `Please check this\n${targetSession}\n${otherSession}`,
        async () => "",
        { omitTargetSessionSource: "/Users/me/.codex/sessions/current.jsonl" },
      ),
    ).resolves.toEqual([
      "Please check this\nSession: /Users/me/.codex/sessions/other.jsonl",
    ]);
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

  test("removes a moved inline attachment ref from its source note body", () => {
    const first = makeImageAttachmentRef({
      path: "/tmp/a.png",
      filename: "a.png",
      mimeType: "image/png",
    });
    const second = makeTextAttachmentRef({
      path: "/tmp/paste.txt",
      filename: "paste.txt",
      mimeType: "text/plain",
      charCount: 12,
    });

    expect(removeInlineAttachmentRef(`before ${first} middle ${second} after`, first))
      .toBe(`before  middle ${second} after`);
    expect(removeInlineAttachmentRef(first, first)).toBe("");
    expect(removeInlineAttachmentRef("unchanged", first)).toBe("unchanged");
  });

  test("moves an inline attachment ref within a note body", () => {
    const first = makeImageAttachmentRef({ path: "/tmp/a.png", filename: "a.png" });
    const second = makeTextAttachmentRef({
      path: "/tmp/paste.txt",
      filename: "paste.txt",
      charCount: 12,
    });
    const third = makeEmojiAttachmentRef({ body: "✨" });

    expect(moveInlineAttachmentRefToEnd(`A ${first} B ${second}`, first))
      .toBe(`A  B ${second}\n${first}`);
    expect(moveInlineAttachmentRefBefore(`A ${first} B ${second} C ${third}`, third, second))
      .toBe(`A ${first} B ${third}${second} C `);
    expect(moveInlineAttachmentRefBefore("unchanged", first, second)).toBe("unchanged");
  });

  test("appends a session reference without deleting the note body", () => {
    const sessionRef = makeLinkAttachmentRef({
      target: {
        type: "session",
        value: "/tmp/codex-session.jsonl",
        label: "Fix terminal colors",
        agent: "codex",
      },
    });
    const body = appendInlineAttachmentRef("keep this note", sessionRef);
    const parts = parseInlineAttachments(body);

    expect(body.startsWith("keep this note\n")).toBe(true);
    expect(parts[0]).toEqual({ kind: "text", text: "keep this note\n" });
    expect(parts[1]).toEqual({
      kind: "attachment",
      raw: sessionRef,
      attachment: {
        kind: "link",
        target: {
          type: "session",
          value: "/tmp/codex-session.jsonl",
          label: "Fix terminal colors",
          agent: "codex",
        },
      },
    });
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

  test("detects mixed visual attachments trailing at the end of note content", () => {
    const first = makeImageAttachmentRef({ path: "/tmp/a.png", filename: "a.png" });
    const emoji = makeEmojiAttachmentRef({ body: "✨" });
    const second = makeImageAttachmentRef({ path: "/tmp/b.png", filename: "b.png" });
    const paste = makeTextAttachmentRef({
      path: "/tmp/paste.txt",
      filename: "paste.txt",
      charCount: 12,
    });

    const parts = parseInlineAttachments(`body ${first}\n${emoji}\n${second}\n`);
    expect([...trailingVisualAttachmentIndexes(parts)]).toEqual([1, 3, 5]);

    const blocked = parseInlineAttachments(`body ${first}\n${paste}\n${emoji}\n`);
    expect([...trailingVisualAttachmentIndexes(blocked)]).toEqual([5]);
  });

  test("detects visual attachments anywhere in note content", () => {
    const first = makeImageAttachmentRef({ path: "/tmp/a.png", filename: "a.png" });
    const paste = makeTextAttachmentRef({
      path: "/tmp/paste.txt",
      filename: "paste.txt",
      charCount: 12,
    });
    const emoji = makeEmojiAttachmentRef({ body: "✨" });
    const note = makeNoteAttachmentRef({ body: "nested note" });
    const session = makeLinkAttachmentRef({
      target: { type: "session", value: "/tmp/session.jsonl", label: "Session title" },
    });
    const parts = parseInlineAttachments(
      `body ${first}\n${paste}\n${emoji}\n${note}\n${session}\ncaption`,
    );

    expect([...visualAttachmentIndexes(parts)]).toEqual([1, 3, 5, 7, 9]);
  });
});
