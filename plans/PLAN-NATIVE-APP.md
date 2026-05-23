# PLAN-NATIVE-APP.md — packaging supergit as a native app

Captures the discussion about turning the current Bun-daemon + Svelte-SPA
setup into a shippable native app, including the named-localhost
question and the node-pty / Bun compatibility check.

Status: discussion + one empirical data point. No implementation
commitments yet.

## What we have today
- Daemon: Bun + TypeScript, ~30 src files, ~3.7k-line `server.ts`. Heavy
  use of Bun-specific APIs: `Bun.spawn` (dozens of call sites),
  `Bun.serve`, `Bun.file`, `Bun.gc`.
- UI: Svelte + Vite SPA, built to `packages/ui/dist/`.
- PTY hosting: node-pty runs in a Node sidecar (`terminals/helper.mjs`)
  because node-pty's PTY master fd returned ENXIO when read through
  Bun's libuv stream wrappers. Daemon ↔ helper talks NDJSON over stdio.
- External tools the daemon shells out to: `git`, `ollama`, editor
  binaries (`code`, `idea`, `fork`, …), MCP servers, OS file pickers.
  None of these are bundleable — they stay on the user's machine.
- Prod entry: `start.ts` → `bun run packages/daemon/src/server.ts`,
  default port `27787`, point a browser at `http://localhost:27787`.

## The question the user asked
"How easy/hard would it be to make a native compiled app out of this,
with ALL existing functionality bundled into one app?"

## Three realistic packaging paths

### A. `bun build --compile` → single self-contained binary
- Cheapest path. Bun already supports compiling TS to a standalone
  executable.
- Embed `packages/ui/dist` via Bun's asset embedding (or extract to a
  temp dir at boot).
- Ship `helper.mjs` + the per-platform node-pty prebuilt `.node`
  alongside the binary. Bun's `--compile` can't embed native modules.
- On launch: `Bun.serve` on a port and open the user's default browser
  at that URL.
- Not a "native window" — it's a self-contained CLI/server you
  double-click. Closest to today's prod path.
- Estimate: 1–2 days for a working build artifact, longer for installer
  + signing/notarisation.

### B. Electrobun (Bun + native webview)
- Best fit if we want a real desktop app. Electrobun is Bun-based, so
  daemon code runs essentially unchanged.
- Uses WKWebView (mac) / WebView2 (windows), no Chromium. Much smaller
  bundle than Electron.
- We still ship node-pty natively per arch — same constraint as A.
- Buys us: app icon, dock presence, file dialogs, native window chrome,
  signing/notarisation flows, auto-update, no browser tab.
- Bonus: if Electrobun owns the window, the user never sees the URL,
  which collapses the entire "named-localhost" question (see below).
- Estimate: 1–2 weeks for a first end-to-end build.

### C. Tauri / Electron — rejected
- Tauri: Rust shell + WebView. Bun daemon becomes a sidecar binary
  spawned by Tauri. Two runtimes shipped, Rust glue layer, no real win
  over Electrobun.
- Electron: Node runtime, not Bun. Every `Bun.spawn` / `Bun.serve` /
  `Bun.file` call (dozens) would need porting to `child_process` /
  `http` / `fs`. Plus ~100MB+ Chromium bundle. Not worth it.

## Friction points that apply to all paths
- node-pty native binary per platform: mac arm64/x64, linux x64/arm64,
  windows x64. CI matrix.
- External tools (`git`, `ollama`, editors, MCP) stay on user's
  machine. App must degrade gracefully when they're missing (mostly
  already does).
- Workspace state path is already user-chosen, no change needed.
- `start.ts` shutdown dance (`lsof`, `kill -9`) is irrelevant inside a
  packaged app; replace with in-process lifecycle.
- Code signing / notarisation, especially on mac. Real annoyance
  regardless of framework.

## Named-localhost sub-discussion

User asked whether the app could start on a name like `http://supergit`
instead of `http://localhost:27787`.

Three levels of effort:
- **A. `http://supergit.local:27787` via mDNS** — zero admin prompts,
  cross-platform via Bonjour/avahi/Win10+ mDNS. Still carries the port
  suffix.
- **B. `http://supergit:27787` via `/etc/hosts`** — one admin prompt at
  install time, then clean. Standard installer pattern.
- **C. `http://supergit` (no port)** — needs both name resolution *and*
  binding to port 80, which is privileged on mac/linux. Doable via
  launchd/systemd socket activation, but significant cross-platform
  plumbing for a short-URL improvement, and risks colliding with the
  user's other services on :80.

**User's conclusion:** if Electrobun owns the window, the URL is never
visible and the whole question is moot — current `localhost:<port>` is
fine. The named-localhost work only becomes interesting if we ship via
path A (browser-based) and want to make the URL more memorable. So:

- If we ship **path A (single binary, browser)**: optionally do mDNS
  (`supergit.local:<port>`) as a polite default; don't pursue
  hosts-file or port-80 plumbing unless a real user asks.
- If we ship **path B (Electrobun)**: skip the named-localhost work
  entirely.

## node-pty under Bun — empirical check

The comment in `helper.mjs:5` claims node-pty doesn't run cleanly under
Bun (ENXIO when reading the PTY master fd through libuv streams). The
comment was written against Bun 1.2.x; the project now runs on Bun
1.3.13. Worth confirming before committing to the helper-subprocess
shape long-term — if it's fixed, we can delete `helper.mjs` and host
PTYs in-process, which simplifies packaging (no Node runtime needed).

Smoke test added: `packages/daemon/test/node-pty-direct.test.ts`.
Imports node-pty directly in the Bun test process, spawns `bash -c
"echo <marker>"`, asserts the marker arrives via `onData` within 2s.

**Result on Bun 1.3.13 (2026-05-21):** still broken. `onData` never
fires, buffer stays empty, test times out after 2s. The
helper-subprocess workaround remains load-bearing. Re-run this test
when bumping Bun — it's the canary for collapsing the architecture.

## Spike results (2026-05-23)

**`bun build --compile` works out of the box.** Zero source changes
needed for the compile itself. The daemon (63 modules) compiles to a
61MB Mach-O arm64 binary in <1s.

### What was done

Source changes (minimal, backwards-compatible with dev mode):
- `server.ts`: UI_DIR resolution now checks
  `dirname(process.execPath)/ui` before the existing
  `import.meta.dir`-based sibling check. In a compiled binary,
  `import.meta.dir` is `/$bunfs/root` (Bun's virtual FS) so the
  sibling check never hits; the exe-adjacent check finds the `ui/`
  directory we ship next to the binary.
- `node-pty-backend.ts`: `helperPath()` now checks
  `dirname(process.execPath)/helper.mjs` first. Same for
  `fixSpawnHelperBit()` which checks `node-pty-prebuilds/` next to
  the binary before the existing `node_modules/` paths.

Build script: `scripts/build-native.ts` (run via `bun run build:native`):
1. Builds the Svelte SPA.
2. Compiles the daemon to a single binary.
3. Copies `ui/`, `helper.mjs`, and `node-pty` (current platform's
   prebuilds only) into `build/supergit-native/`.
4. Runs a smoke test: launches the binary on a temp port, curls the
   API + UI, asserts both respond.

Output layout:
```
build/supergit-native/       (63MB total for darwin-arm64)
├── supergit                  61MB compiled binary
├── ui/                       ~1MB SPA dist
├── helper.mjs                node-pty sidecar (runs under Node)
├── node-pty-prebuilds/       exe-adjacent prebuilds
│   └── darwin-arm64/
│       ├── pty.node
│       └── spawn-helper
└── node_modules/node-pty/    for Node's module resolution in helper.mjs
    ├── package.json
    ├── lib/
    └── prebuilds/darwin-arm64/
```

### Gotcha found during spike

`SUPERGIT_UI_DIR` is set in the current shell by the prod daemon's env.
When the compiled binary inherits that env, it skips exe-adjacent
detection and serves from the prod path. The build script's smoke test
strips all `SUPERGIT_*` env vars to test the compiled path correctly.
Real users won't hit this since they won't have `SUPERGIT_UI_DIR` set
globally — it only matters for developers who also run prod locally.

### Bun embedded files — considered and rejected

Bun's `Bun.embeddedFiles` API could theoretically embed the SPA into
the binary itself (no adjacent `ui/` directory). However, directory
embedding has reported bugs (Oct 2025–Feb 2026, oven-sh/bun#23852),
and we need to ship adjacent files anyway (helper.mjs + node-pty),
so there's no win from embedding just the UI.

## Recommended sequencing

1. ✅ **DONE** — Bundling spike. `bun build --compile` works, smoke
   test passes, path resolution is backwards-compatible.
2. Keep the helper subprocess. The node-pty-direct smoke test confirms
   Bun 1.3.13 still can't host PTYs in-process.
3. Decide windowing model: browser-tab (path A) vs native window
   (path B / Electrobun). User leans toward B because it removes the
   URL-memorability problem entirely.
4. Path B specifically: prototype Electrobun with the existing daemon
   wired up; the daemon code shouldn't need substantive changes.
5. Signing / notarisation / installer / auto-update — last, per platform.

## Open questions
- Does Electrobun's process model let us keep the daemon as a
  long-lived thing the webview talks to via HTTP/WS (as today), or do
  we need to move to its typed IPC bridge? HTTP/WS keeps the dev
  workflow (Vite proxy) intact; IPC is "more native" but a bigger
  refactor.
- Auto-update story per platform — Electrobun has hooks, but the
  details matter for whether we can ship updates without users
  re-running an installer.
- How do we handle the "user already has supergit dev running" case
  inside a packaged app? Today's port-claiming dance assumes one
  daemon; a desktop app may want a stricter single-instance lock.
