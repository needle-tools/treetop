# PLAN-SESSION-SHARE.md — share sessions across machines on the same LAN

Living plan. Adjacent to [PLAN-TERMINAL.md](./PLAN-TERMINAL.md) (how
sessions are hosted) and [PLAN-SUMMARIZE.md](./PLAN-SUMMARIZE.md) (how
they're summarized). This plan is *only* about moving an existing
JSONL session from one machine's supergit to another's.

## What we're adding, in one line

A "Send to peer" / "Receive" action on a session row that ships its
JSONL transcript to another supergit daemon on the same LAN, with
the receiver rewriting absolute paths so the session opens against
the local clone of the same git repo.

## Why this is worth building

Multi-machine is the *normal* case for our users: a laptop for
travel, a desktop for the heavy GPU box, sometimes a teammate's
machine for pairing. Today a Claude/Codex session is pinned to the
machine that started it — to "continue on the other box" you have
to manually `scp` the JSONL, know where the agent expects to find
it, and hope the cwd/paths line up. Every step of that is friction
we can eliminate, because supergit already knows: where sessions
live, which repo they belong to, what the local clone path is on
each machine.

The shape of the feature is *one-shot send/receive*, not "live
sync." Live sync of an active session is a different (much harder)
problem; one-shot handoff covers ~90% of the actual workflow:
"close laptop, open desktop, keep going."

## Scope

In (v1):
- mDNS discovery on the local network: each supergit daemon
  advertises `_supergit._tcp.local` with its port + machine name.
- A "Send to…" menu on a session row → picks a peer, POSTs the
  JSONL + a small manifest to the peer's daemon.
- Receiver: looks up the repo by normalised git remote URL, rewrites
  absolute paths (repo root + worktree root) in the JSONL, stores
  the result as an *imported session* under the workspace.
- Path-separator normalisation so Windows ↔ macOS/Linux works.
- Manual `host:port` fallback when mDNS is unavailable (Windows
  without Bonjour, hostile networks).
- A "Received sessions" surface in the UI — same affordances as
  native sessions (view, search, summarise) but flagged as
  imported.

Out (v1, defer):
- Live sync of an in-progress session. Send is a snapshot at the
  moment of the click. v2 may add "send + keep tailing" but that
  needs a streaming protocol and conflict story.
- Internet / WAN delivery. Same-LAN only. WAN handoff would need a
  relay or NAT traversal; out of scope for v1.
- Auth / pairing. v1 trusts the LAN — anyone who can reach the
  daemon port can already drive supergit. This matches the
  current threat model and is consistent with how the dashboard's
  HTTP surface already works.
- Encryption in transit. Same reasoning — LAN-only, trusted
  network. If we ever expose this to WAN, TLS + a pairing token
  becomes mandatory; flagged in [Security](#security) below.
- "Resume on receiver" — i.e. relaunching the session in a live
  Claude/Codex PTY pointed at the imported JSONL. Viewable +
  searchable + summarisable is v1; resumable is v2 and depends on
  each agent's `--resume` story (Claude has it; Codex partially).
- Two-way "merge" of sessions edited on both sides. Send is
  directional; if both sides edit, last write wins, surfaced as a
  collision warning.

## Why the git remote is the right identity key

Same repo lives at different absolute paths on different machines:
`~/git/foo` on the laptop, `~/code/work/foo` on the desktop,
`C:\dev\foo` on Windows. The one stable identifier across all
three is the **git remote URL** (`origin` by default, normalised:
strip `.git`, fold `git@github.com:foo/bar` ↔
`https://github.com/foo/bar`).

So the sender ships `{ originRepoRemote, originRepoPath,
originWorktreePath?, sid, agent, jsonl }`. The receiver scans its
`repos.json`, finds the entry with a matching normalised remote,
takes that entry's local path, and rewrites
`originRepoPath` → `localRepoPath` throughout the JSONL. If there
is no match, the receiver refuses the import and responds
`needs_clone: <remote>`; the sender's UI surfaces "Clone
`<remote>` on the receiver first."

This also makes the feature work transparently for "send to
teammate" and "archive to NAS" — same protocol, same identity key,
no special-casing.

## Protocol

### Discovery

Each daemon advertises an mDNS service on start:

```
_supergit._tcp.local
  port: <daemon port>
  txt:
    machine=<hostname>
    version=<daemon semver>
    platform=darwin|linux|win32
```

The dashboard's "peers" panel subscribes to the same service type
and lists every responder except itself. No central registry, no
config file. When mDNS isn't available (e.g. Windows without
Bonjour, hardened networks), the panel exposes a "Add peer
manually" input that takes `host:port`.

### Send

`POST http://<peer>/api/sessions/import` with a JSON body:

```json
{
  "manifest": {
    "sid": "abc123",
    "agent": "claude" | "codex" | ...,
    "originMachine": "marcels-laptop",
    "originPlatform": "darwin",
    "originRepoRemote": "https://github.com/foo/bar",
    "originRepoPath": "/Users/marcel/git/bar",
    "originWorktreePath": "/Users/marcel/git/bar/.worktrees/feat-x",
    "createdAt": "2026-05-21T10:14:00Z",
    "sentAt":    "2026-05-21T14:02:00Z",
    "bytes": 184320
  },
  "jsonl": "<entire transcript>"
}
```

JSONL is sent inline as a string in v1. Sessions are typically
sub-megabyte; if/when we see multi-megabyte transcripts we switch
to streaming `application/x-ndjson`. Don't optimise prematurely.

### Receive

The receiver:

1. Looks up `originRepoRemote` in `repos.json` (normalised match).
   No match → `409 { error: "needs_clone", remote }`.
2. Computes the path-rewrite map:
   - `originRepoPath` → `localRepoPath`
   - `originWorktreePath` → `localWorktreePath` if present *and*
     that worktree exists locally; otherwise leave the worktree
     ref alone and mark the import `worktreeMissing: true` (the
     session is viewable but cannot be resumed against that
     worktree).
3. Normalises path separators if `originPlatform !== process.platform`:
   - Windows → POSIX: `C:\foo\bar` → `/c/foo/bar` (or the user's
     local repo root, since we're rewriting anyway).
   - POSIX → Windows: the inverse.
   Done as a single regex pass per longest-prefix match, so we
   don't accidentally rewrite paths inside string literals that
   happen to share a prefix.
4. Writes the rewritten JSONL to
   `<workspace>/imported-sessions/<originMachine>/<sid>.jsonl`
   along with a sidecar `<sid>.manifest.json`. Crucially, *not*
   into `~/.claude/projects/...` — those dirs are owned by the
   agent CLI, and dropping foreign files there would confuse it.
5. Appends an `event` to `events.jsonl`:
   `{ kind: "session_imported", sid, originMachine, repoId, at }`.
6. Responds `200 { sid, importedAs }`.

### Conflict handling

If the receiver already has a session with this `(originMachine,
sid)` pair, default behaviour is **replace** with a one-line event
log entry. The UI surfaces a quiet "updated from <machine> at
<time>" badge; no modal. Rationale: the dominant case is "I sent
the same session again to pick up the latest turns" — silent
replace is what the user wants. If we discover a real
divergence-loss case we add an explicit "keep both" toggle in v2.

## UI

### Session row

A new overflow-menu item: **Send to peer →** (submenu lists
discovered peers + "Other host…"). Clicking sends in the
background; toast on success with the receiver's machine name and
"Open on <machine>" link (which deep-links to the receiver's UI if
both are reachable from the user's browser).

### Peers panel

Small section in the dashboard sidebar / settings:
- List of discovered peers (machine name, platform icon, last-seen
  ago).
- "Add manual peer" with `host:port` input + a one-shot ping to
  validate.
- Toggle: "Discoverable on this network" (default on; off disables
  the mDNS advert and rejects incoming `/api/sessions/import`).

### Received sessions

Imported sessions show in the normal session list **scoped to the
matched repo**, badged with the origin machine name and the
original creation time. A filter chip "Imported only" makes it
easy to find what came from elsewhere.

## Security

v1 trusts the LAN (matches the existing daemon HTTP surface). The
incremental risks to flag now, even though they're not v1 work:

- **An unfriendly LAN peer could push garbage JSONL** and pollute
  someone's session list. Mitigations available without auth:
  hard cap on payload size (e.g. 50 MB), basic JSONL shape check
  (every line parses, has expected fields), reject if
  `originRepoRemote` isn't in the receiver's `repos.json`.
- **Path-rewrite injection.** The rewrite must operate on
  *normalised, absolute* prefixes only — never substring-replace
  arbitrary user-supplied strings into the JSONL. The manifest's
  `originRepoPath` is validated as an absolute path before it's
  used as a rewrite key.
- **Discoverability leak.** mDNS shouts your hostname on the LAN.
  The discoverable toggle is the user-facing escape hatch.

If we ever expose this beyond the LAN, gate it behind: pairing
(out-of-band code), TLS, and per-peer tokens stored in the
workspace.

## Cross-platform notes

- Daemon is Bun, runs identically on macOS / Linux / Windows.
- mDNS: built into macOS, available on Linux via Avahi (preinstalled
  on every mainstream distro), available on Windows via the Bonjour
  service (often present but not guaranteed). We use a pure-JS mDNS
  responder (e.g. `bonjour-service` or rolled in-house) so we don't
  depend on the system daemon being installed — but the system
  daemon, when present, makes discovery instant and reliable.
- Firewalls: first incoming connection prompts on macOS, gets
  silently blocked on Windows Defender until allowed. Document
  this; don't try to be clever.
- Path normalisation: see Receive step 3. Tested in both
  directions.

## Test plan

Per [CLAUDE.md](../CLAUDE.md): test-first, no skipped tests, no
mocking what we can run for real.

Unit:
- `normalizeRemote(url)` — handles ssh/https/`.git` suffix.
- `rewritePaths(jsonl, { from, to, fromPlatform, toPlatform })` —
  golden files for each platform pair.
- `validateManifest(m)` — rejects missing fields, non-absolute
  paths, oversized payloads.

Integration (spawn two real daemons on two random ports in a temp
workspace each):
- Discovery: both advertise, both see each other.
- Send happy path: daemon A sends a real JSONL to daemon B,
  daemon B writes it under `imported-sessions/`, event log
  records the import, UI list reflects it.
- Send to missing repo: B has no matching remote → A gets
  `needs_clone`, nothing is written on B.
- Replace: send the same sid twice with extra lines → B's stored
  copy is the newer one, event log has two `session_imported`
  entries.
- Round-trip cross-platform: simulate Windows-origin manifest
  delivered to a POSIX receiver — verify every path in the output
  JSONL is POSIX and points at the local repo root.

We don't need a literal second OS in CI for the cross-platform
test; the rewriter is pure, and we drive it with manifests that
*claim* `originPlatform=win32` against a posix receiver and vice
versa. Real-OS validation is a manual checklist item before each
release that touches this code.

## Rollout

1. Land the rewriter + manifest validator + tests (no network, no
   UI). Pure functions; easiest to land first.
2. Add `POST /api/sessions/import` + `imported-sessions/` storage
   + event log entry. Integration test with two in-process
   daemons.
3. Add mDNS advert + discovery + peers panel. Manual `host:port`
   fallback first; mDNS layered on top.
4. Add the session-row "Send to peer" action.
5. Manual cross-machine test on real hardware (mac↔mac, mac↔linux,
   mac↔windows). Document any firewall steps in
   [TODO-windows.md](./TODO-windows.md).

Each step is independently shippable — even step 1 alone unlocks
"manually `curl` a JSONL between machines," which is already
better than the status quo.

## Open questions

- Does "Send to peer" need a confirmation step on the receiver
  ("accept session from `<machine>`?"), or is silent accept fine
  for v1? Leaning silent-accept on trusted LAN; revisit if we
  ever ship pairing.
- Resume-on-receiver (v2): does Claude's `--resume <sid>` accept a
  JSONL at an arbitrary path, or only ones under
  `~/.claude/projects/...`? If the latter, we'd need to either
  symlink imported sessions into the agent's expected dir (gross
  but works) or upstream a flag. Worth a quick experiment before
  v2 starts.
- Worktree handling when the receiver has the repo but not the
  worktree: do we offer "create the worktree from
  `<originBranch>`" as a one-click action? Probably yes in v2.
