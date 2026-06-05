#!/usr/bin/env bash
#
# supergit remote-daemon installer (systemd path).
#
# Run ON THE REMOTE BOX (Hetzner/Debian/Ubuntu) as root. Sets up the
# daemon as a loopback-only systemd service and mints a forward-only SSH
# key whose ONLY capability is tunnelling to the daemon — it cannot get a
# shell or forward anywhere else. Prints the private key + the exact
# `ssh -L` line to paste on your laptop.
#
#   curl -fsSL https://raw.githubusercontent.com/marwie/supergit/main/deploy/install.sh | bash
#
# or, from a checkout on the box:  bash deploy/install.sh
#
# --no-pull: use the code already in APP_DIR (e.g. rsync'd from your
# laptop) and skip git fetch/clone entirely. The quick way to test on a
# box without pushing the (private) repo:
#   rsync -az --exclude node_modules --exclude 'packages/*/dist' \
#     ./ root@<host>:/opt/supergit/
#   ssh root@<host> 'bash /opt/supergit/deploy/install.sh --no-pull'
#
# Idempotent: re-running upgrades the unit in place and reuses the
# existing workspace + SSH key. Uninstall:  bash deploy/install.sh --uninstall
#
# See plans/PLAN-REMOTE-DAEMON.md for the security rationale (why loopback
# + tunnel instead of exposing the HTTP API).
set -euo pipefail

# ---- config (override via env) ------------------------------------------
PORT="${SUPERGIT_PORT:-7777}"
SERVICE_USER="${SUPERGIT_USER:-supergit}"
APP_DIR="${SUPERGIT_APP_DIR:-/opt/supergit}"
WORKSPACE_DIR="${SUPERGIT_WORKSPACE:-/var/lib/supergit/workspace}"
REPO_URL="${SUPERGIT_REPO_URL:-https://github.com/marwie/supergit}"
REPO_REF="${SUPERGIT_REPO_REF:-main}"
SERVICE_NAME="supergit-daemon"
UNIT_PATH="/etc/systemd/system/${SERVICE_NAME}.service"
KEY_PATH="/root/supergit_tunnel_key"   # private key emitted to the operator

err() { echo "supergit-install: $*" >&2; }
need_root() { [ "$(id -u)" -eq 0 ] || { err "must run as root"; exit 1; }; }

# ---- arg parse ----------------------------------------------------------
# --no-pull: trust the code already in APP_DIR; don't fetch/clone.
NO_PULL=0
for arg in "$@"; do
  case "${arg}" in
    --no-pull) NO_PULL=1 ;;
  esac
done

# ---- uninstall ----------------------------------------------------------
if [ "${1:-}" = "--uninstall" ]; then
  need_root
  systemctl disable --now "${SERVICE_NAME}" 2>/dev/null || true
  rm -f "${UNIT_PATH}"
  systemctl daemon-reload || true
  err "removed service (left ${APP_DIR}, ${WORKSPACE_DIR}, and user '${SERVICE_USER}' intact)"
  err "to fully purge: userdel -r ${SERVICE_USER}; rm -rf ${APP_DIR} ${WORKSPACE_DIR}"
  exit 0
fi

need_root

# ---- 0. base dependencies ----------------------------------------------
# A fresh minimal Debian/Ubuntu box ships without these. bun's installer
# unzips its release, so without `unzip` (and curl to fetch it) step 1 dies
# with "error: unzip is required to install bun". `git` is only needed for a
# non --no-pull clone, but it's cheap to ensure. Idempotent: only the
# missing ones are installed; apt-only, like the Go step below.
if command -v apt-get >/dev/null 2>&1; then
  NEED=""
  for dep in curl unzip git; do
    command -v "${dep}" >/dev/null 2>&1 || NEED="${NEED} ${dep}"
  done
  if [ -n "${NEED}" ]; then
    err "installing base dependencies:${NEED}…"
    apt-get update -qq && apt-get install -y ${NEED} >/dev/null
  fi
fi

# ---- 1. bun (system-wide) ----------------------------------------------
# Must live somewhere the SERVICE_USER can execute — the default
# `curl|bash` installs to the invoking user's ~/.bun (here /root/.bun),
# which 'supergit' can't reach. Install to a shared prefix instead.
#
# CRUCIAL: BUN_INSTALL must be set for `bash` (the installer reads it), NOT
# for `curl`. `BUN_INSTALL=… curl | bash` applies the var to curl only, so
# bun lands in /root/.bun and the check below fails ("bun not found at
# /usr/local/bin/bun"). Set it on the bash side of the pipe instead.
BUN_INSTALL="/usr/local"
if [ ! -x "${BUN_INSTALL}/bin/bun" ]; then
  err "installing bun → ${BUN_INSTALL}/bin…"
  curl -fsSL https://bun.sh/install | BUN_INSTALL="${BUN_INSTALL}" bash
fi
BUN_BIN="${BUN_INSTALL}/bin/bun"
[ -x "${BUN_BIN}" ] || { err "bun not found at ${BUN_BIN} after install"; exit 1; }

# ---- 2. service user ----------------------------------------------------
if ! id "${SERVICE_USER}" >/dev/null 2>&1; then
  err "creating service user '${SERVICE_USER}'…"
  useradd --system --create-home --shell /usr/sbin/nologin "${SERVICE_USER}"
fi

# ---- 3. code (prebuilt-on-Linux: clone + build the SPA here) ------------
# The macOS artifact pipeline can't produce a server bundle, so we build
# the SPA on the box. node-pty etc. compile against this Linux.
if [ "${NO_PULL}" -eq 1 ]; then
  # Use whatever's already in APP_DIR (rsync'd / scp'd from the laptop).
  # No GitHub needed — the quick-test path for a private, unpushed repo.
  [ -d "${APP_DIR}" ] && [ -f "${APP_DIR}/package.json" ] || {
    err "--no-pull set but no code at ${APP_DIR} (expected package.json)."
    err "copy the repo there first, e.g.:"
    err "  rsync -az --exclude node_modules --exclude 'packages/*/dist' ./ root@<host>:${APP_DIR}/"
    exit 1
  }
  err "--no-pull: using existing code in ${APP_DIR} (skipping fetch/clone)…"
elif [ -d "${APP_DIR}/.git" ]; then
  err "updating existing checkout in ${APP_DIR}…"
  git -C "${APP_DIR}" fetch --depth 1 origin "${REPO_REF}"
  git -C "${APP_DIR}" checkout -f FETCH_HEAD
else
  err "cloning ${REPO_URL}@${REPO_REF} → ${APP_DIR}…"
  git clone --depth 1 --branch "${REPO_REF}" "${REPO_URL}" "${APP_DIR}"
fi
( cd "${APP_DIR}" && "${BUN_BIN}" install )
( cd "${APP_DIR}/packages/ui" && "${BUN_BIN}" run build )

# ---- 3b. PTY helper (Go) — REQUIRED for working terminals -------------
# The daemon spawns PTYs via a prebuilt Go `pty-helper` (no Node, no native
# node-pty module). Without it the backend falls back to `node helper.mjs`,
# which needs `node` on PATH AND node-pty's Linux native binary — neither of
# which a fresh box / `bun install` reliably provides (node-pty ships no
# linux prebuild here, and there's no `node`). The result is every terminal
# SIGHUP'ing on spawn. So build the Go helper on the box. The daemon looks
# for it at packages/daemon/src/terminals/helper-go/pty-helper
# (node-pty-backend.ts helperCmd()).
HELPER_DIR="${APP_DIR}/packages/daemon/src/terminals/helper-go"
HELPER_BIN="${HELPER_DIR}/pty-helper"
if [ ! -x "${HELPER_BIN}" ]; then
  if ! command -v go >/dev/null 2>&1; then
    err "installing Go (needed to build the PTY helper)…"
    # Debian/Ubuntu: golang-go is recent enough for modern go.mod; if the
    # distro's Go is too old, the build error below tells the operator to
    # install a newer Go from go.dev.
    if command -v apt-get >/dev/null 2>&1; then
      apt-get update -qq && apt-get install -y golang-go >/dev/null
    fi
  fi
  if command -v go >/dev/null 2>&1; then
    err "building pty-helper (Go)…"
    ( cd "${HELPER_DIR}" && go build -o "${HELPER_BIN}" . ) || {
      err "go build failed — terminals will not work. Install a newer Go"
      err "from https://go.dev/dl/ and re-run: bash deploy/install.sh --no-pull"
    }
    chmod +x "${HELPER_BIN}" 2>/dev/null || true
  else
    err "WARNING: Go not available and pty-helper not built — terminals"
    err "will fail. Install Go, then re-run the installer."
  fi
fi

mkdir -p "${WORKSPACE_DIR}"
chown -R "${SERVICE_USER}:${SERVICE_USER}" "${APP_DIR}" "${WORKSPACE_DIR}"

# ---- 4. systemd unit (loopback-only) ------------------------------------
err "installing ${UNIT_PATH}…"
sed \
  -e "s#@SERVICE_USER@#${SERVICE_USER}#g" \
  -e "s#@APP_DIR@#${APP_DIR}#g" \
  -e "s#@WORKSPACE_DIR@#${WORKSPACE_DIR}#g" \
  -e "s#@PORT@#${PORT}#g" \
  -e "s#@BUN_BIN@#${BUN_BIN}#g" \
  "${APP_DIR}/deploy/supergit-daemon.service" > "${UNIT_PATH}"
systemctl daemon-reload
systemctl enable "${SERVICE_NAME}"
# `enable --now` only START s a stopped unit — on a re-run (upgrade) the
# service is already running the OLD code, so we must explicitly restart to
# pick up the freshly-built SPA + daemon. restart starts it if stopped too.
systemctl restart "${SERVICE_NAME}"

# ---- 5. forward-only SSH key -------------------------------------------
# The key can ONLY local-forward to 127.0.0.1:<port>. `restrict` disables
# everything (shell, agent/X11, PTY, all forwarding); we then re-enable
# just port-forwarding and pin the single allowed destination with
# permitopen. The forced command is belt-and-braces (with `ssh -N` no
# command runs, but if someone drops -N they get this message, not a shell).
if [ ! -f "${KEY_PATH}" ]; then
  err "generating forward-only SSH key…"
  ssh-keygen -t ed25519 -N "" -C "supergit-tunnel" -f "${KEY_PATH}" >/dev/null
fi
PUBKEY="$(cat "${KEY_PATH}.pub")"
AUTH="/home/${SERVICE_USER}/.ssh/authorized_keys"
RESTRICT="restrict,port-forwarding,permitopen=\"127.0.0.1:${PORT}\",command=\"echo 'supergit: this key is for port-forwarding only'\""
install -d -m 700 -o "${SERVICE_USER}" -g "${SERVICE_USER}" "/home/${SERVICE_USER}/.ssh"
# Replace any prior supergit-tunnel line, then append the current one.
touch "${AUTH}"
grep -v "supergit-tunnel" "${AUTH}" > "${AUTH}.tmp" 2>/dev/null || true
mv "${AUTH}.tmp" "${AUTH}"
echo "${RESTRICT} ${PUBKEY}" >> "${AUTH}"
chown "${SERVICE_USER}:${SERVICE_USER}" "${AUTH}"
chmod 600 "${AUTH}"

# ---- 6. tell the operator how to connect --------------------------------
HOST_HINT="$(hostname -I 2>/dev/null | awk '{print $1}')"
[ -n "${HOST_HINT}" ] || HOST_HINT="<host>"

# --- connection string (one-paste onboarding) ----------------------------
# supergit1:<base64url(JSON)> — matches packages/daemon/src/connection-string.ts.
CONN_HOST="${HOST_HINT}"
# JSON-string-escape the private key (newlines → \n).  Try jq first (most
# servers have it), then python3.  If neither is available, skip the key
# and note that the user must supply it manually — do NOT emit a broken token.
if command -v jq >/dev/null 2>&1; then
  CONN_KEY_JSON="$(jq -Rs . < "${KEY_PATH}")"
elif command -v python3 >/dev/null 2>&1; then
  CONN_KEY_JSON="$(python3 -c 'import json,sys;print(json.dumps(sys.stdin.read()))' < "${KEY_PATH}")"
else
  CONN_KEY_JSON=""
fi

if [ -n "${CONN_KEY_JSON}" ]; then
  CONN_JSON=$(printf '{"host":"%s","port":%s,"user":"%s","label":"%s","privateKey":%s}' \
    "${CONN_HOST}" "${PORT}" "${SERVICE_USER}" "$(hostname)" "${CONN_KEY_JSON}")
else
  CONN_JSON=$(printf '{"host":"%s","port":%s,"user":"%s","label":"%s"}' \
    "${CONN_HOST}" "${PORT}" "${SERVICE_USER}" "$(hostname)")
fi

# base64url: standard base64, then +/ -> -_ and strip = padding, newlines removed.
CONN_B64=$(printf '%s' "${CONN_JSON}" | base64 -w0 2>/dev/null || printf '%s' "${CONN_JSON}" | base64 | tr -d '\n')
CONN_B64=$(printf '%s' "${CONN_B64}" | tr '+/' '-_' | tr -d '=')
CONN_STRING="supergit1:${CONN_B64}"

cat <<EOF

==========================================================================
 supergit remote daemon is up (loopback-only) on ${SERVICE_NAME}.
 It is NOT reachable from the network — only via the tunnel below.

 EASIEST — paste this ONE connection string into supergit →
 "Add remote daemon" → "Paste connection string":

     ${CONN_STRING}

 (It carries the host, user, port, and the forward-only key. Treat it as
  a secret. Or use the manual steps below.)

 1) Save this private key on your LAPTOP as ~/.ssh/supergit_tunnel_key:
$(sed 's/^/      /' "${KEY_PATH}")

 2) chmod 600 ~/.ssh/supergit_tunnel_key

 3) Open the tunnel, then browse:
      ssh -N -L ${PORT}:127.0.0.1:${PORT} ${SERVICE_USER}@${HOST_HINT} -i ~/.ssh/supergit_tunnel_key
      open http://localhost:${PORT}

 Service:   systemctl status ${SERVICE_NAME}
 Logs:      journalctl -u ${SERVICE_NAME} -f
 Uninstall: bash ${APP_DIR}/deploy/install.sh --uninstall

 Troubleshooting — run THESE ON THE BOX to check the daemon itself
 (isolates "is the remote daemon healthy" from "is the tunnel OK"):
      curl -s http://127.0.0.1:${PORT}/api/health   | head -c 400; echo
      curl -s http://127.0.0.1:${PORT}/api/diagnose | head -c 800; echo
 On your LAPTOP, once a remote is added, the LOCAL daemon's diagnose
 reports tunnel + reachability for every remote (run against your local
 supergit port, e.g. 27787):
      curl -s http://127.0.0.1:27787/api/diagnose
==========================================================================
EOF
