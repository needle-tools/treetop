<#
.SYNOPSIS
  supergit remote-daemon installer for Windows (Scheduled Task path).

.DESCRIPTION
  Windows port of deploy/install.sh. Run ON THE REMOTE WINDOWS BOX as an
  Administrator. Sets up the daemon as a loopback-only Scheduled Task that
  survives reboot and logoff, and mints a forward-only SSH key whose ONLY
  capability is tunnelling to the daemon - it cannot get a shell or forward
  anywhere else. Prints the private key + the exact `ssh -L` line and the
  one-paste `supergit1:` connection token.

  This script is invoked by the provisioning code after it extracts the
  source archive:
    powershell -NoProfile -ExecutionPolicy Bypass -File C:\supergit\deploy\install.ps1 -NoPull

  Or manually, from a checkout on the box:
    powershell -NoProfile -ExecutionPolicy Bypass -File deploy\install.ps1

  -NoPull : use the code already in APP_DIR (e.g. uploaded by the provisioning
            ssh + tar step) and skip git clone/fetch entirely. This is the
            standard path - the provisioning flow ships the source first, then
            calls install.ps1 -NoPull.

  -Uninstall : remove the Scheduled Task (leaves APP_DIR, workspace, and SSH
               key intact - purge those manually).

  Idempotent: re-running upgrades the task in place and reuses the existing
  workspace + SSH key.

  See plans/PLAN-REMOTE-DAEMON.md for the security rationale (why loopback +
  tunnel instead of exposing the HTTP API).

.NOTES
  ============================================================================
  IMPORTANT - NOT YET RUN END-TO-END ON A REAL WINDOWS HOST
  ============================================================================
  This script was written by examining install.sh, the daemon source, and
  Windows documentation. It has NOT been executed on a live Windows machine.
  Before trusting it in production, verify the following on a real Windows box:

    1. OpenSSH Server is installed and the sshd service is running.
       (Settings -> Apps -> Optional Features -> OpenSSH Server, or
        Add-WindowsCapability -Online -Name OpenSSH.Server~~~~0.0.1.0)

    2. The icacls ACL restrictions on authorized_keys are actually accepted by
       the sshd that ships with Windows - the exact icacls incantation needs
       confirmation. The ProgramData path for Administrators group members also
       needs verifying.

    3. The Scheduled Task actually launches the daemon loopback-only (verify
       with `netstat -an | findstr 7777` after the task starts - you should
       see 127.0.0.1:7777 but NOT 0.0.0.0:7777).

    4. tar.exe (bundled with Windows 10 1803+) correctly extracts the gzip
       archive the provisioning flow pipes in. If not present, bsdtar from
       Git-for-Windows works as a drop-in.

    5. The Scheduled Task principal runs as SYSTEM or as the intended user
       and that user has write access to the workspace directory.

    6. The `supergit1:` connection token round-trips through the daemon's
       decodeConnectionString - paste it into the local supergit UI to confirm.

    7. The winget Go installation path (if triggered) is on the PATH for the
       Scheduled Task's environment, not just the interactive session.
  ============================================================================
#>

[CmdletBinding()]
param(
  # Skip git clone/fetch - trust code already present at APP_DIR.
  [switch]$NoPull,

  # Remove the Scheduled Task (leaves files intact).
  [switch]$Uninstall
)

# PowerShell equivalent of `set -euo pipefail`:
#   Set-StrictMode catches uses of undeclared variables and bad property access.
#   $ErrorActionPreference = 'Stop' causes every non-terminating error (Write-Error,
#   failed external commands, etc.) to throw and halt the script - same as `set -e`.
Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'

# ---- config (override via env) -------------------------------------------
# These mirror install.sh's config block exactly. The env vars are the same
# so tooling that sets them for the Linux path works on Windows unchanged.
$PORT      = if ($env:SUPERGIT_PORT)      { [int]$env:SUPERGIT_PORT }      else { 7777 }
$APP_DIR   = if ($env:SUPERGIT_APP_DIR)   { $env:SUPERGIT_APP_DIR }        else { 'C:\supergit' }
$WORKSPACE = if ($env:SUPERGIT_WORKSPACE) { $env:SUPERGIT_WORKSPACE }      else { 'C:\ProgramData\supergit\workspace' }
$REPO_URL  = if ($env:SUPERGIT_REPO_URL)  { $env:SUPERGIT_REPO_URL }       else { 'https://github.com/marwie/supergit' }
$REPO_REF  = if ($env:SUPERGIT_REPO_REF)  { $env:SUPERGIT_REPO_REF }       else { 'main' }

# Windows OpenSSH stores the tunnel key under ProgramData (admin-shared path)
# because we run as an Administrator-class session, not a dedicated service
# user (see section 5 below for why).
$KEY_PATH   = 'C:\ProgramData\supergit\supergit_tunnel_key'
$TASK_NAME  = 'supergit-daemon'

# ---- helpers ---------------------------------------------------------------
function Err([string]$msg) {
  # Mirror install.sh's `err()` - writes to stderr with a prefix.
  Write-Host "supergit-install: $msg" -ForegroundColor Red
}

function NeedAdmin {
  $id = [Security.Principal.WindowsIdentity]::GetCurrent()
  $p  = [Security.Principal.WindowsPrincipal]$id
  if (-not $p.IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)) {
    Err "must run as Administrator (right-click PowerShell -> 'Run as administrator')"
    exit 1
  }
}

# ---- uninstall -------------------------------------------------------------
if ($Uninstall) {
  NeedAdmin
  # Unregister removes the task from the scheduler. -Confirm:$false skips the
  # interactive y/n prompt so the script is non-interactive, like install.sh.
  $task = Get-ScheduledTask -TaskName $TASK_NAME -ErrorAction SilentlyContinue
  if ($task) {
    Stop-ScheduledTask  -TaskName $TASK_NAME -ErrorAction SilentlyContinue
    Unregister-ScheduledTask -TaskName $TASK_NAME -Confirm:$false
    Err "removed Scheduled Task '$TASK_NAME'"
  } else {
    Err "task '$TASK_NAME' not found - nothing to remove"
  }
  Err "(left $APP_DIR, $WORKSPACE, and key $KEY_PATH intact)"
  Err "To fully purge: Remove-Item -Recurse $APP_DIR; Remove-Item -Recurse $WORKSPACE; Remove-Item $KEY_PATH*"
  exit 0
}

NeedAdmin

# ---- 1. bun ----------------------------------------------------------------
# On Linux install.sh installs bun system-wide (/usr/local/bin) so the
# service user can reach it. On Windows there is no meaningful "system-wide"
# bun install path; the official Windows installer always drops bun into the
# CURRENT user's %USERPROFILE%\.bun\bin\bun.exe.
#
# For the Scheduled Task we therefore run it as the SAME user that ran this
# installer (captured in $TASK_USER below), so the Task inherits that user's
# PATH (including %USERPROFILE%\.bun\bin) and can find bun.exe. This replaces
# install.sh's "install bun to /usr/local" + separate service-user pattern -
# there is no `useradd` equivalent we need here.
$BUN_BIN = "$env:USERPROFILE\.bun\bin\bun.exe"
if (-not (Test-Path $BUN_BIN)) {
  Err "installing bun -> $BUN_BIN ..."
  # The official bun Windows installer. This is the Windows equivalent of
  # `BUN_INSTALL=/usr/local curl -fsSL https://bun.sh/install | bash`.
  # irm = Invoke-RestMethod (downloads the script); iex = Invoke-Expression
  # (executes it). Same idiom bun.sh recommends on their docs.
  & powershell -NoProfile -ExecutionPolicy Bypass -Command "irm bun.sh/install.ps1 | iex"
  # Refresh PATH in this session so the next Test-Path sees the new binary.
  $env:PATH = "$env:USERPROFILE\.bun\bin;$env:PATH"
}
if (-not (Test-Path $BUN_BIN)) {
  Err "bun not found at $BUN_BIN after install - aborting"
  exit 1
}
Err "bun found at $BUN_BIN"

# ---- 2. code ---------------------------------------------------------------
# Mirror install.sh section 3: clone, fetch-and-checkout, or trust existing.
if ($NoPull) {
  # The provisioning flow ships the source via `ssh + tar -x` BEFORE running
  # this script with -NoPull. So APP_DIR should already be populated.
  if (-not (Test-Path (Join-Path $APP_DIR 'package.json'))) {
    Err "-NoPull set but no code at $APP_DIR (expected package.json)."
    Err "The source archive must be extracted there first. The provisioning"
    Err "flow does this automatically; if running manually:"
    Err "  scp / robocopy the repo to $APP_DIR"
    exit 1
  }
  Err "-NoPull: using existing code in $APP_DIR (skipping fetch/clone)..."
} elseif (Test-Path (Join-Path $APP_DIR '.git')) {
  Err "updating existing checkout in $APP_DIR..."
  # `git -C` changes directory just for that invocation - same as `git -C` in bash.
  git -C $APP_DIR fetch --depth 1 origin $REPO_REF
  git -C $APP_DIR checkout -f FETCH_HEAD
} else {
  Err "cloning $REPO_URL@$REPO_REF -> $APP_DIR..."
  git clone --depth 1 --branch $REPO_REF $REPO_URL $APP_DIR
}

# ---- 3. bun install + UI build --------------------------------------------
Err "running bun install in $APP_DIR..."
Push-Location $APP_DIR
try {
  & $BUN_BIN install
  Err "building UI (packages/ui)..."
  Push-Location (Join-Path $APP_DIR 'packages\ui')
  try {
    & $BUN_BIN run build
  } finally {
    Pop-Location
  }
} finally {
  Pop-Location
}

# ---- 3b. PTY helper (Go) - REQUIRED for working terminals -----------------
# The daemon spawns PTYs via a prebuilt Go `pty-helper.exe` (no Node, no native
# node-pty module). Without it the backend falls back to `node helper.mjs`,
# which needs `node` on PATH AND node-pty's Windows native binary - neither
# of which a fresh Windows box / `bun install` reliably provides.
# On win32, node-pty-backend.ts helperCmd() looks for `pty-helper.exe` (not
# `pty-helper`) in two places:
#   1. Next to the daemon executable (process.execPath dir) - prod/packaged.
#   2. packages/daemon/src/terminals/helper-go/pty-helper.exe - dev/source.
# We build to location 2 so that running from source works immediately.
$HELPER_DIR = Join-Path $APP_DIR 'packages\daemon\src\terminals\helper-go'
$HELPER_BIN = Join-Path $HELPER_DIR 'pty-helper.exe'   # .exe - NOT pty-helper

if (-not (Test-Path $HELPER_BIN)) {
  # Check if Go is already on PATH.
  $goCmd = Get-Command 'go' -ErrorAction SilentlyContinue
  if (-not $goCmd) {
    Err "Go not found - trying to install via winget (GoLang.Go)..."
    # Best-effort: winget is present on Windows 10 1709+ / Windows 11.
    # If this fails (e.g. headless/Server Core without winget), we warn and
    # continue - the daemon will fall back to helper.mjs which is limited.
    try {
      winget install --id GoLang.Go --silent --accept-package-agreements --accept-source-agreements
      # winget installs Go to C:\Program Files\Go\bin. Refresh PATH.
      $goBinPath = 'C:\Program Files\Go\bin'
      if (Test-Path $goBinPath) {
        $env:PATH = "$goBinPath;$env:PATH"
      }
    } catch {
      Err "winget install failed: $($_.Exception.Message)"
    }
    $goCmd = Get-Command 'go' -ErrorAction SilentlyContinue
  }

  if ($goCmd) {
    Err "building pty-helper.exe (Go) in $HELPER_DIR..."
    Push-Location $HELPER_DIR
    try {
      # `go build -o pty-helper.exe .` compiles the current package into the
      # named output. On Windows the output MUST be pty-helper.exe - without
      # the .exe suffix the Go toolchain produces it anyway, but the daemon's
      # helperCmd() looks for the .exe name explicitly (node-pty-backend.ts
      # line: `process.platform === 'win32' ? 'pty-helper.exe' : 'pty-helper'`).
      & go build -o $HELPER_BIN .
      Err "pty-helper.exe built at $HELPER_BIN"
    } catch {
      Err "go build failed - terminals will not work."
      Err "Install Go from https://go.dev/dl/ and re-run:"
      Err "  powershell -File $($APP_DIR)\deploy\install.ps1 -NoPull"
    } finally {
      Pop-Location
    }
  } else {
    Err "WARNING: Go not available and pty-helper.exe not built - terminals"
    Err "will fail. Install Go from https://go.dev/dl/ then re-run the installer."
  }
} else {
  Err "pty-helper.exe already present at $HELPER_BIN - skipping build"
}

# Ensure workspace directory exists.
New-Item -ItemType Directory -Force -Path $WORKSPACE | Out-Null

# ---- 4. Scheduled Task (loopback-only) ------------------------------------
# Linux uses systemd (a proper init system). Windows has no systemd equivalent
# for services that run as the current user. The closest match is a
# SCHEDULED TASK that triggers "At system startup" - it runs even when no
# user is logged on (unlike user-session startup items) and survives reboot.
#
# Why not SC.exe / New-Service?
#   New-Service requires a Windows Service binary (a process that registers
#   with the Service Control Manager via specific Win32 APIs). A bare
#   `bun run server.ts` is NOT a Windows service binary - it would fail to
#   register and SCM would kill it immediately. A Scheduled Task has no such
#   requirement; it just runs any executable.
#
# Why SYSTEM?
#   Running as SYSTEM means the task always starts at boot regardless of
#   whether any user logs in (important for a headless server NUC). It also
#   avoids the need to store a user password in the task definition, which
#   is a security concern. The trade-off is that SYSTEM's USERPROFILE is
#   C:\Windows\System32\config\systemprofile - so bun.exe must be reachable
#   from there OR we supply the full path (which we do).
#
# Loopback binding:
#   SUPERGIT_BIND=127.0.0.1 tells the daemon to bind only to loopback
#   (server.ts: `const BIND = process.env.SUPERGIT_BIND || "0.0.0.0"`).
#   The SSH tunnel terminates on loopback, so the daemon is still reachable
#   via the tunnel but invisible to every other network interface - same
#   guarantee the systemd unit gives on Linux.

$TASK_USER = 'SYSTEM'   # runs at boot, no login required, no stored password

# Build the environment block. We can't set env vars in a Scheduled Task
# action directly, but we CAN launch a cmd /c wrapper that sets them first.
# PowerShell -Command is cleaner: set-env + invoke bun inline.
#
# We use cmd /c to set the env vars and launch bun - this is because
# Scheduled Tasks on Windows don't have a built-in env-var block that
# persists across restarts without editing the XML directly. cmd /c is the
# standard workaround. The command is intentionally simple (no PS here) so
# it works on Windows Server Core where PS profiles may be minimal.
$UI_DIR  = Join-Path $APP_DIR 'packages\ui\dist'
$DAEMON_ENTRY = Join-Path $APP_DIR 'packages\daemon\src\server.ts'

# Scheduled Task action: the program is cmd.exe; arguments carry the rest.
# Split like this because Register-ScheduledTask wants program + arguments
# separately (the CIM class doesn't accept a combined command line).
# NOTE: NO space before each `&&`. In cmd, `set VAR=value && next` captures
# the trailing space INTO the value (VAR becomes "value "). That silently
# broke SUPERGIT_BIND="127.0.0.1 " -> Bun.serve({hostname}) fails -> the
# daemon never serves -> the tunnel just gets "socket closed". `value&& next`
# keeps the value clean.
$Action  = New-ScheduledTaskAction `
  -Execute 'cmd.exe' `
  -Argument ("/c `"set SUPERGIT_BIND=127.0.0.1&& " +
              "set SUPERGIT_PORT=$PORT&& " +
              "set SUPERGIT_UI_DIR=$UI_DIR&& " +
              "set SUPERGIT_WORKSPACE=$WORKSPACE&& " +
              "`"$BUN_BIN`" run `"$DAEMON_ENTRY`"`"") `
  -WorkingDirectory $APP_DIR

# Trigger: at system startup - equivalent to systemd's [Install] WantedBy=multi-user.target.
# `RepetitionInterval` with `RepetitionDuration` + `Indefinitely = $true` is NOT
# needed for a startup trigger; the task simply runs once at boot and stays alive
# (bun never exits under normal conditions). If the daemon crashes,
# `RestartOnFailure` below re-launches it - mirroring systemd's Restart=on-failure.
$Trigger = New-ScheduledTaskTrigger -AtStartup

# Principal: run as SYSTEM, elevated.
# HighestAvailable ensures UAC doesn't prompt; SYSTEM is always elevated.
$Principal = New-ScheduledTaskPrincipal `
  -UserId $TASK_USER `
  -LogonType ServiceAccount `
  -RunLevel Highest

# Settings: restart on failure (mirrors systemd Restart=on-failure). NOTE:
# Task Scheduler's RestartInterval minimum is 1 MINUTE - anything smaller
# (e.g. 2s) makes Register-ScheduledTask fail with "value out of range"
# (0x80041318, Interval:PT2S). So this is 1 min, not systemd's RestartSec=2.
$Settings = New-ScheduledTaskSettingsSet `
  -StartWhenAvailable `
  -RestartCount 5 `
  -RestartInterval (New-TimeSpan -Minutes 1) `
  -ExecutionTimeLimit ([TimeSpan]::Zero)   # no timeout - daemon runs forever

Err "registering Scheduled Task '$TASK_NAME'..."
# Register-ScheduledTask is idempotent when -Force is supplied:
# it replaces any existing task with the same name rather than erroring.
Register-ScheduledTask `
  -TaskName  $TASK_NAME `
  -Action    $Action `
  -Trigger   $Trigger `
  -Principal $Principal `
  -Settings  $Settings `
  -Force | Out-Null

# (Re)start the task immediately so the daemon is running before we print
# the connection info. `Stop-ScheduledTask` is a no-op if not running.
# This mirrors `systemctl restart` - restarts even if already running so a
# re-run picks up freshly-built code.
Stop-ScheduledTask  -TaskName $TASK_NAME -ErrorAction SilentlyContinue
Start-ScheduledTask -TaskName $TASK_NAME
Err "Scheduled Task '$TASK_NAME' started"

# ---- 5. forward-only SSH key ----------------------------------------------
# The key can ONLY local-forward to 127.0.0.1:<port>. `restrict` disables
# everything (shell, agent/X11, PTY, all forwarding); we then re-enable just
# port-forwarding and pin the single allowed destination with permitopen.
# The forced command is belt-and-braces (with `ssh -N` no command runs, but
# if someone drops -N they get this message, not a shell).
#
# CRITICAL Windows-OpenSSH detail - two authorized_keys locations:
#   For ordinary users: %USERPROFILE%\.ssh\authorized_keys
#     (same as Linux, same icacls restrictions apply)
#   For Administrators-group members: %ProgramData%\ssh\administrators_authorized_keys
#     Windows OpenSSH IGNORES per-user authorized_keys for any user who is a
#     member of the Administrators group - it reads ONLY the ProgramData file
#     instead. This is the sshd_config default:
#       AuthorizedKeysFile __PROGRAMDATA__/ssh/administrators_authorized_keys
#     The user connecting via this tunnel key (the supergit tunnel) will be
#     connecting as the CURRENT USER on this box (Administrator). So we must
#     write to the ProgramData path to be effective.
#
# ACL / icacls requirement:
#   Windows OpenSSH rejects authorized_keys if the file has inherited
#   permissions (i.e., any non-owner, non-SYSTEM entry). We must:
#     1. Disable inheritance and strip inherited entries.
#     2. Grant only SYSTEM + the owner (current user) full control.
#   Without this, sshd logs "bad permissions" and ignores the key entirely.
#   This is equivalent to `chmod 600` on Linux, but Windows uses ACLs.

$KEY_DIR = Split-Path $KEY_PATH
New-Item -ItemType Directory -Force -Path $KEY_DIR | Out-Null

if (-not (Test-Path $KEY_PATH)) {
  Err "generating forward-only SSH key at $KEY_PATH..."
  # -t ed25519 : modern, compact, fast. Same as install.sh.
  # -N ""      : no passphrase (the key is access-controlled by the file ACL
  #              and the authorized_keys restrict options; a passphrase would
  #              prevent unattended tunnel setup).
  # -C supergit-tunnel : comment so the key is identifiable in authorized_keys.
  # Empty passphrase is the tricky part on Windows PowerShell 5.1:
  #   - `-N ""` directly: PS 5.1 drops empty-string args to native commands.
  #   - `--% -N "" ... -f "$KEY_PATH"`: the stop-parsing token passes EVERYTHING
  #     literally, so $KEY_PATH is NOT expanded and the key lands in a file
  #     literally named "$KEY_PATH" (then Get-Content "$KEY_PATH.pub" fails).
  # Route through cmd /c with the path expanded by PowerShell FIRST: cmd treats
  # -N "" as a genuine empty passphrase, and "$KEY_PATH" is a normal expanded
  # PowerShell string. (`-q` keeps ssh-keygen quiet.)
  cmd /c "ssh-keygen -q -t ed25519 -N `"`" -C supergit-tunnel -f `"$KEY_PATH`""
  # On Windows, ssh-keygen may leave the private key with inherited ACLs.
  # Lock it down immediately.
  icacls $KEY_PATH /inheritance:r /grant:r "${env:USERNAME}:(F)" | Out-Null
}

$PUBKEY = Get-Content "$KEY_PATH.pub" -Raw
$PUBKEY = $PUBKEY.Trim()

# The restriction options - identical to install.sh:
#   restrict          : disable everything (shell, pty, agent/X11, all forwarding)
#   port-forwarding   : re-enable only port forwarding
#   permitopen="..."  : pin the single allowed destination (loopback:port)
#   command="..."     : forced command fallback (with -N this never runs, but
#                       belt-and-braces: someone dropping -N gets a message
#                       not a shell)
$RESTRICT = "restrict,port-forwarding,permitopen=`"127.0.0.1:$PORT`",command=`"echo 'supergit: this key is for port-forwarding only'`""

# Decide which authorized_keys file to update.
# As explained above: Administrators group -> ProgramData path.
# Non-admin users -> per-user .ssh path. We default to the ProgramData path
# because we verified above that this script is running as Administrator.
$AUTH_KEYS = "$env:ProgramData\ssh\administrators_authorized_keys"
New-Item -ItemType Directory -Force -Path (Split-Path $AUTH_KEYS) | Out-Null
if (-not (Test-Path $AUTH_KEYS)) {
  # Create empty file so icacls has something to operate on.
  New-Item -ItemType File -Path $AUTH_KEYS -Force | Out-Null
}

# Replace any prior supergit-tunnel line (idempotent re-run), then append
# the current one. Mirrors install.sh's grep -v + mv pattern.
# Coerce to @() so that when the file is empty (Get-Content returns $null)
# or has only supergit-tunnel lines (Where-Object returns nothing), we still
# get an array we can append to - not $null += string (which would error under
# Set-StrictMode -Version Latest).
[string[]]$lines = @(Get-Content $AUTH_KEYS -ErrorAction SilentlyContinue |
                      Where-Object { $_ -notmatch 'supergit-tunnel' })
$newEntry = "$RESTRICT $PUBKEY"
$lines += $newEntry
Set-Content -Path $AUTH_KEYS -Value $lines -Encoding UTF8

# Lock down the ACL on authorized_keys. Windows OpenSSH REQUIRES:
#   - No inherited permissions (sshd treats inherited entries as "too open").
#   - Only SYSTEM and the file owner have access.
# `icacls /inheritance:r` removes inherited entries.
# `icacls /grant:r SYSTEM:(F)` grants SYSTEM full control (read-only would
# suffice for sshd, but F is the conventional minimal grant for system files).
# `icacls /grant:r <user>:(F)` grants the owning admin account full control
# so we can edit it on re-runs.
#
# Note: the `administrators_authorized_keys` file is SYSTEM-owned by default
# on fresh Windows installs; the icacls here is belt-and-braces to ensure
# it stays correct even if something else touched it.
icacls $AUTH_KEYS /inheritance:r /grant:r "SYSTEM:(F)" /grant:r "${env:USERNAME}:(F)" | Out-Null
Err "authorized_keys updated at $AUTH_KEYS"

# ---- 6. connection token + human banner -----------------------------------
# Determine the box's primary IP address (best-guess outbound interface).
# `Get-NetIPAddress` lists all addresses; we filter for IPv4, skip loopback
# and link-local (169.254.*), and take the first. Falls back to hostname.
$HOST_HINT = try {
  $ip = Get-NetIPAddress -AddressFamily IPv4 -ErrorAction SilentlyContinue |
        Where-Object { $_.IPAddress -notmatch '^127\.' -and $_.IPAddress -notmatch '^169\.254\.' } |
        Sort-Object InterfaceMetric |
        Select-Object -First 1 -ExpandProperty IPAddress
  # `hostname` is an external command; call it with & and .Trim() to get a
  # plain string (not an array), matching bash's $(hostname -I ... | awk ...) pattern.
  if ($ip) { $ip } else { (& hostname).Trim() }
} catch { (& hostname).Trim() }

# ---- build the supergit1: connection token ---------------------------------
# Format: supergit1:<base64url(JSON)>
# JSON shape matches packages/daemon/src/connection-string.ts ConnectionPayload:
#   { host, port, user, label, privateKey }
# Field names must be EXACT - decodeConnectionString() checks them by name.
#
# We use ConvertTo-Json on a hashtable, then strip the outer {} and
# reconstruct - actually: ConvertTo-Json on the full object is easiest
# and handles all JSON-string escaping (newlines -> \n, quotes -> \", etc.)
# automatically. This is what install.sh does with jq.
$PRIVATE_KEY_TEXT = Get-Content $KEY_PATH -Raw

# ConvertTo-Json produces valid JSON with proper escaping. We build the
# payload as a PowerShell hashtable so key order and types are controlled.
# Note: port is numeric (not a string) to match the TypeScript interface.
# Capture hostname once (it's an external command; calling it inside a
# hashtable literal would produce an array of string lines, not a string).
$BOX_LABEL = (hostname).Trim()

$payload = [ordered]@{
  host       = $HOST_HINT
  port       = $PORT              # number, matches ConnectionPayload.port: number
  user       = $env:USERNAME      # the admin user who will own the tunnel
  label      = $BOX_LABEL        # human-friendly name, same as install.sh's $(hostname)
  privateKey = $PRIVATE_KEY_TEXT  # full PEM text; ConvertTo-Json escapes newlines
}

# ConvertTo-Json with -Compress omits whitespace (compact one-liner).
# -Depth 1 is sufficient (no nested objects).
$CONN_JSON = $payload | ConvertTo-Json -Compress -Depth 1

# base64url encoding:
#   1. UTF-8 encode the JSON string to bytes.
#   2. Standard base64 of those bytes.
#   3. Replace + with -, / with _, strip = padding.
# This is the EXACT transform in connection-string.ts toBase64Url():
#   btoa(unescape(encodeURIComponent(s))).replace(+,-).replace(/,_).replace(=,"")
# PowerShell's [Convert]::ToBase64String takes bytes directly, which
# is equivalent to btoa() on a UTF-8 encoded string.
$JSON_BYTES = [System.Text.Encoding]::UTF8.GetBytes($CONN_JSON)
$B64        = [Convert]::ToBase64String($JSON_BYTES)
$B64URL     = $B64.Replace('+','-').Replace('/','_').TrimEnd('=')
$CONN_STRING = "supergit1:$B64URL"

# Emit the machine-readable SUPERGIT_CONNECT marker line FIRST.
# provision.ts extractConnectionToken() prefers this line over the bare
# token that appears in the human banner below - it is more robust to
# regex scanning because it is a dedicated marker, not embedded in prose.
Write-Output "SUPERGIT_CONNECT=$CONN_STRING"

Write-Host ""
Write-Host "=========================================================================="
Write-Host " supergit remote daemon is up (loopback-only) as Scheduled Task '$TASK_NAME'."
Write-Host " It is NOT reachable from the network - only via the tunnel below."
Write-Host ""
Write-Host " EASIEST - paste this ONE connection string into supergit ->"
Write-Host " `"Add remote daemon`" -> `"Paste connection string`":"
Write-Host ""
Write-Host "     $CONN_STRING"
Write-Host ""
Write-Host " (It carries the host, user, port, and the forward-only key. Treat it as"
Write-Host "  a secret. Or use the manual steps below.)"
Write-Host ""
Write-Host " 1) Save this private key on your LAPTOP as ~/.ssh/supergit_tunnel_key:"
Get-Content $KEY_PATH | ForEach-Object { Write-Host "      $_" }
Write-Host ""
Write-Host " 2) chmod 600 ~/.ssh/supergit_tunnel_key   (on Linux/macOS)"
Write-Host "    icacls supergit_tunnel_key /inheritance:r /grant:r `"${env:USERNAME}:(F)`"  (on Windows laptop)"
Write-Host ""
Write-Host " 3) Open the tunnel, then browse:"
Write-Host "      ssh -N -L ${PORT}:127.0.0.1:${PORT} ${env:USERNAME}@${HOST_HINT} -i ~/.ssh/supergit_tunnel_key"
Write-Host "      open http://localhost:$PORT"
Write-Host ""
Write-Host " Task:     Get-ScheduledTask -TaskName $TASK_NAME"
Write-Host " Logs:     Get-WinEvent -LogName 'Microsoft-Windows-TaskScheduler/Operational' |"
Write-Host "              Where-Object Message -match $TASK_NAME | Select-Object -First 20"
Write-Host " Uninstall: powershell -File $APP_DIR\deploy\install.ps1 -Uninstall"
Write-Host ""
Write-Host " Troubleshooting - run THESE ON THE BOX to check the daemon itself"
Write-Host " (isolates 'is the remote daemon healthy' from 'is the tunnel OK'):"
Write-Host "      Invoke-RestMethod http://127.0.0.1:$PORT/api/health"
Write-Host "      Invoke-RestMethod http://127.0.0.1:$PORT/api/diagnose"
Write-Host " On your LAPTOP, once a remote is added, the LOCAL daemon's diagnose"
Write-Host " reports tunnel + reachability for every remote:"
Write-Host "      curl -s http://127.0.0.1:27787/api/diagnose"
Write-Host "=========================================================================="
