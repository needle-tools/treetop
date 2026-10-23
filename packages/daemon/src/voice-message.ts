export const MCP_VOICE_MESSAGE_KEY = "mcp.voiceMessage";
export function voiceMessageAllowed(prefs: Record<string, string>): boolean {
  return (
    JSON.parse(prefs["supergit:settings"] ?? "{}")[MCP_VOICE_MESSAGE_KEY] !==
    false
  );
}
