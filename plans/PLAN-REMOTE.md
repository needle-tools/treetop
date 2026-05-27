# supergit — plan (remote access)

Remote access to servers the user SSHs into — file browsing, terminal, and
eventually screen sharing. Everything rides on a single SSH connection per
host; no extra software required on the remote beyond OpenSSH.

## Pillars (in shipping order)

### 1. Remote filesystem browsing + edit-and-sync

**Ship first.** The lowest-hanging fruit: SFTP is built into every SSH
connection, works on Windows (OpenSSH) and Linux out of the box, and mirrors
local `fs` APIs almost 1:1.

The file browser UI doesn't need to change — it calls `/api/files?path=...`
and the daemon resolves local vs. remote:

```
/local/repos/...             → Bun fs APIs (existing)
ssh://server/home/user/...   → SFTP over SSH connection
```

#### Browsing

- `ssh2` npm package provides a full SFTP client (`readdir`, `stat`,
  `readFile`, `createReadStream`).
- Daemon holds a pool of SSH connections, reuses them across requests.
- No git operations on the remote — no status overlay, no diffs. This is
  a pure filesystem view, which keeps it simple and fast.

#### Edit-and-sync workflow

The killer feature: open a remote file in your local editor, save locally,
and supergit syncs it back to the remote automatically.

```
click file in browser
  → daemon: sftp.fastGet() → <workspace>/.remote-cache/<host>/<path>
  → daemon: openDefault(localCopy)
  → user edits in local editor, saves
  → daemon: fs.watch() detects change
  → daemon: sftp.fastPut() → remote
  → UI updates file state
```

Per-file state machine shown in the file browser:

```
idle  →  downloading ↓  →  editing ✎  →  modified ⚡  →  uploading ↑  →  editing ✎
                                              │
                                        user confirms
                                        via popover
```

**Upload confirmation (like FileZilla)**: when `fs.watch()` detects a save,
DON'T auto-upload. Instead, show an inline popover on the file row in the
browser: "File modified — upload to remote?" with three actions:
- **Upload** — confirm overwrite, start upload
- **Open** — re-open the local copy to review
- **Dismiss** — discard the change notification

This prevents accidental overwrites on production servers. Auto-sync is
convenient but dangerous.

- **Cache location**: `<workspace>/.remote-cache/<host>/full/remote/path/file.ext`
  preserves the directory structure so the cache is navigable.
- **Watch**: `fs.watch()` on the cached copy — Bun supports this natively.
  Watch stays active as long as the file browser shows the remote directory
  (or until an idle timeout).
- **Conflict**: if the remote file changed since download, warn before
  overwriting. Compare mtime or content hash on upload.
- **Cleanup**: stale cache files can be pruned on daemon start or manually.
- **mtime refresh**: after a successful upload, the file browser auto-refreshes
  the current directory listing so the modified time updates.
- **Live sync badges**: the file browser polls `/api/ssh/status` to show
  real-time sync state (✎ editing, ⚡ modified, ↑ uploading) on file rows.

#### CWD follow

Terminal cwd tracking works by parsing the prompt output:
- Windows cmd.exe: `C:\Users\needle\Music>`
- PowerShell: `PS C:\path>`
- Unix bash/zsh: `user@host:/path$`

TerminalView extracts the cwd and fires it up through the component chain
to the FileBrowser's `remoteCwd` prop. When Follow is active, the file
browser navigates to match. Follow auto-disables on manual navigation.

The Follow and Terminal buttons live on the RIGHT side of the breadcrumb bar.

### 2. Remote terminal

Natural next step: open a shell on the remote inside supergit's existing
terminal UI. The PTY helper already manages local terminals; remote terminals
are an SSH exec channel instead of a local `Bun.spawn`, but the WebSocket
framing to the browser is identical.

**Auto-reconnect**: if the SSH session drops (network blip, server restart,
idle timeout), the terminal keeps its tab open and retries the connection
with exponential backoff for up to 10 minutes. The UI shows a
"reconnecting..." banner in the terminal area. If reconnection succeeds,
a fresh shell is spawned (scroll history from before the drop is preserved
in the terminal buffer). If all retries are exhausted, the banner changes
to "disconnected" with a manual retry button.

### 3. Remote screen (RDP / VNC)

Full remote desktop rendered in the browser. The daemon normalizes all
remote display protocols into a single framebuffer stream so the browser
only needs one viewer component:

```
Browser:  <canvas> + single viewer protocol (drawing ops over WebSocket)

Daemon:   SSH tunnel → RDP (port 3389) → framebuffer stream   (Windows)
          SSH tunnel → VNC (port 5900) → framebuffer stream   (Linux)
```

This means:
- Windows remotes use native RDP — already running, zero setup.
- Linux remotes use VNC — one `apt install` or often already present.
- The browser renders both identically via `<canvas>`.
- Adding more backends later (Wayland, Sunshine/Moonlight for game
  streaming) is just another daemon-side adapter.

Protocol options for the daemon → browser leg:
- **noVNC-style**: daemon re-encodes RDP as VNC/RFB, browser uses noVNC.
  Simplest — one mature JS viewer handles everything.
- **Guacamole's drawing protocol**: lightweight instruction set (rect, img,
  cursor), `guacamole-common-js` renders it. We'd write the server-side
  translator in TS/Bun instead of their Java stack.
- **Raw framebuffer over WebSocket**: custom, but most control over
  compression / latency tradeoffs.

Leaning toward the noVNC-style approach — battle-tested, widely deployed,
and FreeRDP can output VNC-compatible framebuffers.

## SSH connection management

All three pillars share the same SSH connection per host:

```
daemon
  └─ SSHConnectionPool
       └─ connection("myserver")
            ├─ SFTP channel   (filesystem)
            ├─ exec channel   (terminal)
            └─ tunnel channel  (RDP/VNC port forward)
```

Auth: SSH keys (agent forwarding), password, or keyboard-interactive.
The daemon stores host configs in the workspace (`ssh-hosts.json` or
similar) — connection details, preferred protocol, display resolution.

## Orphan terminal cleanup

When no frontend (SSE + WebSocket) has been connected for **5 minutes**,
the daemon kills ALL spawned terminal processes — shells, agents, SSH
sessions, everything. No exceptions for starred or pinned sessions.

- **SIGTERM** first, give the process a chance to clean up.
- **SIGKILL** after **10 seconds** if still alive.
- **Log every action**: which terminals, their PIDs, how long they were
  orphaned, exit codes. This is critical for post-mortem debugging when
  something unexpected happened.

This prevents zombie SSH sessions and orphaned agent processes from
accumulating when the user closes the browser and forgets about them.

## What we don't build

- **An SSH server.** supergit is always the client.
- **Full bidirectional sync / Dropbox.** We sync individual files on
  demand (open → edit → save back), not entire directory trees.
- **Remote git operations.** No `git status`, no diffs, no commits on the
  remote. The file browser is a pure filesystem view. Use a remote
  terminal (pillar 2) if you need git on the remote.
- **A full RDP/VNC implementation.** Lean on FreeRDP, libvnc, or noVNC —
  we're the glue, not the protocol library.

## Terminal session persistence across restarts

When supergit restarts, Claude/Codex TUIs auto-resume via `--resume`,
but SSH terminals (and any other shell-based command) are lost. The PTY
dies and there's no reconnect mechanism.

**Solution:** persist active terminal commands to `<workspace>/active-terminals.json`.
On restart, show them as disconnected ghost columns with a **Reconnect** button —
don't auto-run. The user clicks to re-launch whichever ones they want.

Persisted per terminal: `{ cmd, cwd, wtPath, title, linkId? }`.
Written on spawn, removed on exit. The file is the "restore previous session"
manifest.

Restore UX: **open and prefill, don't run.**
- On restart, open a shell terminal column for each persisted session
- Prefill the command into the shell (e.g. `ssh needle@100.71.105.118`
  appears at the prompt, cursor at end) but DON'T press Enter
- User hits Enter to reconnect, or edits the command, or closes the column
- One keystroke to restore, zero surprise connections

## Known bugs (as of 2026-05-27)

### HIGH PRIORITY

- **Orphan process cleanup.** When no frontend is connected for 5 minutes,
  the daemon must SIGTERM all spawned terminals, then SIGKILL after 10s.
  No exceptions for starred/pinned. Must log every cleanup action.
  Without this, SSH sessions and agent processes accumulate indefinitely.

### Must fix

- **Save-back confirmation not surfacing.** The SyncTracker correctly
  transitions to "modified" state on local file save, but the file
  browser doesn't poll `/api/ssh/status` to discover the state change.
  The confirmation popover UI (Upload / Open / Dismiss) hasn't been
  built yet. The daemon-side confirm/dismiss routes exist and are tested.

- **Follow CWD not working.** The prompt-parsing code in TerminalView
  extracts cwd from Windows cmd.exe / PowerShell / Unix prompts, but
  either: (a) HMR doesn't pick up the new code (needs hard reload),
  (b) the prompt regex doesn't match the actual terminal output
  (Windows prompts may have ANSI codes or carriage returns that break
  the match), or (c) the reactive chain
  (TerminalView → NewSessionCol → App.svelte → FileBrowser) has a gap.
  Needs debugging with console.debug at each stage.

### Polish

- **mtime not updating after upload.** File browser caches the directory
  listing and doesn't re-fetch after a sync-back upload completes.
- **No live sync badges.** File browser doesn't poll `/api/ssh/status`
  to show ✎/⚡/↑ state on file rows in real time.
- **Only poll active-sends for visible sessions.** (Medium priority —
  see plans/performance.md.) Every open Claude session polls regardless
  of whether the column is scrolled into view.

## Open questions

- Should remote hosts be per-workspace or global (user-level)?
- Latency targets for screen sharing — is "usable" enough or do we need
  GPU-accelerated encoding on the daemon side?
- Can we detect whether the remote has RDP vs VNC available automatically,
  or does the user configure it?
- Clipboard and file transfer: tunnel through the existing SSH connection
  or separate channel?
