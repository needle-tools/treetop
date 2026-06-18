// Pure formatters for error-log entries and undo-log events, extracted
// from App.svelte. `errorKindLabel` and `eventToText` are wholly pure;
// `anchorLabel` and `eventLabel` used to read the reactive `repos`
// snapshot directly — they now take it as an explicit trailing
// parameter so they're pure functions of their inputs. Behavior is
// pinned by event-format.test.ts.

import type { FrontendErrorEntry } from "./errors";
import { noteExcerpt } from "./display-helpers";

/** Undo-log event as served by the daemon's events API. Mirrors the
 *  shape App.svelte consumes; the formatters below only read `type`,
 *  `payload`, and `inverse`. */
export interface Event {
  id: string;
  timestamp: string;
  type: string;
  actor: "user" | "agent" | "supergit";
  payload: any;
  inverse?: any;
  undone: boolean;
  reversible: boolean;
  redoable: boolean;
}

/** Structural slice of a repo that `anchorLabel` needs to map a
 *  `worktree:`/`repo:` anchor back to a human label. App.svelte's
 *  richer `Repo` is structurally assignable to this. */
export interface Repo {
  name?: string;
  path: string;
  worktrees?: Array<{ path: string; branch?: string }>;
}

export function errorKindLabel(e: FrontendErrorEntry): string {
  if (e.kind === "server") return "server";
  if (e.kind === "fetch") return "fetch";
  if (e.kind === "diagnostic") return "diag";
  if (e.kind === "rejection") return "unhandled";
  return "uncaught";
}

/** Render one event as plain text for the clipboard. Deduped rows hold
 *  the latest occurrence's details, so this copies the most recent
 *  instance (plus the ×N count for context). */
export function eventToText(e: FrontendErrorEntry): string {
  const lines: string[] = [
    `${e.timestamp} ${errorKindLabel(e).toUpperCase()} ${e.source}`,
  ];
  const req = [e.method, e.route].filter(Boolean).join(" ");
  if (req) lines.push(e.status !== undefined ? `${req} → ${e.status}` : req);
  lines.push(e.message);
  if (e.count && e.count > 1) lines.push(`(×${e.count} occurrences)`);
  if (e.stack) lines.push("", e.stack);
  if (e.extra && Object.keys(e.extra).length > 0) {
    lines.push("", JSON.stringify(e.extra, null, 2));
  }
  return lines.join("\n");
}

/** Pretty-print an anchor string for the events list. Maps a
 *  `worktree:<path>` anchor back to `<repo>/<branch>` by looking up
 *  the current `repos` snapshot. Falls back to the basename of the
 *  raw path when the repo's been removed since the event was logged
 *  (events are historical; repos may have changed). */
export function anchorLabel(
  anchor: string | undefined,
  repos: Repo[],
): string {
  if (!anchor) return "";
  if (anchor.startsWith("worktree:")) {
    const path = anchor.slice("worktree:".length);
    for (const r of repos) {
      const wt = r.worktrees?.find((w) => w.path === path);
      if (wt) return `${r.name ?? "?"} · ${wt.branch}`;
    }
    return path.split("/").filter(Boolean).pop() ?? path;
  }
  if (anchor.startsWith("repo:")) {
    const path = anchor.slice("repo:".length);
    const r = repos.find((r) => r.path === path);
    if (r) return r.name ?? path;
    return path.split("/").filter(Boolean).pop() ?? path;
  }
  if (anchor.startsWith("commit:")) {
    return `commit ${anchor.slice("commit:".length).slice(0, 8)}`;
  }
  return anchor;
}

export function eventLabel(ev: Event, repos: Repo[]): string {
  if (ev.type === "add_repo") {
    const inv = ev.inverse as
      | { repo?: { name?: string; path?: string } }
      | undefined;
    const name =
      inv?.repo?.name ??
      (ev.payload?.path as string | undefined)
        ?.split("/")
        .filter(Boolean)
        .pop();
    return `Added ${name ?? "(unknown)"}`;
  }
  if (ev.type === "remove_repo") {
    const inv = ev.inverse as
      | { repo?: { name?: string; path?: string } }
      | undefined;
    const name = inv?.repo?.name ?? inv?.repo?.path;
    return `Removed ${name ?? "(unknown)"}`;
  }
  if (ev.type === "rename_repo") {
    const p = ev.payload as { newName?: string };
    const inv = ev.inverse as { oldName?: string };
    return `Renamed ${inv?.oldName ?? "?"} → ${p?.newName ?? "?"}`;
  }
  if (ev.type === "create_note" || ev.type === "remove_note") {
    const inv = ev.inverse as
      | { note?: { body?: string; anchors?: string[] } }
      | undefined;
    const excerpt = noteExcerpt(inv?.note?.body);
    const where = anchorLabel(inv?.note?.anchors?.[0], repos);
    const verb = ev.type === "create_note" ? "Created note" : "Deleted note";
    const head = excerpt ? `${verb} “${excerpt}”` : verb;
    return where ? `${head} · ${where}` : head;
  }
  if (ev.type === "session_imported") {
    // Format: "Imported «<title>» from <machineLabel> → <repoName>"
    // Falls back gracefully when older payloads lack the enriched
    // fields (title / originMachineLabel / repoName were added later).
    const p = ev.payload as {
      title?: string;
      originMachineLabel?: string;
      originMachine?: string;
      repoName?: string;
      repoRemote?: string;
    };
    const title = p?.title ? `“${p.title.slice(0, 60)}”` : "session";
    const from = p?.originMachineLabel ?? p?.originMachine ?? "another machine";
    const repo = p?.repoName ?? p?.repoRemote ?? "repo";
    return `Imported ${title} from ${from} → ${repo}`;
  }
  return ev.type;
}
