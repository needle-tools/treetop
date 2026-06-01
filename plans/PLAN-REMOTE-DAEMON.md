# PLAN-REMOTE-DAEMON.md — add a remote daemon as a folder row in the local UI

Status: **Phase 0 + Phase 1 DONE. Phase 4b daemon-side COMPLETE
(unit-tested only): registry + TunnelManager + HTTP proxy + WS bridge +
SSE pass-through all done. UI Phase A (the `apiUrl()`/`apiWsUrl()` seam
sweep) DONE + committed (ff1eb43). UI Phase B (thread `daemonId` into
repo-scoped calls) DONE (8401c76 = repo-list fan-out, fb483d4 = daemonId
threading + routing-guard test). UI Phase C DONE — add-remote-daemon
dialog/affordance (7625294), remove-daemon button + online/offline dot
(b534310), per-daemon prefs namespacing (5fe5c6c). The whole feature is
now reachable end-to-end in the UI. Remaining overall: the two-daemon
live smoke test on a real Linux box over an SSH tunnel (blocked on
provisioning — everything is unit-verified but has not yet talked to a
real second daemon); the opt-in two-daemon e2e test harness also still
deferred.**

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

### Phase 2 — Make connecting friction-free
- [ ] Helper that wraps `ssh -N -L …` (autossh-style reconnect on
      network change / laptop sleep).
- [ ] Optional: emit a one-liner / clickable that opens the tunnel and
      the browser tab together.

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

Rough size: ~1.5–2 days. The proxy design moves the hard part off the
browser (no CORS/TLS) and onto ordinary, testable daemon code; the
remaining UI cost is real but mechanical (the `apiUrl` threading).

### Two-daemon integration tests (opt-in, never run by default)

The daemon-side proxy is unit-tested (path parsing, tunnel lifecycle with
an injected spawner, registry CRUD) but NOT yet exercised end-to-end: no
test spins up a *real* second daemon and proxies a live request through.
We want that coverage WITHOUT it running in the normal `bun test` loop —
spinning up extra daemon processes on every run is slow, port-flaky, and
exactly the kind of thing an agent could trigger accidentally.

Design:
- [ ] A dedicated runner, e.g. `bun run test:two-daemon` (NOT wired into
      the default `test` script), that sets an env guard
      (`SUPERGIT_TWO_DAEMON_TESTS=1`). Test files check the guard and
      `test.skip` themselves when it's absent — so even a stray
      `bun test` over the whole tree skips them rather than booting
      daemons.
- [ ] The harness spawns a second daemon as a child with a DEDICATED test
      port (`SUPERGIT_PORT=<high test port>`) and a throwaway temp
      workspace (`SUPERGIT_WORKSPACE=<mktemp>`), waits for `/api/health`,
      runs assertions, then guarantees teardown (kill + await exit) in a
      `finally` — never leave a daemon running. Bind it loopback-only
      (`SUPERGIT_BIND=127.0.0.1`).
- [ ] First test: skip the ssh hop (it's the OS boundary we already fake)
      — register a remote daemon whose tunnel target points straight at
      the second daemon's real port, then assert `/api/daemons/<id>/health`
      and `/api/daemons/<id>/repos` proxy through and stream correctly.
      Optionally a separate, even-more-guarded test that uses a real
      `ssh -L` to localhost for those who have sshd running.
- [ ] Loud guardrails so future agents don't run these blindly: a header
      comment in each file + the runner printing why it exists, that it
      spawns processes, and that **the user should be asked first**. Never
      add it to CI's default job or the pre-commit/inner loop.
- [ ] NEVER touch the prod daemon (`:27787`) — the test port must be a
      distinct high port; assert the chosen port != prod before spawning.

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
