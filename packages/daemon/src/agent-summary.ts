import { resolveAgentBinary } from "./procs";
import {
  listCodexModelsFresh,
  resolveCodexBinary,
  type CodexModelInfo,
} from "./codex-app-server";
import { cleanAiTitle } from "./ollama-summarize";

type Agent = "claude" | "codex" | "gemini";

/** Only choose a small model advertised by this Codex installation. Catalog
 * order is preserved so the CLI's preferred current generation wins. */
export function pickSmallCodexModel(models: CodexModelInfo[]): string | null {
  const small = models.find((m) => {
    if (m.hidden) return false;
    const name = `${m.id} ${m.model ?? ""} ${m.displayName ?? ""}`;
    return (
      /(?:^|[-\s])(?:mini|nano|luna|small)(?:$|[-\s])/i.test(name) ||
      /\b(?:fast and affordable|cost efficient|low.cost|smaller model)\b/i.test(
        m.description ?? "",
      )
    );
  });
  return small?.model ?? small?.id ?? null;
}

export function parseAgentSummary(
  raw: string,
): { title: string; body: string } | null {
  const match = raw
    .trim()
    .match(/^TITLE:\s*(.+?)\s*\r?\nSUMMARY:\s*([\s\S]+)$/i);
  if (!match) return null;
  const title = cleanAiTitle(match[1]!);
  const body = match[2]!.trim();
  return title && body ? { title, body } : null;
}

export async function runAgentSummary(
  agent: Agent,
  transcript: string,
  cwd: string,
  signal: AbortSignal,
): Promise<{ title: string; body: string; model: string }> {
  if (signal.aborted) throw new Error("Summary cancelled.");
  let bin: string | null;
  let model: string;
  let args: string[];
  const prompt =
    "Summarize the developer chat excerpt below. Do not use tools or inspect files. " +
    "Output exactly two lines: TITLE: <3 to 6 words> and SUMMARY: <one brief paragraph under 300 characters>. " +
    "Address the developer as you. No markdown, preamble, or extra text.\n\n" +
    transcript;

  if (agent === "codex") {
    model = pickSmallCodexModel(await listCodexModelsFresh(cwd)) ?? "";
    if (!model)
      throw new Error(
        "No small Codex model is available in the current CLI catalog.",
      );
    bin = resolveCodexBinary();
    args = [
      "exec",
      "--model",
      model,
      "--ephemeral",
      "--sandbox",
      "read-only",
      "--skip-git-repo-check",
      "--config",
      "model_reasoning_effort=low",
      "--config",
      "approval_policy=never",
      "-",
    ];
  } else {
    bin = await resolveAgentBinary(agent);
    if (!bin) throw new Error(`${agent} CLI is not installed.`);
    // These are rolling family aliases resolved by the installed CLI, not
    // pinned model IDs. The CLI keeps them current as model generations change.
    model = agent === "claude" ? "haiku" : "flash-lite";
    args =
      agent === "claude"
        ? [
            "-p",
            "--model",
            model,
            "--tools",
            "",
            "--no-session-persistence",
            "--output-format",
            "text",
          ]
        : [
            "--model",
            model,
            "--prompt",
            "Summarize the text on stdin.",
            "--output-format",
            "text",
          ];
  }

  if (signal.aborted) throw new Error("Summary cancelled.");
  const proc = Bun.spawn([bin, ...args], {
    cwd,
    stdin: "pipe",
    stdout: "pipe",
    stderr: "pipe",
  });
  proc.stdin.write(prompt);
  proc.stdin.end();
  const stop = () => proc.kill();
  signal.addEventListener("abort", stop, { once: true });
  const timeout = setTimeout(stop, 60_000);
  try {
    const [output, error, exitCode] = await Promise.all([
      new Response(proc.stdout).text(),
      new Response(proc.stderr).text(),
      proc.exited,
    ]);
    if (signal.aborted) throw new Error("Summary cancelled.");
    if (exitCode !== 0)
      throw new Error(
        error.trim().slice(-300) || `${agent} exited with ${exitCode}`,
      );
    const parsed = parseAgentSummary(output);
    if (!parsed) throw new Error(`${agent} returned an invalid summary.`);
    return { ...parsed, model: `${agent}:${model}` };
  } finally {
    clearTimeout(timeout);
    signal.removeEventListener("abort", stop);
  }
}
