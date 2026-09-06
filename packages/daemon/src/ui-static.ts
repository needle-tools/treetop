const REPLAY_LAB_PATHS = new Set([
  "/replay-lab",
  "/replay-lab/",
  "/codex-replay",
  "/codex-replay/",
]);

export function uiStaticRequestPath(pathname: string): string {
  if (pathname === "/") return "/index.html";
  if (REPLAY_LAB_PATHS.has(pathname)) return "/replay-lab.html";
  return pathname;
}
