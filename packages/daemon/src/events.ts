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
 * - An `undo` event toggles the referenced action to the undone state; a
 *   `redo` event toggles it back. Order matters — the *last* toggle wins.
 * - File format: JSONL at `<workspace>/events.jsonl`. One event per line.
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
  redoable: boolean;
}

const EVENTS_FILE = "events.jsonl";
const TOGGLE_TYPES = new Set(["undo", "redo"]);

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

    // Compute the final toggle state per action id by walking events in order.
    // undo -> undone; redo -> applied; later wins.
    const undoneById = new Map<string, boolean>();
    for (const e of events) {
      if (!TOGGLE_TYPES.has(e.type)) continue;
      const eventId = (e.payload as { eventId?: unknown } | null | undefined)
        ?.eventId;
      if (typeof eventId !== "string") continue;
      undoneById.set(eventId, e.type === "undo");
    }

    return events.map((e) => {
      const isToggle = TOGGLE_TYPES.has(e.type);
      const reversible = !isToggle && e.inverse !== undefined;
      const undone = undoneById.get(e.id) ?? false;
      return {
        ...e,
        undone,
        reversible,
        redoable: reversible && undone,
      };
    });
  }

  async findById(id: string): Promise<ListedEvent | null> {
    const all = await this.list();
    return all.find((e) => e.id === id) ?? null;
  }
}
