<img src="./icon.svg" alt="Treetop layered paper canopy logo" width="96" height="96" />

# Treetop

[![tests](https://github.com/needle-tools/treetop/actions/workflows/test.yml/badge.svg)](https://github.com/needle-tools/treetop/actions/workflows/test.yml) [![release](https://github.com/needle-tools/treetop/actions/workflows/release.yml/badge.svg)](https://github.com/needle-tools/treetop/actions/workflows/release.yml)

### You were built for this jungle.

Mission control for your AI coding agents — across every repo, branch, and worktree. Stay on top.

Treetop brings agent conversations, terminals, and Git changes into one workspace. Follow parallel sessions, review what changed, and pick up work across local and remote machines.

## Download

**[Download Treetop from GitHub Releases](https://github.com/needle-tools/treetop/releases).** Download the installer for your platform and run it.

## Features

- **MCP support** — connect AI agents to control Treetop through the Model Context Protocol.
- **Agent sessions** — work with Claude Code and Codex, follow conversations and tool activity, and track which sessions need your attention.
- **Multi-repo workspaces** — keep repositories, branches, and worktrees together with live Git status.
- **Session dock** — arrange sessions side by side and move between active and background work.
- **Persistent terminals** — run shells and terminal agents with broker-backed sessions that survive UI reloads and daemon reconnects.
- **Code review** — inspect changed files, text diffs, and Git history alongside the agent doing the work.
- **Search and context** — find sessions and files, browse session context, and navigate tool output.
- **Remote work** — connect remote daemons and folders, and share sessions through links.
- **Native desktop app** — Windows and macOS packaging with tray/menu-bar access, plus a browser-based UI.
- **Local-first workflow** — keep workspace state on disk and open projects in your preferred editor.

## Development

To run Treetop from source:

```sh
bun install        # once, at the root
bun dev            # daemon (:7777) + UI (:7779) with hot reload
```

Open http://localhost:7779.

For a production build serving the bundled SPA:

```sh
bun run start      # builds the UI, serves on :27787
```

- `bun test` — run all tests (daemon + UI). Fast inner loop, TDD encouraged.
- `bun run test:watch` — re-run on change.
- `bun run format` — Prettier across the workspace.

The daemon is **Bun + TypeScript**; the UI is **Svelte + Vite**. State lives in the workspace repo itself. See [`CLAUDE.md`](./CLAUDE.md) and [`plans/`](./plans) for the design docs and contribution rules.

---

Made by [Needle](https://needle.tools).

Copyright © 2026 Needle.
