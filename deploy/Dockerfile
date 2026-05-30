# supergit remote daemon — Linux server image.
#
# This image IS the "prebuilt Linux artifact": the macOS .app pipeline
# (scripts/build-native.ts → electrobun) produces desktop bundles that do
# not run on a server, and the daemon has native deps (node-pty, ssh2,
# bonjour-service) whose prebuilds are per-platform — so a server build
# must be assembled on Linux. Building inside this image guarantees that.
#
# Security posture: run this image with host networking
# (`network_mode: host` / `--network host`) and SUPERGIT_BIND=127.0.0.1,
# so the daemon listens only on the host's loopback — reachable via the
# SSH tunnel, invisible to every other interface. Do NOT use bridge +
# `-p 127.0.0.1:<port>`: Docker's port-proxy rewrites the request source
# to the bridge gateway, which the daemon's origin-based auth treats as
# "remote" and 403s (verified 2026-05-30). See deploy/docker-compose.yml
# and plans/PLAN-REMOTE-DAEMON.md for the full rationale.

# Pin to the same Bun the repo expects (package.json engines/packageManager).
FROM oven/bun:1.3.14 AS build

# node-pty builds a native addon → needs python3 + a C++ toolchain.
RUN apt-get update \
  && apt-get install -y --no-install-recommends python3 make g++ \
  && rm -rf /var/lib/apt/lists/*

WORKDIR /app

# Install deps first for layer caching. Copy the manifests across the
# workspace so `bun install` resolves the workspaces.
COPY package.json bun.lock* ./
COPY packages/daemon/package.json packages/daemon/
COPY packages/ui/package.json packages/ui/
RUN bun install --frozen-lockfile || bun install

# Now the sources, then build the SPA the daemon serves in prod.
COPY . .
RUN cd packages/ui && bun run build

# ---- runtime image -------------------------------------------------------
FROM oven/bun:1.3.14 AS runtime

# git is required at runtime (the daemon shells out to it for worktrees,
# status, diff). The base image does not include it.
RUN apt-get update \
  && apt-get install -y --no-install-recommends git openssh-client \
  && rm -rf /var/lib/apt/lists/*

WORKDIR /app
COPY --from=build /app /app

# Default port; override with -e SUPERGIT_PORT=…
ENV SUPERGIT_PORT=7777
# Serve the built SPA (prod posture: same-origin /api + static UI).
ENV SUPERGIT_UI_DIR=/app/packages/ui/dist
# Workspace lives on a volume so repos/events/prefs survive image upgrades.
ENV SUPERGIT_WORKSPACE=/workspace
VOLUME ["/workspace"]

EXPOSE 7777
# NB: no SUPERGIT_BIND baked in — set SUPERGIT_BIND=127.0.0.1 at run time
# together with host networking (see header + docker-compose.yml). The
# default 0.0.0.0 is kept so the image is still usable for non-tunnel
# experiments, but production runs loopback-only via host networking.
CMD ["bun", "run", "packages/daemon/src/server.ts"]
