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
idle  →  downloading ↓  →  editing ✎  →  uploading ↑  →  synced ✓
                                ↑                           │
                                └───────────────────────────┘
                                   (user edits again)
```

- **Cache location**: `<workspace>/.remote-cache/<host>/full/remote/path/file.ext`
  preserves the directory structure so the cache is navigable.
- **Watch**: `fs.watch()` on the cached copy — Bun supports this natively.
  Watch stays active as long as the file browser shows the remote directory
  (or until an idle timeout).
- **Conflict**: if the remote file changed since download, warn before
  overwriting. Compare mtime or content hash on upload.
- **Cleanup**: stale cache files can be pruned on daemon start or manually.

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

## What we don't build

- **An SSH server.** supergit is always the client.
- **Full bidirectional sync / Dropbox.** We sync individual files on
  demand (open → edit → save back), not entire directory trees.
- **Remote git operations.** No `git status`, no diffs, no commits on the
  remote. The file browser is a pure filesystem view. Use a remote
  terminal (pillar 2) if you need git on the remote.
- **A full RDP/VNC implementation.** Lean on FreeRDP, libvnc, or noVNC —
  we're the glue, not the protocol library.

## Open questions

- Should remote hosts be per-workspace or global (user-level)?
- Latency targets for screen sharing — is "usable" enough or do we need
  GPU-accelerated encoding on the daemon side?
- Can we detect whether the remote has RDP vs VNC available automatically,
  or does the user configure it?
- Clipboard and file transfer: tunnel through the existing SSH connection
  or separate channel?
