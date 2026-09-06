import type { VisualCommandSummary } from "../types.js";
import {
  lastPathSegment,
  lowerCommandName,
  positionalTokens,
} from "./common.js";

export function summarizeSystemProbe(
  tokens: readonly string[],
): VisualCommandSummary | undefined {
  const command = lowerCommandName(tokens[0]);
  if (command === "df") {
    const targets = positionalTokens(
      tokens.slice(1),
      new Set(["-B", "--block-size"]),
    ).filter((token) => token !== ".");
    return {
      kind: "system-probe",
      action: "disk-space",
      targets: targets.length ? targets : ["."],
    };
  }
  if (command === "stat") {
    const targets = positionalTokens(
      tokens.slice(1),
      new Set(["-f", "-c", "--format", "--printf"]),
    );
    if (targets.length) {
      return {
        kind: "system-probe",
        action: "file-metadata",
        targets,
      };
    }
  }
  if (command === "file") {
    const targets = positionalTokens(tokens.slice(1), new Set(["-m", "-F"]));
    if (targets.length) {
      return { kind: "system-probe", action: "file-type", targets };
    }
  }
  if (command === "readlink" || command === "realpath") {
    const targets = positionalTokens(tokens.slice(1), new Set());
    if (targets.length) {
      return { kind: "system-probe", action: "resolve-link", targets };
    }
  }
  if (command === "which" || command === "where") {
    const targets = positionalTokens(tokens.slice(1), new Set());
    if (targets.length) {
      return { kind: "system-probe", action: "find-command", targets };
    }
  }
  if (command === "command" && tokens[1] === "-v" && tokens[2]) {
    return {
      kind: "system-probe",
      action: "find-command",
      targets: [tokens[2]],
    };
  }
  if (command === "shasum" || command === "sha256sum" || command === "md5sum") {
    const targets = positionalTokens(tokens.slice(1), new Set(["-a"]));
    const fileTargets = targets.filter((target) => !/^\d+$/.test(target));
    if (fileTargets.length) {
      return {
        kind: "system-probe",
        action: "checksum",
        targets: fileTargets,
      };
    }
  }
  return undefined;
}

export function systemProbeLabel(
  summary: Extract<VisualCommandSummary, { kind: "system-probe" }>,
): string {
  const target = summary.targets.map(lastPathSegment).join(", ");
  if (summary.action === "disk-space") return `Check disk space ${target}`;
  if (summary.action === "file-metadata") {
    return `Check file metadata ${target}`;
  }
  if (summary.action === "file-type") return `Identify file ${target}`;
  if (summary.action === "resolve-link") return `Resolve link ${target}`;
  if (summary.action === "find-command") return `Find command ${target}`;
  return `Checksum ${target}`;
}
