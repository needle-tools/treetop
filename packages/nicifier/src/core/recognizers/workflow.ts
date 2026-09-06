import type { VisualCommandSummary } from "../types.js";
import { lowerCommandName, optionValue } from "./common.js";

export function summarizeWorkflowCli(
  tokens: readonly string[],
): VisualCommandSummary | undefined {
  const command = lowerCommandName(tokens[0]);
  if (command === "gh") return summarizeGitHubCli(tokens);
  if (command === "gcloud") return summarizeGcloudCli(tokens);
  if (command === "tailscale") return summarizeTailscaleCli(tokens);
  if (command === "tmux") return summarizeTmuxCli(tokens);
  return undefined;
}

function summarizeGitHubCli(
  tokens: readonly string[],
): Extract<VisualCommandSummary, { kind: "workflow" }> | undefined {
  const area = tokens[1]?.toLowerCase();
  const action = tokens[2]?.toLowerCase();
  if ((area === "pr" || area === "issue") && action === "view") {
    const id = tokens[3];
    return {
      kind: "workflow",
      tool: "GitHub",
      action: `Inspect GitHub ${area.toUpperCase()}${id ? ` ${id}` : ""}`,
      targets: id ? [id] : [],
    };
  }
  if ((area === "pr" || area === "issue") && action === "list") {
    return {
      kind: "workflow",
      tool: "GitHub",
      action: `List GitHub ${area === "pr" ? "PRs" : "issues"}`,
      targets: [],
    };
  }
  if (area === "run") {
    return {
      kind: "workflow",
      tool: "GitHub",
      action: "Inspect GitHub Actions runs",
      targets: [],
    };
  }
  return undefined;
}

function summarizeGcloudCli(
  tokens: readonly string[],
): Extract<VisualCommandSummary, { kind: "workflow" }> | undefined {
  const area = tokens[1]?.toLowerCase();
  const subject = tokens[2]?.toLowerCase();
  const verb = tokens[3]?.toLowerCase();
  if (area === "config" && subject === "get-value") {
    const key = tokens[3];
    return {
      kind: "workflow",
      tool: "Google Cloud",
      action: `Check Google Cloud${key ? ` ${key}` : " config"}`,
      targets: key ? [key] : [],
    };
  }
  if (area === "run" && subject === "services" && verb === "list") {
    const region = optionValue(tokens, ["--region"]);
    return {
      kind: "workflow",
      tool: "Google Cloud",
      action: `List Google Cloud Run services${region ? ` ${region}` : ""}`,
      targets: region ? [region] : [],
    };
  }
  if (area === "projects" && subject === "list") {
    return {
      kind: "workflow",
      tool: "Google Cloud",
      action: "List Google Cloud projects",
      targets: [],
    };
  }
  return undefined;
}

function summarizeTailscaleCli(
  tokens: readonly string[],
): Extract<VisualCommandSummary, { kind: "workflow" }> | undefined {
  const action = tokens[1]?.toLowerCase();
  if (action === "status") {
    return {
      kind: "workflow",
      tool: "Tailscale",
      action: "Check Tailscale status",
      targets: [],
    };
  }
  if (action === "ip") {
    return {
      kind: "workflow",
      tool: "Tailscale",
      action: "Check Tailscale IP",
      targets: [],
    };
  }
  return undefined;
}

function summarizeTmuxCli(
  tokens: readonly string[],
): Extract<VisualCommandSummary, { kind: "session-manager" }> | undefined {
  const action = tokens[1]?.toLowerCase();
  if (action === "ls" || action === "list-sessions") {
    return { kind: "session-manager", tool: "tmux", action: "list" };
  }
  return undefined;
}
