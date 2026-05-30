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

# ---- 1. bun (system-wide) ----------------------------------------------
# Must live somewhere the SERVICE_USER can execute — the default
# `curl|bash` installs to the invoking user's ~/.bun (here /root/.bun),
# which 'supergit' can't reach. Install to a shared prefix instead.
BUN_INSTALL="/usr/local"
if [ ! -x "${BUN_INSTALL}/bin/bun" ]; then
  err "installing bun → ${BUN_INSTALL}/bin…"
  BUN_INSTALL="${BUN_INSTALL}" curl -fsSL https://bun.sh/install | bash >/dev/null
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
if [ -d "${APP_DIR}/.git" ]; then
  err "updating existing checkout in ${APP_DIR}…"
  git -C "${APP_DIR}" fetch --depth 1 origin "${REPO_REF}"
  git -C "${APP_DIR}" checkout -f FETCH_HEAD
else
  err "cloning ${REPO_URL}@${REPO_REF} → ${APP_DIR}…"
  git clone --depth 1 --branch "${REPO_REF}" "${REPO_URL}" "${APP_DIR}"
fi
( cd "${APP_DIR}" && "${BUN_BIN}" install )
( cd "${APP_DIR}/packages/ui" && "${BUN_BIN}" run build )

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
systemctl enable --now "${SERVICE_NAME}"

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
cat <<EOF

==========================================================================
 supergit remote daemon is up (loopback-only) on ${SERVICE_NAME}.
 It is NOT reachable from the network — only via the tunnel below.

 1) Save this private key on your LAPTOP as ~/.ssh/supergit_tunnel_key:
$(sed 's/^/      /' "${KEY_PATH}")

 2) chmod 600 ~/.ssh/supergit_tunnel_key

 3) Open the tunnel, then browse:
      ssh -N -L ${PORT}:localhost:${PORT} ${SERVICE_USER}@${HOST_HINT} -i ~/.ssh/supergit_tunnel_key
      open http://localhost:${PORT}

 Service:   systemctl status ${SERVICE_NAME}
 Logs:      journalctl -u ${SERVICE_NAME} -f
 Uninstall: bash ${APP_DIR}/deploy/install.sh --uninstall
==========================================================================
EOF
