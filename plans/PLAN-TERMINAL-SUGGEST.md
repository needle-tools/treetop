# PLAN-TERMINAL-SUGGEST.md — terminal IntelliSense

**Status: proposed** (not started).

Inline completion suggestions inside supergit's regular shell TUI
(`agent=shell` columns — *not* the Claude/Codex TUIs, which own their own
input UIs). First target: typing `npm run ` shows a popover of scripts
from the worktree's `package.json`.

This is a **custom addon for xterm.js**, not a dependency. There is no
drop-in plugin in the ecosystem as of mid-2026 — see "Why not a
dependency" below.

## Mental model

xterm.js is just a byte-stream renderer. The shell (zsh/bash) owns the
line editor, history, and tab-completion. To layer our own suggestions
on top *without* fighting the shell, we need to know two things at any
moment:

1. **What's on the current command line** (text + cursor position).
2. **Where to anchor the popup** in the DOM.

Both come for free from VS Code-style **shell integration**: the user's
shell emits OSC escape sequences at well-known points (prompt start,
command start, command finished, cwd update). We parse those, maintain
a "current prompt input" model, and render a Svelte popover into an
`IDecoration` element anchored at the cursor. The shell still owns
history and tab-completion; our popup is an additive overlay that
writes accepted suggestions back into the PTY.

The pieces, top-down:

```
┌──────────────────────────────────────────────────────────────┐
│ TerminalView.svelte                                          │
│   ┌────────────────────────────────────────────────────────┐ │
│   │ xterm.js Terminal                                      │ │
│   │   parser.registerOscHandler(633, …)  ← prompt model    │ │
│   │   registerDecoration({ marker, x }) ← popup anchor     │ │
│   └────────────────────────────────────────────────────────┘ │
│       │                                          ▲           │
│       ▼                                          │           │
│   SuggestAddon (our code)                        │           │
│       │  current input + cursor + cwd            │           │
│       ▼                                          │           │
│   SuggestProvider[]  ←─── npm-run, just, cargo,  │           │
│       │                   git-branch, …          │           │
│       ▼                                          │           │
│   SuggestPopover.svelte (mounted into            │           │
│       IDecoration.element)                       │           │
│       │  on Enter / Tab → terminal.paste(text)   │           │
│       └──────────────────────────────────────────┘           │
└──────────────────────────────────────────────────────────────┘
```

## Why not a dependency

Research summary (researched 2026-05-14):

| Option | Status | Embeddable? |
|---|---|---|
| `@xterm/addon-suggest` / similar | **does not exist** | — |
| VS Code's `SuggestAddon` | open-source, in-tree | **no** — tied to VS Code's DI/workbench |
| `inshellisense` (Microsoft) | maintained, useful internals | **no** — ships as a CLI shell-wrapper, no library API |
| Other npm packages | none production-ready | — |

The reusable jewel inside the ecosystem is [`withfig/autocomplete`](https://github.com/withfig/autocomplete)
(MIT, 600+ tool specs). We can vendor those if we want broad coverage
later — they're plain TypeScript modules describing CLI argument shapes.

What we **can** lift from xterm.js itself is the decoration API:

```ts
const marker = terminal.registerMarker();
const deco = terminal.registerDecoration({
  marker, x: cursorX, width, height,
});
mount(SuggestPopover, { target: deco.element, props: { items, … } });
```

…plus the OSC parser hook:

```ts
terminal.parser.registerOscHandler(633, (data) => { … return true; });
```

That's the entire xterm-side surface. Everything else is our own code.

## Scope — v0 (npm-run only)

Ship the smallest thing that's actually useful day-one:

- One provider: `NpmRunProvider`.
- Triggered when the input line matches `^npm\s+run\s+(\S*)$`
  (also `pnpm run`, `yarn run`, `bun run`).
- Reads `<cwd>/package.json`, returns `Object.keys(pkg.scripts)`
  filtered by the user's partial input.
- Popup shows: script name (left), the script body (right, muted).
- Enter / Tab accepts → writes the remaining characters + `\n` (or
  no `\n` — see "Open question: do we auto-run?").
- Esc / arrow-up-out / clicking elsewhere dismisses.
- Mouse: click an item to accept.

Out of scope for v0: every other provider; fuzzy match (prefix only);
ghost-text inline completion (popup only); persistence of "last picked"
across sessions; remote (non-local) suggestions.

## v1 — more providers

Add as separate providers behind the same interface:

- `JustProvider` — parses `justfile` → target names.
- `MakefileProvider` — parses `Makefile` for `^[A-Za-z][^:]*:`.
- `CargoBinProvider` — runs `cargo metadata --no-deps --format-version 1`
  once per cwd, caches, suggests after `cargo run --bin `.
- `GitBranchProvider` — local branches after `git checkout `,
  `git switch `, `git rebase `, `git merge `.
- `PathProvider` — generic file-path completion after a space, when
  no higher-priority provider matched. (Bottom of the stack — the
  shell already does this, ours is a fallback for users without
  good zsh completion.)

Each provider is `(line: string, cursor: number, cwd: string) =>
Promise<Suggestion[]>`. Pure functions, easy to test.

## v2 — Fig spec ingestion

Vendor [`withfig/autocomplete`](https://github.com/withfig/autocomplete)
specs (MIT). A `FigSpecProvider` matches the first token against the
spec database and renders argument-aware suggestions for ~600 CLIs:
`git`, `kubectl`, `gh`, `aws`, `docker`, `pnpm`, etc.

The Fig spec format is well-documented and stable. Cost: vendoring
adds ~10 MB of TS to the build; tree-shake by only loading specs
on-demand (one dynamic import per CLI binary name as it appears).

## Hard parts

1. **Shell integration must be on.** OSC 633 sequences only appear if
   the user's shell sources VS Code's shell-integration scripts (or
   our equivalent). We have two choices:
   a. Auto-inject a shell-integration snippet into the PTY's
      environment (`ZDOTDIR` trick: spawn zsh with a temp `ZDOTDIR`
      whose `.zshrc` sources the user's real `.zshrc` *then* our
      integration script). This is what VS Code does.
   b. Tell the user to install a snippet manually. Lower friction
      for us, higher friction for the user → drop-off.
   We do (a). The injector lives in `packages/daemon/src/terminals/`
   alongside `helper.mjs`, mirrored per-shell (zsh, bash, fish).

2. **Prompt input parsing without shell integration.** Some users
   will have shells we don't support. The popup should degrade
   gracefully — no OSC events → addon stays dormant, no popup, no
   spurious overlays. (Don't try to heuristic-detect the prompt
   from the buffer; that's where VS Code's terminal-suggest went
   off the rails for years.)

3. **Resize / reflow.** When the terminal resizes, decorations
   re-anchor themselves on the marker row. Test: type `npm run `,
   open suggest popup, resize window — popup must follow the
   cursor row. xterm.js handles marker re-anchoring; we just need
   to not cache absolute x/y in our Svelte state.

4. **Don't fight the shell's own completion.** Tab is the shell's.
   If the suggest popup is open, Tab accepts our suggestion. If the
   popup is closed, Tab passes through to the shell. (Same UX as
   VS Code.)

5. **Latency.** Reading `package.json` on every keystroke is fine
   (it's small, the OS caches it). Stat-based invalidation: cache
   parsed scripts keyed by `(path, mtimeMs)` like we do for
   `scanClaudeUserMessages`. New `pkgJsonCache` in `packages/ui/src/`
   or `packages/daemon/src/` — TBD which side does the read; see
   "Open question: client-side or server-side providers?".

## Tests

Per the TDD rule:

- `NpmRunProvider.test.ts` — given line + cwd-with-package.json,
  returns expected suggestions. Edge cases: no `scripts`, no
  package.json, partial input filtering, scripts with `-` and `:`,
  yarn/pnpm/bun aliases.
- `PromptInputModel.test.ts` — given a stream of OSC 633 events,
  exposes the right `(command, cursor)` after each step.
- Snapshot test for the trigger detector: which input strings
  trigger which provider.
- No xterm.js mount in tests; the addon module is decoupled from
  the `Terminal` instance via an interface so it can be exercised
  headless.

## File layout (proposed)

```
packages/ui/src/terminal/
├── SuggestAddon.ts            # the xterm.js ITerminalAddon
├── PromptInputModel.ts        # OSC 633 → current command line + cursor
├── SuggestPopover.svelte      # the popup, mounted into IDecoration
├── providers/
│   ├── types.ts               # SuggestProvider interface
│   ├── npmRun.ts              # v0
│   ├── just.ts                # v1
│   ├── cargoBin.ts            # v1
│   └── gitBranch.ts           # v1
└── shell-integration/
    ├── zsh-integration.zsh
    ├── bash-integration.bash
    └── fish-integration.fish
```

`TerminalView.svelte` wires it up: `terminal.loadAddon(new SuggestAddon({ providers: [...] }))`.

The shell-integration scripts get copied into the workspace at
daemon start (so they're path-stable for the `ZDOTDIR` trick), and
the `helper.mjs` env-prep step sets `ZDOTDIR` (zsh) /
`BASH_ENV` (bash) / fish equivalent before spawning. Add this
*after* the existing env scrub for `PORT` / `PORTLESS_URL` /
`NODE_EXTRA_CA_CERTS` — same file, same step.

## Open questions

- **Client-side or server-side providers?** v0 with `npm run` is
  small enough to do client-side (read package.json via a new
  `/api/file?path=…` endpoint, or via the FS-changes SSE stream).
  But "list branches" is naturally a daemon job. Lean: providers
  are async, return suggestions, *they* decide whether to fetch
  client-side or hit a daemon endpoint. Don't bake the location
  into the interface.
- **Do we auto-run on Enter?** VS Code does *not* — Enter just
  accepts the completion text, you press Enter again to run. We
  should match. (`Tab` is the same — accept, no run.)
- **Where does the popover render z-index-wise?** Inside the
  `IDecoration.element` it's parented to the terminal viewport.
  If we want it to escape the column bounds we'd have to portal
  it to `document.body` and track the column's bounding rect.
  v0: stay inside the viewport. Revisit if "popup gets clipped"
  becomes a real complaint.

## Out of scope (now and probably forever)

- Inline ghost-text completion in the buffer itself. That requires
  injecting characters into the shell's line editor *and* removing
  them on cancel — fragile, prone to drift. Popup-only is the
  contract.
- Completing inside Claude / Codex TUIs. Their input box is owned
  by the TUI process, not the shell — they have their own
  history/completion. We don't touch it.
- Network-based completions (LLM-backed "predict the next
  command"). Not what this plan is about.

## Effort estimate

- v0 (npm-run, zsh-only shell integration): **1–2 days.**
- v1 (just + cargo + git-branch + bash/fish): **+2 days.**
- v2 (Fig specs): **+1–2 days** once the Provider interface is solid.

The dominant cost in v0 is shell integration. Once that's wired
and the `PromptInputModel` is exposing `(line, cursor)` reliably,
adding providers is mechanical.
