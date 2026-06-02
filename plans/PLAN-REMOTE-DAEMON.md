# PLAN-REMOTE-DAEMON.md — add a remote daemon as a folder row in the local UI

Status: **Phase 0 + Phase 1 DONE. Phase 4b daemon-side COMPLETE
(unit-tested only): registry + TunnelManager + HTTP proxy + WS bridge +
SSE pass-through all done. UI Phase A (the `apiUrl()`/`apiWsUrl()` seam
sweep) DONE + committed (ff1eb43). UI Phase B (thread `daemonId` into
repo-scoped calls) DONE (8401c76 = repo-list fan-out, fb483d4 = daemonId
threading + routing-guard test). UI Phase C DONE — add-remote-daemon
dialog/affordance (7625294), remove-daemon button + online/offline dot
(b534310), per-daemon prefs namespacing (5fe5c6c). The whole feature is
now reachable end-to-end in the UI. The whole flow has been proven LIVE
against a real Hetzner box (terminals, repo edits, reorder, stars,
agents/shells, notes). Live-USE fixes #1–#13 + the state-parity items
#2/#5/#7/#8/#9/#10/#11/#14/#15a/#17 are DONE; the routing-guard blind
spot that let the half-and-half bugs through is FIXED + hardened (commit
8c669fd), and #3 "add a folder on a remote daemon" shipped (MVP, existing
path). The opt-in two-daemon e2e harness now EXISTS (`bun run
test:two-daemon`) — boots two real daemons and proves connect → proxy →
health/repos-NDJSON/terminal-WS-round-trip with no stubs, closing the
runtime-coverage gap for the in-process (faked-ssh) case. Remaining: the
Tier-3 real-ssh / Linux-container variant for CI, plus the deferred items
#15b/#16/#18, mac/windows remote installers, Phase 2b auto-onboarding, and
distribution.**

## The actual goal (clarified 2026-05-30)

In the **local** supergit window, **add a folder row that points at a
remote daemon** (Hetzner box, a Docker container, whatever). That one row
then behaves exactly like a local repo row — worktrees, terminals, diff,
agents — except everything executes on the remote box. Local rows and the
remote row coexist in the same window.

This is the "side-by-side" model. It is NOT just "open a browser tab into
the remote box" (that's the free fallback, see Phase 4a) — it's the local
UI multiplexing across more than one daemon.

### Recommended architecture: local daemon as reverse proxy

Do **not** have the browser talk to remote daemons directly — that drags
in cross-origin CORS, HTTPS, and cert-trust, and would force the remote
daemon back onto a public interface. Instead:

```
Browser ──same-origin──> LOCAL daemon ──tunnel──> REMOTE daemon (loopback)
   /api/repos                (local repos, as today)
   /api/daemons/<id>/repos ──forwarded──> remote /api/repos
```

- Browser only ever talks to the **local** daemon → same-origin, no CORS.
- Local daemon forwards `/api/daemons/<id>/*` (incl. WS + SSE) over the
  SSH/WireGuard tunnel to the remote daemon's **loopback**. The remote
  stays `SUPERGIT_BIND=127.0.0.1`; from its view the proxied request is a
  trusted loopback call, so the security model built in Phase 0 holds.
- The tunnel/connection + key handling live in the local daemon (Bun,
  server-side), not the browser.

The irreducible UI cost is **routing**: each row must carry a `daemonId`
so its requests hit the right base via a central `apiUrl(path, daemonId)`
helper. Rendering is already daemon-agnostic (`ProcessList` loops an
arbitrary `repos` array); the work is the helper + threading `daemonId`
through the ~177 call sites + the proxy routes on the local daemon.

## What this is (and what it is NOT)

The supergit **daemon itself** runs on a remote box (e.g. a Hetzner VPS
or a Docker container); the local daemon proxies to it so a remote row
appears in the local window. The remote daemon owns the repos, worktrees,
PTYs and agents *on the remote box*.

This is a **different axis** from the two existing remote-ish plans:

- `PLAN-REMOTE.md` — the *local* daemon reaches OUT to remote SSH
  servers (file browser / terminal / RDP) as a pure filesystem view.
  No remote daemon involved.
- `PLAN-SESSION-SHARE.md` — two daemons on the same LAN exchange
  session offers (unidirectional JSONL push). Both daemons are peers,
  neither is "the host you live in."

Here, by contrast, a **full remote daemon** runs on the box and the local
daemon proxies to it, so its repos appear as live rows next to local ones
— not a flat file view, not a one-shot session push.

## The core security insight

The daemon has no HTTP auth. It decides trust by **request origin**:

- **loopback (127.0.0.1)** → full API: terminals/PTY, `/api/command/run`,
  file read/write, diff, agents. Everything.
- **remote IP** → only the 4 `LAN_ALLOWED_ROUTES` (health, identity GET,
  sessions/offer, messages/receive), and only with peer mode on.
  See `packages/daemon/src/server.ts:534` (allowlist), `:620`
  (`isAllowedHost`, anti-DNS-rebinding), `:1529` (request gate).

A "remote working folder" needs exactly the routes that are
**permanently loopback-only**. So the safe design is NOT to widen the
LAN allowlist (that reintroduces the unauthenticated-RCE hole closed in
commit 59e32b6). Instead:

> **Make the remote connection look like loopback via an authenticated,
> encrypted tunnel.** Browser → tunnel → `127.0.0.1:<port>` on the
> remote box. The daemon sees loopback → full API, unchanged. Safety
> comes from the tunnel's crypto, not from the HTTP layer.

The secret therefore lives at the **transport layer** (a private key),
not in a token-in-URL (which would require adding TLS + auth to the
daemon and exposing it to the internet — explicitly out of scope here).

## Transport decision: SSH first, WireGuard optional

**SSH tunnel is the default** for the "one command, get a key, connect,
nothing installed" goal:

- SSH client already ships on macOS / Windows / Linux → genuinely
  nothing to install.
- The "token" is literally an SSH private key — matches the ask.
- Zero daemon changes; SSH is more battle-tested than anything we'd write.
- The key can be locked to forward-only:
  `restrict,permitopen="localhost:<port>",command="..."` in
  `authorized_keys` — that key can do *nothing* but forward to the daemon.

Connect:
```
ssh -N -L 7777:localhost:7777 supergit@<host> -i supergit_key
# open http://localhost:7777
```

**Raw WireGuard is the optional upgrade** (no Tailscale, no SaaS) when
you want roaming-stable always-on VPN or multiple services on the box.
The generated `.conf` (laptop private key + server public key +
endpoint) IS the token. Costs: needs a wg client on the laptop (not as
universal as ssh), needs a UDP firewall hole, occasionally blocked on
hostile networks where SSH-over-443 survives.

Explicitly **NOT** in scope: Tailscale/Headscale dependency; the
no-client "paste a magic token URL" model (requires daemon TLS + auth +
public exposure).

---

## Roadmap

### Phase 0 — Loopback-only bind (prerequisite, smallest safe step) ✅ DONE
- [x] Add `SUPERGIT_BIND` env var; default keeps today's `0.0.0.0`
      (so LAN session-share is unaffected). `const BIND` at `server.ts:198`,
      consumed at `hostname: BIND` (`server.ts:1481`).
- [x] Document that tunnel deployments should set
      `SUPERGIT_BIND=127.0.0.1` so the daemon is unreachable except via
      the tunnel, even if the box firewall is misconfigured. (Comment block
      at `server.ts:184-197`.)
- [x] Test: characterization test pins the `SUPERGIT_BIND` resolution +
      `0.0.0.0` default and that `Bun.serve` consumes `BIND` (no hard-coded
      literal). `packages/daemon/test/server-bind.test.ts`.

### Phase 1 — One-command remote install ✅ DONE (systemd + Docker)
Deliverables under `deploy/`. Two deployment shapes, same end state
(daemon reachable ONLY via the tunnel):
- [x] `deploy/install.sh` — systemd path. On the box: installs Bun
      system-wide (`/usr/local`, so the service user can exec it), clones
      + builds the SPA (the macOS artifact pipeline can't produce a Linux
      server bundle, and node-pty/ssh2 must compile on Linux — so we build
      on the box), creates a `--system` `supergit` user, installs the unit.
  - [x] `deploy/supergit-daemon.service` — unit template; binds directly
        to loopback via `Environment=SUPERGIT_BIND=127.0.0.1`.
  - [x] forward-only SSH key: `restrict,port-forwarding,permitopen=
        "127.0.0.1:<port>",command="…"` in the service user's
        authorized_keys — the key can ONLY tunnel to the daemon, no shell.
  - [x] prints the private key + the exact `ssh -N -L …` line + browse URL.
  - [x] idempotent (git fetch/checkout in place, reuse workspace + key)
        and `--uninstall`.
- [x] `deploy/Dockerfile` + `deploy/docker-compose.yml` — Docker path.
      Multi-stage build IS the prebuilt Linux artifact (builds node-pty
      etc. on Linux inside the image). Runs with **host networking** +
      `SUPERGIT_BIND=127.0.0.1` (NOT bridge + `-p`). Workspace on a named
      volume so it survives image upgrades.
- **Build-tested 2026-05-30** (`docker build`, Docker Desktop 29.2.1):
  image builds clean (660 MB), boots, serves (logs show `listening on
  …:7777`). What the test did and did NOT prove:
  - ✅ VERIFIED: bridge + `-p 127.0.0.1:7790:7777` → **403 `peer mode is
    off`** on *every* route. Docker's bridge port-proxy rewrites the
    request source to the gateway (172.17.0.1), which the daemon's
    origin-based auth (`isLoopback`, `server.ts:546`) treats as remote →
    LAN gate. A real SSH tunnel lands on host loopback → same proxy →
    would also 403. **Proves the original bridge+`-p` design was broken** —
    the reason we switched to host networking.
  - ⚠️ NOT VERIFIED: `--network host` + `SUPERGIT_BIND=127.0.0.1` → got
    **`HTTP 000`** (connection refused) here, because Docker **Desktop**
    (Win/Mac) runs containers in a Linux VM, so host networking does NOT
    map to the Windows host loopback. On a real **Linux** box the
    container shares the host net namespace → daemon on the host's actual
    loopback → a tunnelled request arrives as genuine `127.0.0.1` → full
    API. This is the *expected* design but is UNPROVEN until run on Linux;
    it must be part of the live smoke test.
  - ✅ VERIFIED: `.dockerignore` must live at the **context root** (repo
    root), not `deploy/` — else `COPY . .` drags host `node_modules`
    (wrong-platform node-pty) over the Linux build. Moved + fixed.
- Validated: `bash -n deploy/install.sh` passes; unit template renders
  with all placeholders filled.
- Still NOT done: smoke test through a *real* SSH tunnel end-to-end, and
  `install.sh`'s `git clone` assumes a reachable repo (currently private +
  unpushed — see Distribution below).

### Distribution — private repo blocks `git clone` (decide later)
`install.sh` clones `github.com/marwie/supergit`, which is **private and
not yet pushed**, so the systemd path can't run as-is on a fresh box.
Coolify-style fix (deferred, user wants to decide): publish a **prebuilt
image to a public registry** (GHCR package visibility is independent of
repo visibility → private repo, public image) and ship a `curl | bash`
installer that `docker pull`s instead of cloning. Keeps the loopback +
tunnel posture (host networking), just swaps build-on-box for pull. The
image build is already proven; only the CI push + pull-installer remain.

### Install the remote daemon on macOS / Windows boxes too (TODO)

`install.sh` is Linux/systemd-only (apt, systemd unit, /bin shells, Go
build via apt). A remote daemon should be installable on a **macOS** or
**Windows** box too (the tunnel + proxy are OS-agnostic; the daemon is
Bun + the Go pty-helper, both cross-platform). What each needs:
- [ ] **macOS remote install** — a launchd plist instead of the systemd
      unit; Bun + Go install via the same curl installers (or brew);
      `SUPERGIT_BIND=127.0.0.1`; the forward-only key in
      `~/.ssh/authorized_keys` (macOS sshd honors the same `restrict,…`
      options). Shell default is already handled (firstExistingPosixShell
      → /bin/zsh|bash). Package the connection-string emission like the
      Linux banner.
- [ ] **Windows remote install** — the hard one: a Windows service (or
      Scheduled Task) instead of systemd; OpenSSH-Server on Windows for the
      tunnel + `permitopen` (Windows authorized_keys lives at
      `%ProgramData%\ssh\administrators_authorized_keys` for admins, else
      `~\.ssh`); the Go pty-helper builds for win32 (ConPTY path exists in
      helper-go/signal_windows.go); shell default → powershell/cmd (already
      handled). The Windows key-ACL lockdown we hit on the CLIENT (icacls)
      applies on the box side too.
- Note: this is the daemon RUNNING ON mac/windows — distinct from the
  container-test note below (which rejected dockurr/microsoft-windows for
  the TEST harness). Real mac/windows remotes are a legit deploy target;
  the blocker is just writing the per-OS installer + service glue.

### Phase 2 — Make connecting friction-free
- [ ] Helper that wraps `ssh -N -L …` (autossh-style reconnect on
      network change / laptop sleep).
- [ ] Optional: emit a one-liner / clickable that opens the tunnel and
      the browser tab together.

### Phase 2b — "Connect daemon": automated onboarding from the Add-daemon dialog (DESIGN — proposed 2026-06-02)

The vision (user): in the Add-daemon dialog, point supergit at a machine;
it provisions the remote daemon and registers it with ZERO manual steps —
the dialog stays open showing progress until the connection is live (or the
user aborts, which must also stop the remote installer if still running).

**THE FORK (undecided — decides the whole architecture):**
- **Model A — fully automated.** The dialog takes ADMIN ssh creds (host +
  password/key); the LOCAL daemon ssh'es in, detects the OS, runs/updates
  the installer with live progress, captures the printed `supergit1:` token
  from stdout, and registers. Most magical, but turns the daemon from a
  "only ever opens forward-only outbound tunnels" tool into a PRIVILEGED
  remote-exec tool: admin creds in daemon memory; password auth needs
  PTY-driven ssh (ssh refuses passwords without a tty); much larger attack
  surface. Not a new vulnerability (it's the user's own machine) but a big
  new capability.
- **Model B — guided one-paste (recommended default).** supergit generates
  the exact OS-aware command (e.g. the tar-over-ssh + `install.sh --no-pull`
  pair, or a `curl|bash`); the user pastes it once on the box; it prints the
  token; supergit auto-detects + registers. Daemon never holds admin creds
  or runs privileged remote commands. ~80% of the magic, ~20% of the
  surface.
- Leaning: ship B as default, keep A as an opt-in "advanced auto-provision"
  later. STILL THE OPEN QUESTION — decide before building.

**What's already in place (reusable):**
- `install.sh --no-pull` is idempotent + re-run-safe (upgrade in place);
  builds linux-native artifacts ON the box (bun install / bun run build /
  go build the pty-helper) — this is why we ship SOURCE, not the native
  build's compiled binaries.
- The installer already prints a `supergit1:` connection string on stdout →
  capture + `decodeConnectionString` + register (the `/api/daemons/connect`
  path we built). "Known vs new machine" = check remote-daemons.json by
  host; "needs update" = compare version/buildTime.

**Correctness requirements (both models):**
- [ ] The remote install must run in the FOREGROUND of the ssh session (no
      nohup/detach) so closing the connection SIGHUPs it on abort. Combined
      with idempotent re-run, a half-killed install is recoverable.
- [ ] Dialog lifecycle: install is minutes-long (bun install + go build).
      It runs on the LOCAL daemon (it owns the ssh connection), so ideally
      survives a dialog close/reload and the dialog reconnects to progress;
      MVP can be "close = abort". Abort must kill the remote process.
- [ ] Live progress channel to the dialog (reuse SSE or the WS we have).

**CODE-DELIVERY dependency (the answer to "package the installer with the
electrobun build?"):** tar-over-ssh ships the SOURCE TREE; the box builds
itself. This works TODAY from a git checkout (`bun dev`) because the source
is right there. BUT the packaged app (`build-native.ts` →
`Supergit.app` / the electrobun .exe) ships only COMPILED, current-platform
artifacts (a `bun build --compile` binary + the Go helper for the LOCAL
os/arch + UI dist) — it does NOT contain `deploy/install.sh` or
`packages/**` source, and the compiled binaries are the WRONG platform for
a linux box anyway. So auto-provision FROM THE PACKAGED APP needs one of:
- [ ] **Bundle the install payload into the app** — add `deploy/install.sh`
      + a source tarball (or `packages/**` source needed to build on the
      box) into the electrobun Resources, so the running app can ship it
      over ssh. This is the real "package the installer with the build"
      task — distinct from the compiled daemon binary; ~a few cp lines in
      build-native.ts + a known Resources path the daemon reads.
- [ ] OR deliver via the public image / `curl|bash` (the deferred
      Distribution path) — app tells the box to pull, nothing bundled.
- Until then, auto-provision is DEV-ONLY (works from a git checkout, not
  the shipped app). Fine for current testing; not shippable to users.

### Phase 3 — WireGuard path (optional, parallel to Phase 1)
- [ ] Installer variant: `wg genkey`, register laptop as a peer, open
      the UDP port, emit a `.conf`.
- [ ] Doc: when to pick WireGuard over SSH (roaming, multi-service).

### Phase 4 — UI (the remote folder row)

**Trace done (2026-05-30).** The single-daemon assumption is *shallow but
scattered*: the UI has **no central fetch helper** — ~177 `fetch("/api/…")`
call sites all use relative, same-origin paths. WS and SSE derive their
host from `location.host`:
- SSE: `App.svelte:4448` — `new EventSource("/api/stream")`
- WS:  `TerminalView.svelte:373` — `` `${proto}//${location.host}/api/terminals/…` ``
- prefs: `daemon-kv.ts:64` — `fetch("/api/prefs", …)`
- repo list: `App.svelte:3302` — `fetch("/api/repos")` (streamed NDJSON;
  `ProcessList.svelte` just loops the `repos` array — rendering is already
  daemon-agnostic).
- Vite dev proxy: `vite.config.ts:19-31` forwards `/api` (with `ws:true`)
  to `localhost:${SUPERGIT_PORT ?? 7777}`.

With the reverse-proxy architecture (top of doc) the browser stays
same-origin with the local daemon, so the CORS/TLS problem the raw
"browser → many daemons" approach would create simply doesn't arise. Two
milestones: a free same-origin shortcut, then the real folder-row build.

#### Phase 4a — Same-origin tunnel (free fallback, NOT the goal) — ~FREE
The tunnel makes the remote daemon answer on `http://localhost:7777` *on
the laptop*. To the browser that IS the origin, so every relative
`/api/…`, the `location.host` WS, and the SSE stream **already work with
zero code changes** — but you're *in* the remote box (a separate tab),
not viewing it beside your local repos. Worth confirming as a cheap
milestone on the way to 4b; not the end state.
- [ ] Confirm end-to-end: tunnel up → open `http://localhost:7777` →
      repos, terminals (WS), live stream (SSE) all work against the box.
- [ ] Doc as the "I just want to be on the remote box" shortcut.

#### Phase 4b — Remote daemon as a folder row (THE GOAL) — local daemon proxies
This is what we actually want: a remote row living *beside* local rows in
the one local window. Built via the **reverse-proxy architecture** (see
top of doc) so the browser stays same-origin with the local daemon and we
never touch CORS/TLS or re-expose the remote daemon.

Daemon side (new local-daemon code):
- [x] A registry of attached remote daemons (id, label, host/user/port,
      sshPort, identityPath, color). Stored in `remote-daemons.json` (own
      file, not repos.json/prefs). CRUD + add→remove→restore round trip.
      `workspace.ts`; tests `remote-daemons.test.ts`. (commit b82c8bd)
- [x] TunnelManager: owns `ssh -N -L <localPort>:localhost:<remotePort>`
      per daemon — idempotent open per id, free-port alloc, close()/auto-
      drop on ssh exit, closeAll() on shutdown. The `Bun.spawn(ssh)` is
      injected so logic is unit-tested without a real SSH server.
      `tunnel-manager.ts`; tests `tunnel-manager.test.ts`. (561f37d)
- [x] HTTP proxy routes: `GET/POST /api/daemons` (list/register),
      `DELETE /api/daemons/<id>` (unregister + tear down tunnel),
      `/api/daemons/<id>/*` → forward over the tunnel to the remote's
      `/api/*`, streaming the body back. Pure path/URL helpers in
      `daemon-proxy.ts` (tests `daemon-proxy.test.ts`); wired in
      `server.ts`. Loopback-only (not in LAN_ALLOWED_ROUTES — lan-gate
      test confirms). (e503cb9 + wiring fix bb61021 + tsc fix 8db8859)
      NOTE: only unit-tested so far — no end-to-end two-daemon test yet
      (see "Two-daemon integration tests" below).
- [x] Proxy WS (`/api/daemons/<id>/terminals/<t>/io`) — `RemoteWsBridge`
      bridges the browser WS to a WS against the remote daemon over the
      tunnel, piping frames both ways. `daemon-ws-proxy.ts`; tests.
- [x] Proxy SSE (`/api/daemons/<id>/stream`) — proxies for free via the
      HTTP forwarder (the streamed body is passed through unbuffered); an
      incremental-streaming test pins that chunks arrive as they're
      produced rather than all at the end.
- [ ] Optionally manage the tunnel itself (spawn/own `ssh -L` per remote)
      so the user doesn't run it by hand — ties into Phase 2. (The
      TunnelManager exists; this is the "auto-open on attach" wiring.)

UI side:

**UI Phase A — `apiUrl()`/`apiWsUrl()` seam sweep ✅ DONE (commit ff1eb43)**
- [x] Central `apiUrl(path, daemonId?)` + `apiWsUrl(path, host, wsProto,
      daemonId?)` helpers in `packages/ui/src/api.ts`: local → `/api${path}`,
      remote → `/api/daemons/${id}${path}`. **Key invariant:** with NO
      daemonId the path is returned byte-identical (a pure no-op for local
      usage), so existing local behavior is unchanged.
- [x] Routed all ~153 daemon URLs across ~30 UI files through the helpers —
      every `fetch("/api/…")`, both EventSource/SSE calls (incl.
      `App.svelte` `/api/stream`), and the terminal WebSocket URL
      (`TerminalView.svelte`). Zero unwrapped daemon URLs remain.
- [x] Tests: `packages/ui/test/api-url.test.ts` (8 tests). Full UI suite
      953 pass / 0 fail.
- Note: `.svelte` files require `bunx svelte-check` (not just `tsc -p`) to
  catch import errors — this caught two real bugs during the sweep
  (duplicate import in `ProcessList`, missing import in
  `ChangedFilesTooltipBody`), both fixed.

**UI Phase B — thread `daemonId` through repo-scoped calls ✅ DONE:**
- [x] Added `daemonId?` to the UI `Repo` shape; the repo-list fan-out
      merges local + each remote daemon's repos into one array keyed by
      `[daemonId, id]` with stable ordering (helpers in
      `packages/ui/src/repo-fanout.ts`, +18 tests). (commit 8401c76)
- [x] Threaded `daemonId` through all repo/worktree-scoped calls:
      SessionView, SourceControlPane, GitHistory, FileDiffTooltipBody
      (+ChangedFilesTooltipBody passthrough), FileBrowser +
      file-browser-utils, preview-action, and App.svelte's
      `/api/command/run`, `/api/wt-summary`, `/api/fetch`. Each defaults
      `daemonId` to `undefined` so the local path stays byte-identical.
      (commit fb483d4)
- [x] Added a routing-guard test
      (`packages/ui/test/daemon-routing-guard.test.ts` + the
      `api-call-audit.ts` scanner, +24 tests) that fails if any
      `apiUrl`/`apiWsUrl` call to a non-global endpoint omits a
      `daemonId` — making a "half-and-half" UI (repo list daemon-aware
      but terminal/diff silently local) impossible to ship green. A
      maintained `GLOBAL_ALLOWLIST` declares the genuinely-local
      endpoints.
- Verified green: full UI suite 1026 pass / 0 fail; svelte-check baseline
  is 41 errors (all pre-existing, none from this work).

**UI Phase C — affordance, remove, status, prefs ✅ DONE:**
- [x] "Add remote daemon" affordance (button beside "Add folder" in both
      the empty-state and footer spots) + a dialog
      (`AddRemoteDaemonDialog.svelte`) collecting
      host/label/ssh-user/ssh-port/daemon-port/identity-file/colour; pure
      validation in `remote-daemon-form.ts` mirroring the daemon
      `addRemoteDaemon()` contract (+20 tests); submits
      `POST /api/daemons` then reloads so the remote's repos fan in.
      (commit 7625294)
- [x] Remove daemon: a "Remove daemon" button in the Edit-repo popover
      (shown only when `repo.daemonId` is set) → `DELETE /api/daemons/<id>`
      (registry is always local, not daemon-routed), optimistic row drop +
      reload. (commit b534310)
- [x] Per-row online/offline dot: `load()`'s fan-out records per-daemon
      reachability into a `daemonsOnline` map (a remote whose repo fetch
      rejects = offline), passed to `ProcessList`; `repoDaemonStatus()`
      (+4 tests) drives a green/red dot in the repo-group header.
      Limitation: an offline daemon's rows are stale-from-last-load — on a
      cold load it shows no rows at all (nothing fans in). (commit b534310)
- [x] Per-daemon prefs namespacing: `repoPrefsKey(repo)` (+4 tests) keys
      the row key (foldedRows/notesHidden) and `visibleWorktrees` by
      `daemonId:id` for remote repos, **byte-identical for local** (no
      migration). `storage.ts` unchanged — the key is opaque to the store.
      (commit 5fe5c6c)
- Note: peer discovery in `App.svelte` is session-share messaging, not
  repo browsing — not reusable here.

The whole feature is now reachable end-to-end in the UI. The only
remaining work is the two-daemon **live smoke test** on a real Linux box
over an SSH tunnel (blocked on provisioning).

### Live-deployment fixes (2026-06-01, first real Hetzner run)

Running the installer against a real box flushed out a chain of bugs the
unit tests couldn't see (they faked the OS boundary). All fixed:

- **Tunnel target `localhost` → `127.0.0.1`** + `StrictHostKeyChecking=
  accept-new` — the forward-only key's `permitopen` is matched literally,
  and BatchMode turns a first-connect host-key prompt into a hard fail.
  (`tunnel-manager.ts`; tests updated.)
- **`open()` now waits for the `-L` listener** before returning — ssh
  binds the local port a few hundred ms post-auth, so the first proxied
  request was racing it and failing "connection refused" with no retry.
  Injectable `waitForPort`; +2 tests. (commit a505ab1) **This was the
  "row never appears" bug.**
- **One-paste onboarding**: installer emits a `supergit1:` connection
  string (host+user+port+key); `POST /api/daemons/connect` decodes it,
  writes the key 0600 under `<workspace>/keys/`, registers.
  `connection-string.ts` +14 tests; dialog paste field + Advanced
  disclosure.
- **`/api/diagnose`** (`diagnostics.ts`, +10 tests): self-config + per-
  remote tunnel/health/warnings, for human/agent triage. Installer banner
  prints the curl one-liners.
- **Dialog feedback**: success toast + don't trust `res.ok` (an
  un-rebuilt daemon answers 2xx HTML via SPA fallback → false success).
- **Menubar "Daemons" list**: see/remove every registered daemon
  independent of repo rows (removal was previously only on a repo row's
  Edit popover — useless for an orphan/offline daemon). Optimistic
  removal of `remoteDaemons` + per-row spinner + rollback on failure.
- **Installer**: `--no-pull` (rsync path), restart-on-upgrade (not just
  `enable --now`), and CRLF/`unzip`/`BUN_INSTALL` scoping fixes.

**TESTING TODO (agreed 2026-06-01):** several of the above are only
unit-covered at the pure-function layer; we still want tests at the wired
layer:
- [ ] **Two-daemon e2e** (the deferred opt-in harness below) — the real
      proof that connect → tunnel-wait → proxy → remote repos works
      against an actual second daemon. This is the single biggest gap.
- [ ] **`/api/daemons/connect`** route test: a bad/garbage token → 400
      with a clear error; a valid token → key written 0600 + daemon
      registered (temp workspace, no real ssh).
- [ ] **`removeDaemon` UI behaviour**: optimistic removal from
      `remoteDaemons`, per-row spinner, and rollback on a failed DELETE —
      the reactivity bug found on 2026-06-01 had no test. Needs the
      handler extracted to a testable pure reducer or a component test.
- [ ] **`postRegisterDaemon` guard**: a 2xx-non-JSON (SPA-fallback)
      response must throw "older build…", not false-succeed.
- [ ] **Installer token ↔ TS decoder** round-trip as an automated check
      (proven manually 2026-06-01; pin it so the bash + TS formats can't
      drift).

**LESSON — our net misses runtime errors (2026-06-01).** A prod crash
("Cannot access 'handle' before initialization", minified to 'cleanup')
took out the remote-row terminal. It got past everything because:
  1. It's a **runtime TDZ**, not a type error — `svelte-check`/`tsc` see
     the reference as in-scope; it only explodes when the code executes in
     a particular order. Static checks structurally cannot catch this.
  2. The existing `scroll-restore.test.ts` only fired its timer/user-scroll
     callbacks **asynchronously** (after setup returned). The crash needs a
     **synchronous** callback during subscribe — the exact path no test
     exercised. (Fixed + regression-tested in c56a5a7; the new test was
     verified to FAIL on the pre-fix code.)
  3. **No component-mount tests exist** — `bun test` covers pure functions;
     nothing instantiates a Svelte component, so component lifecycle /
     prop-undefined / TDZ bugs never run in CI.
What actually closes this class (do these):
- [ ] **Run-the-app smoke pass** (the `/verify` step, or a scripted
      headless boot) exercised against BOTH a local row and a remote row:
      open a terminal, a diff, change a setting. Most of the live-USE bugs
      below (#1/#4/#7/#9/#10 + this TDZ) would have been caught the instant
      the app actually ran. This is the highest-leverage missing test.
- [ ] **Injected-dependency callbacks must be tested firing BOTH sync and
      async.** Any helper that takes a timer / subscription / callback env
      (restoreScrollAfterDelay, the resize coalescer, TunnelManager's
      waitForPort, …) gets a "fires synchronously during setup" case — that's
      where TDZ / re-entrancy bugs hide.
- [ ] **Component smoke-mount tests** for the remote-row-critical components
      (TerminalView, SessionView, FileBrowser, OpenInActions): mount with a
      `daemonId` set and assert no throw + that calls carry the daemonId.
      Needs a DOM test harness (happy-dom / @testing-library/svelte) — none
      exists yet; standing this up is the prerequisite for catching the
      whole runtime-error category, not just this one bug.

### Live-USE issues found while driving a real remote row (2026-06-01)

Once `slugify` from the Hetzner box rendered as a folder row, actually
*using* it surfaced these. Tracked here so none are lost:

- [x] **Tunnel worked but no row / "tunnel failed"** — chain of fixes:
      127.0.0.1 target, host-key accept-new, open() waits for listener,
      proxy surfaces real errors, **Windows key ACL lockdown** (the final
      root cause: ssh rejects 0600-but-ACL-open key). Row now renders.
- [x] **#1 Terminal on a remote row fails (Windows err 267 / cwd invalid)**
      — DONE. `daemonId` now threads App → SessionView → TerminalView and
      App → NewSessionCol → TerminalView; TerminalView's POST `/api/terminals`
      AND the `/api/terminals/<id>/io` WS both carry it, so a remote row's PTY
      spawns on the box. Proven live against Hetzner (bash on the box, echo
      READY_42).
- [x] **#4 Editing remote repo settings does nothing (color, rename, …)**
      — DONE. Every repo-scoped POST now routes `daemonIdForRepoId(repos,id)`:
      `/color`, `/rename`, `/checkout`, `/pull`, `/push`, `/worktrees`,
      `/custom-links*`, the DELETE, and `/summary` (RepoRecentSummary). Bare
      for local (byte-identical), the owning daemon for remote rows.
- [x] **Routing-guard blind spot — FIXED (commit 8c669fd)**. Two holes
      closed: (a) `/api/repos`/`/api/terminals` were allowlisted as PREFIXES,
      so a bare `/api/repos/<id>/color` passed — now they're global only at
      the EXACT path, their `/<id>/...` sub-paths must thread daemonId;
      (b) the lexical scanner desynced on a regex literal containing a quote
      (`s.replace(/["\\]/g,…)`) and went blind, silently skipping 35+ calls
      (ALL 28 StickyNotesLayer note routes, 7 in SessionView) — rewrote
      `api-call-audit` as a regex-aware blanking pass. The fixed guard then
      surfaced 6 genuinely un-routed scoped calls (terminal-kill ×3, repo
      summary, pasted-image `/api/image`, text-attachment `/api/attachment`),
      all now threaded.
- [x] **#2 Stars collide across daemons** — FileBrowser now namespaces
      BOTH the StarStore key and the nav-state key (`KV_KEY`) by daemonId
      (`base + ":" + daemonId`), byte-identical for local (no migration).
      +2 StarStore tests (different keys don't share, local key unchanged).
- [x] **#3 Add a folder / git repo on the REMOTE daemon from local UI**
      — DONE (MVP). A per-daemon "+ Folder" button in the menubar Daemons
      list opens `AddRemoteFolderDialog` (preselected to that daemon): pick a
      daemon + type a path that already exists ON THE BOX → `POST
      apiUrl("/api/repos", daemonId)` → `load()`. The remote daemon's
      `addRepo` validates the path against its own fs and returns a 409
      (missing / not a git repo) that surfaces inline. Pure validation in
      `remote-folder-form.ts` (+8 tests). STILL TODO: browse via proxied
      `GET /api/files?path=` instead of typing; remote `git clone`/`init`
      (no such endpoint yet — repo must already be on the box).
- [x] **#5 Remote worktree path is shown bare** — remote rows now show a
      `.daemon-row-chip` (the daemon label) before the worktree path so
      it's clear the path lives on another box. `daemonLabelForRepo()`
      resolves the label from `remoteDaemons`; local rows render no chip.
- [ ] **#6 Local apps appear under the remote daemon column** — the
      process/TUI list (local-machine `/api/processes`) seems to be
      grouping local procs under the remote row. NEEDS INVESTIGATION
      (repro/screenshot) — likely a grouping key that ignores daemonId.
- [x] **add-remote-daemon button icon missing width/height** — fixed,
      added width=20 height=20 to match sibling add-folder icons. (2213d1c)
- [ ] **#7 "Start a new session" shows LOCAL agents/shells on a remote
      row** — the dropdown lists Claude/Codex/Ollama/Terminal with their
      *local* Windows exe paths (C:\Users\…\claude.exe, cmd.exe), but a
      session on a remote row runs on the remote (Linux) box. `load()`
      fetches `/api/agents/installed`, `/api/shell-default`, `/api/editors`
      ONCE from the local daemon into global arrays used by every row. Fix:
      fetch per-daemon via `apiUrl(path, daemonId)`, key by
      `daemonId ?? "local"`, and have each row's dropdown read its daemon's
      set — so a remote row shows the box's Linux agents and spawns the
      tunnel back to the local UI. **DONE** (0c395ea): agentsByDaemon /
      shellByDaemon / shellArgsByDaemon keyed by daemonId|"local";
      cmdForOpenSession at the NewSessionCol render uses the row's set.
- [x] **#8 "Open in" badges on a remote row mostly don't apply** — gated
      Open-in-<editor>/Fork/Terminal/Files behind `{#if !daemonId}` in
      OpenInActions (55ca06a) + wired daemonId from App (0c395ea); URL
      chips stay.
- [x] **#9 Remote repo reorder fails ("orderedIds length must match
      existing repos")** — the reorder dialog emits the MERGED local+remote
      id order, but `/api/repos/order` validates against ONE daemon's
      registry. `reorderRepos` now splits the order by owning daemon and
      POSTs each via `apiUrl("/api/repos/order", daemonId)`.
- [x] **#9b Remote reorder POSTed but UI didn't re-render** — reorderRepos
      relied on the local daemon's `repos_reorder` SSE broadcast to refresh,
      but a REMOTE daemon broadcasts on ITS stream (this UI isn't subscribed
      to it), so the new order persisted on the box but never showed. Now
      `reorderRepos` `await load()`s after the POSTs to re-run the fan-out.
- [x] **#11 Remove-daemon needs a confirm** — `removeDaemon` now shows the
      custom `confirmDialog()` (danger style, names the daemon) before
      tearing down the tunnel + deleting the key; cancel aborts.
- [x] **#10 Remote terminal: "/bin/zsh: No such file or directory"** — the
      systemd daemon has no `$SHELL`, so `defaultLoginShell()` hit its
      hard-coded `/bin/zsh` fallback, but a fresh Debian box has no zsh.
      Now `firstExistingPosixShell()` probes /bin/bash → /usr/bin/bash →
      /bin/sh → /bin/zsh (injectable `exists`); +4 tests.
- [x] **#12 Remote terminal WS "loads forever" (never connects)** — the
      proxy WS upgrade did `await ensureRemoteTunnelPort()` BEFORE
      `srv.upgrade()`. Bun requires the upgrade to run synchronously in the
      fetch handler; awaiting first detaches the request context so the
      upgrade silently fails and the browser WS hangs in "connecting"
      (phase stays "starting" forever). Fixed: upgrade synchronously,
      stash {daemonId, rest, search} in ws.data, then open the tunnel +
      wire RemoteWsBridge inside the websocket open() handler (async OK
      there; the bridge already buffers pre-open frames). The local
      terminal path worked because it never awaits before upgrade — that
      asymmetry was the tell.
      TESTING GAP: daemon-ws-proxy.test.ts tests the bridge in isolation
      against a fake remote, so it never exercised Bun's sync-upgrade
      constraint. This is exactly what the deferred Tier-3 two-daemon /
      container e2e (real upgrade through a real tunnel) must cover.
- [x] **#13 Remote terminal SIGHUPs on spawn (every shell dies instantly)**
      — probing the live box: the daemon's PTY backend prefers a prebuilt
      Go `pty-helper`, else falls back to `node helper.mjs` (needs `node` +
      node-pty's native linux binary). The box had NEITHER: no `pty-helper`
      (install.sh never built it), `NO node` on PATH, and node_modules/
      node-pty shipped only darwin/win32 prebuilds — NO linux-x64 — so
      node-pty couldn't drive a tty → every PTY (bash -l / bash / sh)
      exited with SIGHUP the instant it spawned. (And that synchronous
      onExit is what triggered the #-cleanup TDZ, 0bdd080.) Fix: install.sh
      now installs Go if missing and `go build`s the pty-helper on the box
      (the node-free PTY path supergit prefers), so terminals work without
      node / node-pty. Committed in install.sh.
- [x] **#cleanup TDZ** (0bdd080) — the synchronous onExit from a
      SIGHUP-on-spawn PTY hit a `const cleanup` in its temporal dead zone
      ("Cannot access 'cleanup' before initialization", a 500 out of the
      spawn POST that masked #13). Pre-declared `let cleanup` + null-guard.

### Remote file editing (TODO — full feature; toast shipped as the interim)

Double-clicking a file on a remote-daemon row can't "Open in" the local OS
app — the file lives on another machine, and `/api/open-default` would try
(and fail) to open a non-existent local path. **Interim (shipped):**
`FileBrowser.openFile` now detects the remote-daemon case (`daemonId` set,
not the ssh `remoteTermId` case) and shows a toast — "Editing files on a
remote daemon isn't supported yet — open a terminal on this row to edit
there." — instead of silently no-op'ing. Wired via a new `onToast` prop →
`addToast` in App.

**Full feature (to build).** Mirror the ssh-filesystem edit flow
(`/api/ssh/open` → edit locally → `/api/ssh/confirm-upload` /
`dismiss-upload`) for the remote-daemon axis, over the proxy:
- [ ] **Daemon endpoints** (loopback-only, so reachable through the proxy):
  - `GET /api/file?path=<abs>` → `{ content, mtimeMs }` (read for editing);
  - `POST /api/file` `{ path, content, expectedMtimeMs }` →
    `{ ok: true, mtimeMs }`, or `409 { conflict: true, mtimeMs }` when the
    on-disk mtime ≠ `expectedMtimeMs` (external change → UI offers
    save/discard). These auto-route through `/api/daemons/<id>/*`.
- [ ] **UI**: double-click a remote file → fetch content via the proxy into
      an in-app editor (or a downloaded local cache like the ssh flow) →
      Save posts back with `expectedMtimeMs`; on `409 conflict` show the
      save/discard prompt (reuse the ssh-filesystem affordance).
- [ ] Decide read-only-vs-editable defaults and large/binary-file guards.
- **Test**: the failing spec already exists in
  `two-daemon-e2e.test.ts` ("a remote file opens for editing and saves back
  with external-change detection") — kept RED on purpose; implementing the
  above turns it green.

### Phase 4c — remote-daemon STATE PARITY (which state lives where)

Once a remote row works, the question is whether its persisted state lives
on the remote box (like local) or is missing. Audited 2026-06-01. The
daemon SIDE writes most of this correctly to its own workspace; the gap is
the UI only QUERIED the local daemon. Split into two principles:
  - "How I VIEW the remote repo" (column layout, folds, stars) → belongs
    LOCAL (it's about your window). Mostly handled; keyed per-daemon via
    repoPrefsKey so daemons don't collide.
  - "What's TRUE about the remote repo" (open shells, its events/undo,
    session titles) → belongs on the REMOTE box; UI must fetch per-daemon.

- [x] **#14 Open shells / persisted terminals not restored for remote rows**
      — `restoreLiveShells` + `restorePersistedTerminals` fetched only the
      LOCAL `/api/shells` + `/api/terminals/persisted`, so a remote row's
      open terminals vanished on reload. Now both loop `[local, …remoteDaemons]`
      and fetch per-daemon via `apiUrl(..., daemonId)`. CRUX: live shells
      from ALL daemons are collected into ONE list before the single
      `mergeLiveShells` call — that helper PRUNES attached rows not in the
      list it's given, so a per-daemon call would prune other daemons'
      shells. Restore runs once at onMount (local, snappy) and again after
      load() resolves (so `remoteDaemons` is populated); both passes are
      idempotent (dedupe by source). resume/dismiss of a remote restored
      terminal routes `/api/terminals/persisted/remove` to the owning
      daemon via `daemonIdForWorktreePath`.
- [ ] **#15 Remote events / undo tray invisible** — remote mutations (add
      worktree, rename, …) write the REMOTE daemon's events.jsonl and
      broadcast on ITS `/api/stream`, but the UI only reads local
      `/api/events` + subscribes to local SSE. So remote changes don't
      appear in the undo tray / events popover, and remote rows don't
      live-refresh on remote-side changes (we paper over this with explicit
      `load()` after remote mutations — see #9b).

  DESIGN (mapped 2026-06-01). Split into two parts — very different
  value/risk; do #15a, defer #15b:

  - [x] **#15a — Live refresh via per-daemon SSE (HIGH value, low risk)
        — DONE.** `/api/daemons/<id>/stream` already proxies SSE
        incrementally (daemon-proxy-forward.test.ts). Implemented:
        `handleRemoteStreamChange(rawData)` handles ONLY a remote daemon's
        repos-refresh (`load()`, gated by changeKindRequiresReposReload) +
        notes-key bump (note_*/undo/redo) — deliberately NOT the full local
        handler, since sound_play / toasts / fs_change tooltips / messages /
        peerDiscovery / commands are LOCAL-machine UX that must not fire for
        another box's activity (firing them would double-toast / play
        sounds). `syncRemoteStreams()` opens one EventSource per ONLINE
        remote daemon (`apiUrl("/api/stream", id)`), idempotent via a
        `remoteStreams` Map; a `$:` reactive on remoteDaemons/daemonsOnline
        re-syncs on add/remove/offline; closeRemoteStreams() on onDestroy.
        Effect: remote-side changes (incl. another client editing the box)
        live-refresh the UI — the explicit post-mutation load()s (#9b,
        reorder) + the #17 notes-live limitation are now covered.
        Local behaviour byte-identical (local handler untouched).
  - [ ] **#15b — Remote events in the undo tray (LOWER value, real
        complexity — DEFER).** Unlike `/api/repos`, `/api/events` is
        per-daemon and the local UI only fetches local. To show + undo
        remote events:
        - fetch `/api/events` from each daemon, merge + reverse-sort into
          one tray (cross-daemon time ordering is fuzzy — clocks differ);
        - add `daemonId` onto each Event record (in-memory) so
          `toggleEvent(id, toggle, daemonId)` POSTs `/api/events/<id>/<toggle>`
          to the OWNING daemon;
        - decide UX for a merged undo stack across machines (is "undo" the
          last action on ANY daemon, or per-daemon?). This is a product
          question, not just plumbing — undo across two machines' histories
          is genuinely ambiguous. Defer until there's a real need; #15a
          already gives live refresh without it.
        Daemon side: NO changes for either (each daemon already broadcasts
        its own stream + serves its own events; the proxy forwards both).
        TESTING: #15a wants a sync-callback test for the stream manager
        (open/close on online/offline, message tagging) + the container
        e2e (a real remote change propagating). Pure handleStreamChange is
        unit-testable; the EventSource manager needs the DOM harness gap.
- [ ] **#16 Session titles for remote shells stored locally** —
      `/api/session-titles` + `/api/session/title` are local-only; a remote
      shell's title lives in the local workspace, not the box. Route by
      daemonId (or accept as a local-view concern — decide).
- [x] **#17 Sticky notes follow the repo to the remote box** — DONE.
      Decided notes live on the owning daemon's machine (not a local-only
      board). `StickyNotesLayer` resolves each note's daemon via
      `daemonIdForAnchors`, fetches notes from `[local, …remoteDaemons]`, tags
      each in-memory with its `daemonId`, and routes all 26 `/api/notes` calls
      by it; the note's text/image attachments (`/api/attachment`,
      `/api/image`) are read from that daemon too (threaded via `note.daemonId`
      through the attachment helpers — see the routing-guard fix above).
- [ ] **#18 Remaining global daemon-kv keys not per-daemon namespaced** —
      openSessions, dismissedShells/Sessions, commitsExpanded,
      commandTermSources still use bare global keys (collision risk across
      daemons). repo-scoped keys are already namespaced (repoPrefsKey);
      extend the same to these board-ish keys where they're repo/source
      specific.

Rough size: ~1.5–2 days. The proxy design moves the hard part off the
browser (no CORS/TLS) and onto ordinary, testable daemon code; the
remaining UI cost is real but mechanical (the `apiUrl` threading).

### Two-daemon integration tests (opt-in, never run by default) ✅ BUILT

The daemon-side proxy was unit-tested (path parsing, tunnel lifecycle with
an injected spawner, registry CRUD) but NOT exercised end-to-end. That gap
is now closed by an opt-in harness that boots two REAL daemons and proxies
between them — `packages/daemon/test/two-daemon-e2e.test.ts`, run via
`bun run test:two-daemon`. 4 tests, ~3s.

- [x] Dedicated runner `bun run test:two-daemon` sets the env guard
      `SUPERGIT_TWO_DAEMON_TESTS=1`; the suite is `describe.skip` without it,
      so a stray `bun test` over the whole tree skips it (verified: default
      run shows the suite skipped, 0 fail) rather than booting daemons.
- [x] Spawns the remote AND local daemon as children on OS-allocated free
      ports with throwaway temp workspaces, `SUPERGIT_BIND=127.0.0.1`,
      `SUPERGIT_NO_UI_DIR=1`; waits for each `/api/health`; kills both +
      removes temp dirs in `afterAll` even if setup throws.
- [x] Skips the ssh hop via `SUPERGIT_TUNNEL_DIRECT=1` (new TunnelManager
      `direct` mode, +3 unit tests): the local daemon proxies straight at the
      remote's `127.0.0.1:<port>` — no `ssh -L`. 10 tests + 1 todo, ~6s.
      Asserts, all through the proxy against the real remote:
      - **health** — `/api/daemons/<id>/health` reports the REMOTE's port
        (proof it crossed the proxy, not served locally);
      - **repos NDJSON** — `/api/daemons/<id>/repos` streams the
        remote-registered repo (and it's absent from the local daemon's list);
      - **terminal WS round-trip** — types `echo`, reads the marker back over
        the proxied WS (the bridge both ways AND Bun's sync-upgrade path, #12);
      - **add repo** — `POST /api/daemons/<id>/repos` registers a folder on
        the remote box; it appears via the proxy, stays off the local list;
      - **remove repo** — `DELETE /api/daemons/<id>/repos/<repoId>` drops it;
      - **browse files** — `GET /api/daemons/<id>/files` lists the remote
        repo's committed `README.md` (the read side of remote file access);
      - **notes** — create + delete via `POST`/`DELETE /api/daemons/<id>/notes`
        (present on the remote, absent from the local board);
      - **live SSE** — subscribe to `/api/daemons/<id>/stream`, cause a remote
        change, receive the `note_create` event (the #15a live-refresh path);
      - **session discovery** — a Claude session planted in the remote's
        isolated `HOME` is found via `GET /api/daemons/<id>/agents`.
      - **intentionally-FAILING spec** (kept red on purpose): remote file
        **edit → save/discard on external change** — not implemented for the
        remote-daemon axis (only `/api/ssh/*` has write-back-with-conflict).
        The test pins the intended `/api/file` GET+POST contract so building
        the feature turns it green; the opt-in harness is skipped by default
        so this never reddens CI. See "Remote file editing (TODO)" below.
- [x] Loud header comment explaining it spawns processes + must be run
      deliberately; never wired into the default `test` script or CI.
- [x] Asserts both chosen ports != prod (`27787`) before spawning anything.
- [ ] Optional follow-up: a variant using a real `ssh -L` to localhost for
      hosts running sshd (Tier 3 below is the canonical version of that).

### Containerized-remote e2e (design — agreed 2026-06-01)

Motivation: the live Hetzner run flushed out ~9 bugs that NO unit test
could see (Windows key ACL, CRLF, cmd.exe-vs-bash, tunnel readiness race,
proxy error masking, …) because they only appear when the real code runs
local→remote over a tunnel. A containerized remote gives that coverage
repeatably, in CI, without a hand-provisioned box. This supersedes the
"spawn a second daemon in-process" sketch above with a more realistic
remote.

**Tiers (build in order):**
- [ ] **Tier 2.5 — Linux daemon container, faked ssh hop.** `docker build`
      `deploy/Dockerfile` → `docker run` it bound to loopback inside the
      container with a published port; register it as a remote daemon whose
      TunnelManager target points at the published port (skip real ssh, the
      OS boundary we already fake). Assert connect → `/api/repos` streams →
      proxied terminal WS round-trips → diff/status work. ~1s container
      start; runs on any Docker.
- [ ] **Tier 3 — real ssh tunnel.** Same container ALSO runs `sshd` with
      the installer's forward-only key; the harness opens a genuine
      `ssh -L` into it and drives the flow through the real tunnel
      (TunnelManager unmodified). True end-to-end incl. tunnel crypto +
      the readiness wait. This is the canonical proof.
- [ ] Both env-guarded (`SUPERGIT_TWO_DAEMON_TESTS=1`), out of default
      `bun test`, loud header comments, guaranteed `docker rm -f` teardown
      in `finally`, and a port/name distinct from prod.

**Cross-platform matrix — the bugs are on the CLIENT, not the remote.**
The remote is realistically ALWAYS Linux (Hetzner / VPS / container); the
OS-specific bugs we hit (key ACL, CRLF, shell path) were on the LOCAL
daemon's side. So the valuable matrix is **one Linux remote container ×
client OS** via GitHub Actions runners:
- [ ] CI job runs the Tier-2.5/3 harness on `ubuntu-latest`,
      `windows-latest`, `macos-latest` — each boots the SAME Linux remote
      container and tests the local→remote flow. This is what catches the
      Windows-ACL / CRLF / cmd.exe class per-platform.

**PRIORITY: the Linux remote container is THE target.** A remote daemon is
realistically always a Linux box (Hetzner / VPS / container), so the
Linux-remote harness above is the one that must exist and run in CI.
Everything below is documented-and-deferred, not planned work.

**Remote-daemon ON macOS/Windows — explicitly out of scope (low value).**
Options the user raised, and why none fit the harness:
- `dockurr/macos` / `dockurr/windows` — a full OS in QEMU/KVM inside a
  container (VNC/SSH). Needs `/dev/kvm` + `--privileged` (nested virt) →
  does NOT run on hosted GitHub runners or Docker Desktop on Mac/Win, only
  on a beefy Linux host; multi-GB image + minutes-long boot → unusable for
  CI cadence; the macOS one is legally gray (Apple EULA = Apple hardware).
- `microsoft/windows` (and `mcr.microsoft.com/windows/*`) — real Windows
  containers, but they ONLY run on a Windows host in Windows-container mode
  (shared Windows kernel); never on Linux CI / Mac, not in Docker Desktop's
  default Linux-container mode.
A remote daemon running on Mac/Windows isn't a stated use case. IF it ever
matters, the right tool is a real Apple/Windows CI runner (or a Windows
self-hosted runner for Windows containers), not a QEMU-in-container —
revisit then. The CLIENT-side OS matrix (above) already covers the
cross-platform bugs that actually occur.

### Phase 5 — Hardening & docs
- [ ] Security note: this design keeps the daemon loopback-only; the
      tunnel is the only entry. Re-confirm no route assumes LAN trust.
- [ ] Operational doc: rotating the SSH/WireGuard key, multiple laptops,
      revocation.

---

## Multi-client readiness (checked 2026-05-30)

The proxy means a laptop AND the box's own browser can drive one daemon
at once. Audited the three usual single-client traps — the daemon is
**multi-client safe**:
- **SSE broadcast**: `sseSubscribers` is a `Set`; each `/api/stream`
  connection adds its own controller and `broadcast()` loops all of them
  (`server.ts:683,751`). No single-controller clobber.
- **Terminal/PTY**: each terminal holds `subs: Set<…>`
  (`node-pty-backend.ts:47`); output fans out to every subscriber
  (`:371`) and the PTY is only reaped when the *last* subscriber leaves
  (`subscriberCount()` + grace check). Two browsers can share one
  terminal — see + type — which is exactly the proxy's behavior.
- **Globals**: top-level `let`s are caches/toggles (`reposCache`,
  `peerModeEnabled`, …), nothing connection-scoped.

Fixed along the way: the `/api/stream` `cancel()` handler had an
empty-`try` no-op loop that never removed the disconnecting controller
(`broadcast()` pruned it lazily on the next event, so not a hard bug, but
it left `sseSubscribers.size` inflated between disconnect and next
broadcast — wrongly keeping the `size === 0` early-returns at
`server.ts` orphan-clean/ssh-sample from firing). Now `start()` captures
the controller and `cancel()` deletes exactly it. Test:
`packages/daemon/test/sse-subscriber-cleanup.test.ts`. (The naive
`delete(controllerOrReason)` "fix" is wrong — `cancel(reason)` gets the
reason, not the controller.)

## Open questions
- Do we want the installer to also configure auto-update
  (see `PLAN-AUTO-UPDATE.md`) on the remote box?
- Worktree-clone speed (the core thesis) holds on the remote box since
  worktrees are local to the daemon there — confirm nothing in the fast
  path assumes the *client* filesystem.
