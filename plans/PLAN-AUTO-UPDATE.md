# PLAN-AUTO-UPDATE.md — self-updating native app

Status: planned, not started.

## What Electrobun gives us for free

Electrobun's `Updater` API handles the core update lifecycle:
- `checkForUpdate()` — fetches `update.json` from a configured URL
- Downloads differential patches via `bsdiff` (only the diff between
  versions, not the full binary — updates are tiny)
- Falls back to full tarball download if no patch exists
- Extracts, replaces the running app, relaunches

The build pipeline already produces the artifacts:
- `artifacts/stable-macos-arm64-Supergit.app.tar.zst` — full bundle
- `artifacts/stable-macos-arm64-update.json` — version manifest
- `artifacts/stable-macos-arm64-Supergit.dmg` — installer

## What we need to wire up

### 1. Host artifacts somewhere
GitHub Releases is simplest — free, fits the workflow. On every
tagged release, CI uploads the artifacts. The `baseUrl` in
`electrobun.config.ts` points at the release URL:

```ts
baseUrl: "https://github.com/needle-tools/supergit/releases/latest/download/",
```

### 2. Check for updates in the entry script

```ts
import { Updater } from "electrobun/bun";

const updater = new Updater();
const status = await updater.checkForUpdate();
if (status.available) {
  // show UI prompt or auto-apply
  await updater.downloadAndApply();
}
```

Options:
- **On-launch check** — silent, applies on next restart
- **"Check for updates" menu item** — user-triggered
- **Periodic background check** — poll every N hours

### 3. Rollback (not built into Electrobun)

Electrobun's updater does `rmSync(oldApp)` + `renameSync(newApp)` —
no backup kept. We need to layer rollback on top:

- Before applying, move current app to a backup location
  (`~/.config/supergit/Supergit-previous/`)
- Track update state in `~/.config/supergit/update-state.json`:
  `{ previousVersion, updatedAt, launchCount }`
- On next launch, if the app crashes within 10s (launchCount stays 0),
  auto-rollback by swapping the backup back
- After 3 successful launches, delete the backup
- Add a manual "Revert to previous version" option in the app menu

### 4. CI pipeline

```yaml
# .github/workflows/release.yml
on:
  push:
    tags: ["v*"]

jobs:
  build:
    runs-on: macos-latest
    steps:
      - uses: actions/checkout@v4
      - uses: oven-sh/setup-bun@v2
      - uses: actions/setup-go@v5
      - run: bun install
      - run: bun run build
      - uses: softprops/action-gh-release@v2
        with:
          files: artifacts/*
```

Windows and Linux builds would be additional matrix entries once
Electrobun supports those platforms in prod builds.

## Sequencing

1. Add `baseUrl` to config (pointing at GitHub Releases)
2. Wire up on-launch update check in entry script
3. Set up CI release workflow
4. Add rollback layer
5. Add "Check for updates" UI (menu item or in-app)

## Open questions

- Should updates auto-apply or require user confirmation?
- How to handle daemon restarts during update? (active TUI sessions
  would be killed)
- Should we support downgrade (rollback to a specific older version,
  not just the previous one)?
- Beta/canary channel support? Electrobun has `--env=` for channels
  (dev, stable, etc.)
