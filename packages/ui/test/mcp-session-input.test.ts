import { expect, test } from "bun:test";
import {
  createSessionInputController,
  registerSessionInput,
  applySessionInput,
  type InputSnapshot,
} from "../src/mcp-session-input";

function fixture() {
  const state: InputSnapshot = {
    owner: "target",
    known: true,
    text: "",
    attachments: 0,
    queue: [],
  };
  let sends = 0;
  const controller = createSessionInputController({
    snapshot: () => state,
    setText: (text) => {
      state.text = text;
    },
    submit: async () => {
      sends++;
      state.text = "";
      return { status: "queued" };
    },
  });
  return { state, controller, sends: () => sends };
}
const command = {
  action: "session_input" as const,
  source: "target",
  text: "Follow up",
  senderSource: "sender",
};
test("prefill never overwrites user drafts or unknown CLI input", async () => {
  const { state, controller, sends } = fixture();
  state.text = "user draft";
  expect(
    (await controller.act({ ...command, operation: "stage" })).status,
  ).toBe("draft_exists");
  expect(state.text).toBe("user draft");
  state.known = false;
  state.text = "";
  expect(
    (await controller.act({ ...command, operation: "stage" })).status,
  ).toBe("input_unknown");
  expect(state.text).toBe("");
  expect(sends()).toBe(0);
});
test("AI draft is labeled, inspected, and only explicitly submitted unchanged", async () => {
  const { state, controller, sends } = fixture();
  const staged = await controller.act({ ...command, operation: "stage" });
  expect(staged.status).toBe("staged");
  expect(sends()).toBe(0);
  expect(controller.inspect().draft).toMatchObject({
    text: "Follow up",
    author: "ai",
    senderSource: "sender",
    edited: false,
  });
  state.text += " edited";
  expect(controller.inspect().draft).toMatchObject({ edited: true });
  expect(
    (
      await controller.act({
        ...command,
        operation: "submit",
        draftId: staged.draftId as string,
      })
    ).status,
  ).toBe("draft_changed");
  expect(sends()).toBe(0);
  state.text = command.text;
  expect(
    (
      await controller.act({
        ...command,
        operation: "submit",
        draftId: staged.draftId as string,
      })
    ).status,
  ).toBe("queued");
  expect(sends()).toBe(1);
  expect(
    (
      await controller.act({
        ...command,
        operation: "submit",
        draftId: staged.draftId as string,
      })
    ).status,
  ).toBe("draft_changed");
});
test("inspection bounds draft and queue text and preserves provenance", () => {
  const { state, controller } = fixture();
  state.text = "x".repeat(90);
  state.queue = [{ id: "q", text: "y".repeat(90), ai: { source: "sender" } }];
  const result = controller.inspect(100) as any;
  expect(result.draft.text.length + result.queue[0].text.length).toBe(100);
  expect(result.queue[0].author).toBe("ai");
  expect(result.queue[0].truncated).toBe(true);
});

test("clearing or sending an AI draft does not label later user input as AI", async () => {
  const { state, controller } = fixture();
  await controller.act({ ...command, operation: "stage" });
  state.text = "";
  controller.inspect();
  state.text = "My own message";
  expect(controller.inspect().draft).toMatchObject({ author: "user" });
  state.text = "";
  await controller.act({ ...command, operation: "send" });
  state.text = "Another user draft";
  expect(controller.inspect().draft).toMatchObject({ author: "user" });
});

test("concurrent send requests cannot duplicate an in-flight submission", async () => {
  const state: InputSnapshot = {
    owner: "target",
    known: true,
    text: "",
    attachments: 0,
    queue: [],
  };
  let finish!: () => void;
  const gate = new Promise<void>((resolve) => {
    finish = resolve;
  });
  let sends = 0;
  const controller = createSessionInputController({
    snapshot: () => state,
    setText: (text) => {
      state.text = text;
    },
    submit: async () => {
      sends++;
      state.text = "";
      await gate;
      return { status: "submitted" };
    },
  });
  const first = controller.act({ ...command, operation: "send" });
  expect((await controller.act({ ...command, operation: "send" })).status).toBe(
    "submission_pending",
  );
  finish();
  await first;
  expect(sends).toBe(1);
});

test("a failed submission retains AI provenance on its restored draft", async () => {
  const state: InputSnapshot = {
    owner: "target",
    known: true,
    text: "",
    attachments: 0,
    queue: [],
  };
  const controller = createSessionInputController({
    snapshot: () => state,
    setText: (text) => {
      state.text = text;
    },
    submit: async () => {
      state.text = "";
      controller.inspect();
      state.text = command.text;
      throw new Error("offline");
    },
  });
  await expect(
    controller.act({ ...command, operation: "send" }),
  ).rejects.toThrow("offline");
  expect(controller.inspect().draft).toMatchObject({
    author: "ai",
    text: command.text,
  });
});

test("input routing rejects missing or ambiguous owners and unregisters on disposal", async () => {
  const command = {
    action: "session_input" as const,
    operation: "inspect" as const,
    source: "unique-target",
  };
  await expect(applySessionInput(command)).rejects.toThrow("not mounted");
  const first = registerSessionInput({
    matches: (source) => source === command.source,
    act: async () => ({ inputState: "empty" }),
  });
  let second: (() => void) | undefined;
  try {
    expect(await applySessionInput(command)).toEqual({ inputState: "empty" });
    second = registerSessionInput({
      matches: (source) => source === command.source,
      act: async () => ({ inputState: "draft" }),
    });
    await expect(applySessionInput(command)).rejects.toThrow(
      "multiple columns",
    );
  } finally {
    second?.();
    first();
  }
  await expect(applySessionInput(command)).rejects.toThrow("not mounted");
});
