#!/usr/bin/env bun
//
// Post a build/deploy/release/test result to a Discord channel via an
// Incoming Webhook. The webhook URL is read from the DISCORD_WEBHOOK env
// var — if it's unset (e.g. a fork or a contributor without the secret),
// this is a no-op that exits 0 so it never fails a CI job.
//
// Used by .github/workflows/{deploy-site,release,test}.yml. Run locally to
// test the webhook end-to-end:
//
//   DISCORD_WEBHOOK=https://discord.com/api/webhooks/... \
//     bun run scripts/notify-discord.ts \
//       --title "Webhook test" --status success --details "hello from supergit"

export type NotifyStatus = "success" | "failure" | "cancelled" | "info";

export interface NotifyInput {
  title: string;
  status: NotifyStatus | string;
  url?: string;
  details?: string;
  context?: string;
}

// Discord embed limits we defend against (silently rejected otherwise).
const MAX_DESCRIPTION = 4096;
const MAX_FOOTER = 2048;

export const STATUS_META: Record<
  NotifyStatus,
  { color: number; emoji: string }
> = {
  success: { color: 0x2ecc71, emoji: "✅" },
  failure: { color: 0xe74c3c, emoji: "❌" },
  cancelled: { color: 0x95a5a6, emoji: "⚪" },
  info: { color: 0x3498db, emoji: "🔔" },
};

export interface DiscordEmbed {
  title: string;
  color: number;
  url?: string;
  description?: string;
  footer?: { text: string };
}

export function buildDiscordPayload(input: NotifyInput): {
  embeds: DiscordEmbed[];
} {
  const meta = STATUS_META[input.status as NotifyStatus] ?? STATUS_META.info;
  const embed: DiscordEmbed = {
    title: `${meta.emoji} ${input.title}`,
    color: meta.color,
  };
  if (input.url) embed.url = input.url;
  if (input.details)
    embed.description = input.details.slice(0, MAX_DESCRIPTION);
  if (input.context)
    embed.footer = { text: input.context.slice(0, MAX_FOOTER) };
  return { embeds: [embed] };
}

const KNOWN_FLAGS = ["title", "status", "url", "details", "context"] as const;

export function parseArgs(argv: string[]): Partial<NotifyInput> {
  const out: Record<string, string> = {};
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (!arg.startsWith("--")) continue;
    const key = arg.slice(2);
    const value = argv[i + 1] ?? "";
    if ((KNOWN_FLAGS as readonly string[]).includes(key)) {
      out[key] = value;
      i++; // consume the value
    }
  }
  return out as Partial<NotifyInput>;
}

export async function sendDiscord(
  webhook: string,
  payload: { embeds: DiscordEmbed[] },
): Promise<void> {
  const res = await fetch(webhook, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(payload),
  });
  if (!res.ok) {
    const body = await res.text().catch(() => "");
    throw new Error(
      `Discord webhook returned ${res.status}: ${body.slice(0, 300)}`,
    );
  }
}

async function main(): Promise<void> {
  const webhook = process.env.DISCORD_WEBHOOK?.trim();
  if (!webhook) {
    console.log("notify-discord: DISCORD_WEBHOOK not set — skipping.");
    return;
  }

  const args = parseArgs(process.argv.slice(2));
  if (!args.title) {
    console.error("notify-discord: --title is required.");
    process.exitCode = 2;
    return;
  }

  const payload = buildDiscordPayload({
    title: args.title,
    status: args.status ?? "info",
    url: args.url,
    details: args.details,
    context: args.context,
  });

  try {
    await sendDiscord(webhook, payload);
    console.log(
      `notify-discord: posted "${args.title}" (${args.status ?? "info"}).`,
    );
  } catch (err) {
    // A failed notification must never fail the build it's reporting on.
    console.warn(`notify-discord: failed to post — ${(err as Error).message}`);
  }
}

if (import.meta.main) {
  await main();
}
