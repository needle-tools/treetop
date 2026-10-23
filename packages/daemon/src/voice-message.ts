export const MCP_VOICE_MESSAGE_KEY = "mcp.voiceMessage";
export const VOICE_MESSAGE_EAGERNESS_KEY = "mcp.voiceMessageEagerness";
export const VOICE_MESSAGE_EAGERNESS_OPTIONS = [
  { value: "on_request", label: "On request" },
  { value: "milestones", label: "Milestones" },
  { value: "frequent", label: "Frequent updates" },
] as const;

export function voiceMessageGuidance(prefs: Record<string, string>): string {
  if (!voiceMessageAllowed(prefs))
    return "Voice messages are disabled in Treetop Settings. Do not call this tool.";
  const eagerness = JSON.parse(prefs["supergit:settings"] ?? "{}")[
    VOICE_MESSAGE_EAGERNESS_KEY
  ];
  const common =
    " Keep speech concise and describe observable progress, decisions and results; never narrate private reasoning. Respect requests for quiet. This preference is guidance, not a requirement to speak on every turn.";
  switch (eagerness) {
    case "on_request":
      return (
        "Speak only when the user explicitly asks for spoken output; otherwise communicate in text." +
        common
      );
    case "frequent":
      return (
        "Use frequent brief spoken progress updates proactively: communicate notable progress, changes in approach, blockers and completion. Batch routine actions; do not narrate every tool call or repeat the same status." +
        common
      );
    default:
      return (
        "Speak proactively at meaningful milestones, blockers needing user attention, and completion. Skip routine steps and minor updates; avoid interrupting the user repeatedly." +
        common
      );
  }
}
export function voiceMessageAllowed(prefs: Record<string, string>): boolean {
  return (
    JSON.parse(prefs["supergit:settings"] ?? "{}")[MCP_VOICE_MESSAGE_KEY] !==
    false
  );
}
