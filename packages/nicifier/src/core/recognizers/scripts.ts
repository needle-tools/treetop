import type { VisualCommandSummary } from "../types.js";
import { lowerCommandName } from "./common.js";

export function summarizeDirectScriptCommand(
  tokens: readonly string[],
): Extract<VisualCommandSummary, { kind: "script-file" }> | undefined {
  if (tokens.length < 2) return undefined;
  const runtimeIndex = tokens.findIndex((token) =>
    /^(?:python3?|node|bun|deno|swift|ruby|perl|bash|dash|fish|ksh|sh|zsh)$/.test(
      lowerCommandName(token),
    ),
  );
  if (runtimeIndex < 0) return undefined;
  const runtime = lowerCommandName(tokens[runtimeIndex]);
  for (let index = runtimeIndex + 1; index < tokens.length; index += 1) {
    const token = tokens[index]!;
    if (token === "-c" || token === "-e" || token === "--eval")
      return undefined;
    if (token === "-m") return undefined;
    if (optionTakesValue(runtime, token)) {
      index += 1;
      continue;
    }
    if (token.startsWith("-")) continue;
    if (!looksLikeScriptPath(token)) continue;
    return {
      kind: "script-file",
      language: scriptLanguage(runtime),
      script: token,
      args: tokens.slice(index + 1),
    };
  }
  return undefined;
}

export function scriptLanguage(runtime: string): string {
  const lower = runtime.toLowerCase();
  if (lower === "node" || lower === "bun" || lower === "deno") {
    return "JavaScript";
  }
  if (lower.startsWith("python")) return "Python";
  if (lower === "swift") return "Swift";
  if (lower === "ruby") return "Ruby";
  if (lower === "perl") return "Perl";
  return "Shell";
}

function optionTakesValue(runtime: string, token: string): boolean {
  if (runtime === "node" || runtime === "bun" || runtime === "deno") {
    return /^(?:--require|-r|--loader|--import|--env-file|--conditions)$/.test(
      token,
    );
  }
  if (runtime.startsWith("python")) {
    return /^(?:-W|-X)$/.test(token);
  }
  return false;
}

function looksLikeScriptPath(path: string): boolean {
  return /\.(?:[cm]?js|jsx|ts|tsx|mjs|cjs|py|rb|pl|swift|bash|sh|zsh|fish|ksh)$/i.test(
    path,
  );
}
