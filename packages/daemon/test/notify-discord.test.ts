import { test, expect, describe } from "bun:test";
import {
  buildDiscordPayload,
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
});
