import { test, expect, describe } from "bun:test";
import {
  buildDiscordPayload,
  formatCommit,
  parseArgs,
  STATUS_META,
} from "../../../scripts/notify-discord.ts";

describe("parseArgs", () => {
  test("reads --flag value pairs", () => {
    const args = parseArgs([
      "--title",
      "Treetop release",
      "--status",
      "success",
      "--url",
      "https://example.com/run/1",
      "--details",
      "build ok",
      "--context",
      "release #7",
    ]);
    expect(args).toEqual({
      title: "Treetop release",
      status: "success",
      url: "https://example.com/run/1",
      details: "build ok",
      context: "release #7",
    });
  });

  test("ignores unknown flags and leaves them out", () => {
    const args = parseArgs(["--title", "Tests", "--bogus", "x"]);
    expect(args.title).toBe("Tests");
    expect("bogus" in args).toBe(false);
  });

  test("maps hyphenated author flags to camelCase keys", () => {
    const args = parseArgs([
      "--author",
      "Marcel Wiessler",
      "--author-url",
      "https://github.com/marwie",
      "--author-icon",
      "https://github.com/marwie.png",
      "--commit",
      "fix: thing\n\nbody",
    ]);
    expect(args.author).toBe("Marcel Wiessler");
    expect(args.authorUrl).toBe("https://github.com/marwie");
    expect(args.authorIcon).toBe("https://github.com/marwie.png");
    expect(args.commit).toBe("fix: thing\n\nbody");
  });

  test("collects repeatable --field / --inline-field into fields[]", () => {
    const args = parseArgs([
      "--field",
      "📦 Release=[v1.0.0](https://example.com/releases/v1.0.0)",
      "--inline-field",
      "Build=success",
    ]);
    expect(args.fields).toEqual([
      {
        name: "📦 Release",
        value: "[v1.0.0](https://example.com/releases/v1.0.0)",
      },
      { name: "Build", value: "success", inline: true },
    ]);
  });

  test("splits a field only on the first '=' so URLs survive", () => {
    const args = parseArgs(["--field", "Run=https://x.test/r?a=1&b=2"]);
    expect(args.fields?.[0]).toEqual({
      name: "Run",
      value: "https://x.test/r?a=1&b=2",
    });
  });

  test("drops a --field without an '=' separator", () => {
    const args = parseArgs(["--field", "no-separator", "--title", "Tests"]);
    expect("fields" in args).toBe(false);
    expect(args.title).toBe("Tests");
  });
});

describe("formatCommit", () => {
  test("bolds the subject and keeps the body", () => {
    expect(formatCommit("fix: a bug\n\nlonger explanation")).toBe(
      "**fix: a bug**\nlonger explanation",
    );
  });

  test("a subject-only commit has no trailing newline", () => {
    expect(formatCommit("chore: bump")).toBe("**chore: bump**");
  });

  test("an empty message yields an empty string", () => {
    expect(formatCommit("   \n  ")).toBe("");
  });
});

describe("buildDiscordPayload", () => {
  test("maps a successful deploy to a green embed", () => {
    const payload = buildDiscordPayload({
      title: "Treetop site deploy",
      status: "success",
      url: "https://treetop.example",
      details: "Branch main",
      context: "deploy site #3",
    });
    const embed = payload.embeds[0];
    expect(embed.color).toBe(STATUS_META.success.color);
    expect(embed.title).toContain("Treetop site deploy");
    expect(embed.title).toContain(STATUS_META.success.emoji);
    expect(embed.url).toBe("https://treetop.example");
    expect(embed.description).toBe("Branch main");
    expect(embed.footer).toEqual({ text: "deploy site #3" });
  });

  test("maps a failed run to a red embed", () => {
    const payload = buildDiscordPayload({ title: "Tests", status: "failure" });
    expect(payload.embeds[0].color).toBe(STATUS_META.failure.color);
    expect(payload.embeds[0].title).toContain(STATUS_META.failure.emoji);
  });

  test("unknown/empty status falls back to the info style", () => {
    const payload = buildDiscordPayload({ title: "Tests", status: "" });
    expect(payload.embeds[0].color).toBe(STATUS_META.info.color);
  });

  test("omits optional fields when not provided", () => {
    const embed = buildDiscordPayload({ title: "Tests", status: "success" })
      .embeds[0];
    expect("url" in embed).toBe(false);
    expect("description" in embed).toBe(false);
    expect("footer" in embed).toBe(false);
  });

  test("truncates an over-long description to Discord's 4096 limit", () => {
    const embed = buildDiscordPayload({
      title: "Tests",
      status: "failure",
      details: "x".repeat(5000),
    }).embeds[0];
    expect((embed.description as string).length).toBe(4096);
  });

  test("renders an author block with profile url + avatar", () => {
    const embed = buildDiscordPayload({
      title: "Tests",
      status: "success",
      author: "Marcel Wiessler",
      authorUrl: "https://github.com/marwie",
      authorIcon: "https://github.com/marwie.png",
    }).embeds[0];
    expect(embed.author).toEqual({
      name: "Marcel Wiessler",
      url: "https://github.com/marwie",
      icon_url: "https://github.com/marwie.png",
    });
  });

  test("prepends the bolded commit subject above the details line", () => {
    const embed = buildDiscordPayload({
      title: "Treetop release v0.1.0-3",
      status: "success",
      commit: "feat: ship it\n\nwith details",
      details: "build: success · release: success",
    }).embeds[0];
    expect(embed.description).toBe(
      "**feat: ship it**\nwith details\n\nbuild: success · release: success",
    );
  });

  test("attaches a release card field and an embed timestamp", () => {
    const embed = buildDiscordPayload({
      title: "Treetop release v0.1.0-3",
      status: "success",
      fields: [
        {
          name: "📦 Release",
          value: "[v0.1.0-3](https://example.com/releases/tag/v0.1.0-3)",
        },
      ],
      timestamp: "2026-06-29T21:00:00.000Z",
    }).embeds[0];
    expect(embed.fields).toEqual([
      {
        name: "📦 Release",
        value: "[v0.1.0-3](https://example.com/releases/tag/v0.1.0-3)",
      },
    ]);
    expect(embed.timestamp).toBe("2026-06-29T21:00:00.000Z");
  });

  test("still omits author/fields/timestamp when not provided", () => {
    const embed = buildDiscordPayload({ title: "Tests", status: "success" })
      .embeds[0];
    expect("author" in embed).toBe(false);
    expect("fields" in embed).toBe(false);
    expect("timestamp" in embed).toBe(false);
  });
});
