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

export interface DiscordEmbedField {
  name: string;
  value: string;
  inline?: boolean;
}

export interface NotifyInput {
  title: string;
  status: NotifyStatus | string;
  url?: string;
  details?: string;
  context?: string;
  /** Commit author / triggering user — rendered as the embed's author line. */
  author?: string;
  authorUrl?: string;
  authorIcon?: string;
  /** Raw commit message; first line becomes a bold subject in the body. */
  commit?: string;
  /** Extra cards (e.g. a release link). */
  fields?: DiscordEmbedField[];
  /** ISO-8601 timestamp shown in the embed footer area. */
  timestamp?: string;
}

// Discord embed limits we defend against (silently rejected otherwise).
const MAX_DESCRIPTION = 4096;
const MAX_FOOTER = 2048;
const MAX_AUTHOR = 256;
const MAX_FIELD_NAME = 256;
const MAX_FIELD_VALUE = 1024;
const MAX_FIELDS = 25;

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
  author?: { name: string; url?: string; icon_url?: string };
  fields?: DiscordEmbedField[];
  timestamp?: string;
}

/** Render a commit message as Markdown: bold subject line, plain body. */
export function formatCommit(message: string): string {
  const trimmed = message.trim();
  if (!trimmed) return "";
  const newline = trimmed.indexOf("\n");
  const subject = newline === -1 ? trimmed : trimmed.slice(0, newline);
  const body = newline === -1 ? "" : trimmed.slice(newline + 1).trim();
  return body ? `**${subject}**\n${body}` : `**${subject}**`;
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

  // Body: commit subject/body first, then the details line.
  const blocks: string[] = [];
  if (input.commit) {
    const formatted = formatCommit(input.commit);
    if (formatted) blocks.push(formatted);
  }
  if (input.details) blocks.push(input.details);
  const description = blocks.join("\n\n");
  if (description) embed.description = description.slice(0, MAX_DESCRIPTION);

  if (input.author) {
    embed.author = { name: input.author.slice(0, MAX_AUTHOR) };
    if (input.authorUrl) embed.author.url = input.authorUrl;
    if (input.authorIcon) embed.author.icon_url = input.authorIcon;
  }

  if (input.fields && input.fields.length > 0) {
    embed.fields = input.fields.slice(0, MAX_FIELDS).map((f) => {
      const field: DiscordEmbedField = {
        name: f.name.slice(0, MAX_FIELD_NAME),
        value: f.value.slice(0, MAX_FIELD_VALUE),
      };
      if (f.inline) field.inline = true;
      return field;
    });
  }

  if (input.context)
    embed.footer = { text: input.context.slice(0, MAX_FOOTER) };
  if (input.timestamp) embed.timestamp = input.timestamp;
  return { embeds: [embed] };
}

// Scalar flags map 1:1 onto NotifyInput keys (hyphenated → camelCase).
const SCALAR_FLAGS: Record<string, keyof NotifyInput> = {
  title: "title",
  status: "status",
  url: "url",
  details: "details",
  context: "context",
  author: "author",
  "author-url": "authorUrl",
  "author-icon": "authorIcon",
  commit: "commit",
  timestamp: "timestamp",
};

export function parseArgs(argv: string[]): Partial<NotifyInput> {
  const out: Record<string, unknown> = {};
  const fields: DiscordEmbedField[] = [];
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (!arg.startsWith("--")) continue;
    const key = arg.slice(2);
    const value = argv[i + 1] ?? "";
    // Repeatable card flags: --field / --inline-field "Name=Value".
    if (key === "field" || key === "inline-field") {
      const eq = value.indexOf("=");
      if (eq > 0) {
        fields.push({
          name: value.slice(0, eq),
          value: value.slice(eq + 1),
          ...(key === "inline-field" ? { inline: true } : {}),
        });
      }
      i++; // consume the value
      continue;
    }
    const mapped = SCALAR_FLAGS[key];
    if (mapped) {
      out[mapped] = value;
      i++; // consume the value
    }
  }
  if (fields.length > 0) out.fields = fields;
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
    author: args.author,
    authorUrl: args.authorUrl,
    authorIcon: args.authorIcon,
    commit: args.commit,
    fields: args.fields,
    // CI gives us no explicit timestamp — stamp "now" so Discord shows when
    // the run finished.
    timestamp: args.timestamp ?? new Date().toISOString(),
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
