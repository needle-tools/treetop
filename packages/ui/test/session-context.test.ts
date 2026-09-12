import { describe, expect, test } from "bun:test";
import {
  createSessionContextTimeline,
  sessionContextStateAtLine,
} from "@treetop/nicifier";

describe("recorded session context", () => {
  test("reconstructs Codex input and replaces history at compaction boundaries", () => {
    const timeline = createSessionContextTimeline([
      { type: "session_meta", payload: { id: "s1", base_instructions: { text: "base" } } },
      { type: "turn_context", payload: { model: "gpt-6-astra", cwd: "/repo" } },
      { type: "response_item", payload: { type: "message", role: "user", content: [{ type: "input_text", text: "old" }] } },
      { type: "response_item", payload: { type: "message", role: "assistant", content: [{ type: "output_text", text: "answer" }] } },
      {
        type: "compacted",
        payload: {
          replacement_history: [
            { type: "message", role: "developer", content: [{ type: "input_text", text: "summary" }] },
          ],
          window_number: 2,
        },
      },
      { type: "response_item", payload: { type: "message", role: "user", content: [{ type: "input_text", text: "new" }] } },
    ]);

    const before = sessionContextStateAtLine(timeline, 4);
    expect(before.items.map((item) => item.value)).toHaveLength(2);
    expect(before.baseInstructions).toEqual({ text: "base" });
    expect(before.turnContext).toMatchObject({ model: "gpt-6-astra", cwd: "/repo" });

    const compacted = sessionContextStateAtLine(timeline, 5);
    expect(compacted.items.map((item) => item.value)).toEqual([
      { type: "message", role: "developer", content: [{ type: "input_text", text: "summary" }] },
    ]);
    expect(compacted.compactionCount).toBe(1);

    const after = sessionContextStateAtLine(timeline, 6);
    expect(after.items.map((item) => (item.value as { role?: string }).role)).toEqual(["developer", "user"]);
    expect(after.completeness).toBe("recorded");
  });

  test("follows the active Claude parent chain and excludes sidechains", () => {
    const timeline = createSessionContextTimeline([
      { type: "user", uuid: "u1", parentUuid: null, isSidechain: false, message: { role: "user", content: "one" } },
      { type: "assistant", uuid: "a1", parentUuid: "u1", isSidechain: false, message: { role: "assistant", content: [{ type: "text", text: "two" }] } },
      { type: "assistant", uuid: "side", parentUuid: "u1", isSidechain: true, message: { role: "assistant", content: "ignore" } },
      { type: "attachment", uuid: "attachment", parentUuid: "a1", isSidechain: false, attachment: { type: "file", filename: "notes.txt" } },
      { type: "user", uuid: "u2", parentUuid: "attachment", isSidechain: false, message: { role: "user", content: "three" } },
    ]);
    const state = sessionContextStateAtLine(timeline, 5);
    expect(state.agent).toBe("claude");
    expect(state.items.map((item) => item.id)).toEqual(["u1", "a1", "attachment", "u2"]);
    expect(state.completeness).toBe("partial");
  });

  test("preserves opaque Codex items instead of pretending their contents are inspectable", () => {
    const timeline = createSessionContextTimeline([
      { type: "session_meta", payload: { id: "s1" } },
      { type: "response_item", payload: { type: "reasoning", encrypted_content: "ciphertext" } },
    ]);
    const state = sessionContextStateAtLine(timeline, 2);
    expect(state.opaqueItemCount).toBe(1);
    expect(state.limitations).toContain("Opaque provider-managed items are shown as recorded but cannot be decrypted.");
  });
});
