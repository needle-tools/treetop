# PLAN-REMOTE-DAEMON.md — add a remote daemon as a folder row in the local UI

Status: **Phase 0 + Phase 1 DONE (`SUPERGIT_BIND` + `deploy/` installer,
systemd & Docker). Phase 1 not yet smoke-tested on a live box. Phases 2-5
planned.**

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
- [ ] A registry of attached remote daemons (id, label, tunnel target
      `127.0.0.1:<localPort>`, color). Persist in workspace prefs.
- [ ] Proxy routes `/api/daemons/<id>/*` → forward to that daemon's
      loopback over the tunnel, streaming bodies through (NDJSON repo
      stream, file reads, diffs).
- [ ] Proxy WS (`/api/daemons/<id>/terminals/<t>/io`) and SSE
      (`/api/daemons/<id>/stream`) — Bun can pipe both.
- [ ] Optionally manage the tunnel itself (spawn/own `ssh -L` per remote)
      so the user doesn't run it by hand — ties into Phase 2.

UI side:
- [ ] Central `apiUrl(path, daemonId?)` helper: local → `/api${path}`,
      remote → `/api/daemons/${id}${path}`. Route the ~177 call sites
      through it (mechanical; the bulk of the UI churn).
- [ ] WS (`TerminalView.svelte:373`) + SSE (`App.svelte:4448`) build
      their URL via the same helper instead of bare `location.host`.
- [ ] Add `daemonId` to the `Repo` shape; the repo list fans out to local
      `/api/repos` + each remote `/api/daemons/<id>/repos`, merged keyed
      by `[daemonId, repoId]`. Rendering is unchanged — `ProcessList`
      already loops an arbitrary `repos` array.
- [ ] Per-daemon `daemon-kv` / prefs namespacing — `daemon-kv.ts:64`
      currently assumes same-origin `/api/prefs`; remote rows need their
      prefs keyed by daemon so they don't collide with local.
- [ ] "Add remote daemon" affordance (alongside "add folder") + per-row
      online/offline state. Note: peer discovery in `App.svelte:386` is
      session-share messaging, not repo browsing — not reusable here.

Rough size: ~1.5–2 days. The proxy design moves the hard part off the
browser (no CORS/TLS) and onto ordinary, testable daemon code; the
remaining UI cost is real but mechanical (the `apiUrl` threading).

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
