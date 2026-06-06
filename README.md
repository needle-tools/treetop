# Needle Jungle

### You were built for this jungle.

Mission control for your AI coding agents — across every repo, branch, and worktree. Stay on top.

A multi-repo, multi-agent, worktree-first git dashboard. One pane of glass for every repo you're juggling, every worktree you've spun up, and every agent you've let loose — without losing your mind to terminal tab soup.

## Features

- **Multi-repo dashboard** — track all your repos side by side, with live status, branch and commit info.
- **Worktree-first** — create, browse, and switch between worktrees as first-class citizens, not an afterthought.
- **Agent-aware** — detect and manage AI coding agents running across your projects. Claude Code and Codex today, more on the way.
- **Embedded terminals** — host TUI sessions right in the dashboard; they survive across reloads.
- **Format-aware diffs** — readable diffs for text and known binary/3D formats, never a useless "binary file changed."
- **Remote sessions & sharing** — share a workspace, reconnect through self-healing tunnels, collaborate live.
- **Local-first, pluggable backends** — local disk always works; cloud backends are optional, never required.
- **Open in your editor** — editor-agnostic, shells out to whatever you already use. Deep git ops escape to Fork.

## Quick start

```sh
bun install        # once, at the root
bun dev            # daemon (:7777) + UI (:7779) with hot reload
```

Open http://localhost:7779.

For a production build serving the bundled SPA:

```sh
bun run start      # builds the UI, serves on :27787
```

## Development

- `bun test` — run all tests (daemon + UI). Fast inner loop, TDD encouraged.
- `bun run test:watch` — re-run on change.
- `bun run format` — Prettier across the workspace.

The daemon is **Bun + TypeScript**; the UI is **Svelte + Vite**. State lives in the workspace repo itself. See [`CLAUDE.md`](./CLAUDE.md) and [`plans/`](./plans) for the design docs and contribution rules.

---

Made with 🦍 by [needle.tools](https://needle.tools)
