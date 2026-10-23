import { expect, test } from "bun:test";
import {
  voiceMessageAllowed,
  voiceMessageGuidance,
} from "../src/voice-message";
test("MCP voice defaults on and respects a saved refusal", () => {
  expect(voiceMessageAllowed({})).toBe(true);
  expect(
    voiceMessageAllowed({
      "supergit:settings": JSON.stringify({ "mcp.voiceMessage": false }),
    }),
  ).toBe(false);
});

test("voice eagerness defaults to milestones, uses saved preferences and respects disabled voice", () => {
  const prefs = (eagerness: unknown, enabled = true) => ({
    "supergit:settings": JSON.stringify({
      "mcp.voiceMessageEagerness": eagerness,
      "mcp.voiceMessage": enabled,
    }),
  });
  expect(voiceMessageGuidance({})).toContain("milestones");
  expect(voiceMessageGuidance(prefs("on_request"))).toContain(
    "only when the user explicitly asks",
  );
  expect(voiceMessageGuidance(prefs("frequent"))).toContain("frequent");
  expect(voiceMessageGuidance(prefs("invalid"))).toBe(voiceMessageGuidance({}));
  expect(voiceMessageGuidance(prefs("frequent", false))).toContain("disabled");
});
