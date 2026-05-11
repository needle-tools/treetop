import { join } from "node:path";
import {
  appendFile,
  readFile,
  access,
  writeFile,
} from "node:fs/promises";
import { randomUUID } from "node:crypto";

export type Actor = "user" | "agent" | "supergit";

/**
 * The supergit event log. Every mutation goes through here, append-only.
 *
 * - Reversible events carry an `inverse` payload sufficient to undo them.
 * - An `undo` event references the original event's id; when reading the log,
 *   we compute each event's `undone` flag by scanning for matching undo events.
 *
 * File format: JSONL at `<workspace>/events.jsonl`. One event per line.
 */
export interface EventInput<P = unknown, I = unknown> {
  type: string;
  actor: Actor;
  payload: P;
  inverse?: I;
}

export interface Event<P = unknown, I = unknown> extends EventInput<P, I> {
  id: string;
  timestamp: string;
}

export interface ListedEvent<P = unknown, I = unknown> extends Event<P, I> {
  undone: boolean;
  reversible: boolean;
}

const EVENTS_FILE = "events.jsonl";

export class EventLog {
  private constructor(public readonly path: string) {}

  static async open(workspacePath: string): Promise<EventLog> {
    const path = join(workspacePath, EVENTS_FILE);
    try {
      await access(path);
    } catch {
      await writeFile(path, "");
    }
    return new EventLog(path);
  }

  async append<P, I>(input: EventInput<P, I>): Promise<Event<P, I>> {
    const event: Event<P, I> = {
      id: randomUUID(),
      timestamp: new Date().toISOString(),
      ...input,
    };
    await appendFile(this.path, JSON.stringify(event) + "\n");
    return event;
  }

  async list(): Promise<ListedEvent[]> {
    let raw: string;
    try {
      raw = await readFile(this.path, "utf-8");
    } catch {
      return [];
    }
    const events: Event[] = raw
      .split("\n")
      .filter((line) => line.length > 0)
      .map((line) => JSON.parse(line) as Event);

    const undoneIds = new Set<string>();
    for (const e of events) {
      if (e.type === "undo") {
        const eventId = (e.payload as { eventId?: unknown } | null | undefined)
          ?.eventId;
        if (typeof eventId === "string") undoneIds.add(eventId);
      }
    }

    return events.map((e) => ({
      ...e,
      undone: undoneIds.has(e.id),
      reversible: e.inverse !== undefined && e.type !== "undo",
    }));
  }

  async findById(id: string): Promise<ListedEvent | null> {
    const all = await this.list();
    return all.find((e) => e.id === id) ?? null;
  }
}
