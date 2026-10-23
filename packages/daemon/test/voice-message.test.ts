import { expect, test } from "bun:test";
import { voiceMessageAllowed } from "../src/voice-message";
test("MCP voice defaults on and respects a saved refusal", () => {
  expect(voiceMessageAllowed({})).toBe(true);
  expect(
    voiceMessageAllowed({
      "supergit:settings": JSON.stringify({ "mcp.voiceMessage": false }),
    }),
  ).toBe(false);
});
