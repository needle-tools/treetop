import { defineConfig, type Plugin } from "vite";
import { svelte } from "@sveltejs/vite-plugin-svelte";
import { fileURLToPath } from "node:url";
import { PRODUCT_NAME } from "../../product";
import nativeConfig from "../../electrobun.config";

// Captured once per frontend build, rather than once per page request.
const frontendBuildTime = new Date().toISOString().replace("T", " ").replace(/\.\d{3}Z$/, " UTC");

function envFlag(value: string | undefined): boolean {
  if (value === undefined) return false;
  const normalized = value.trim().toLowerCase();
  return normalized === "1" || normalized === "true" || normalized === "yes";
}

export function replayLabDevRoutePlugin(standalone = false): Plugin {
  return {
    name: "replay-lab-dev-route",
    configureServer(server) {
      server.middlewares.use((req, _res, next) => {
        const url = req.url ?? "";
        const match = /^\/(?:replay-lab|codex-replay)\/?([?#].*)?$/.exec(url)
          ?? (standalone ? /^\/(?:index\.html)?([?#].*)?$/.exec(url) : null);
        if (match) req.url = `/replay-lab.html${match[1] ?? ""}`;
        next();
      });
    },
  };
}

export default defineConfig(({ mode, command }) => ({
  base: mode === "replay-lab-static" ? "./" : undefined,
  resolve: {
    alias: {
      "@treetop/nicifier": fileURLToPath(
        new URL("../nicifier/src/index.ts", import.meta.url),
      ),
    },
  },
  plugins: [
    svelte(),
    // Inject the product name into index.html's <title> from the shared
    // product module, so the static HTML isn't a second source of truth.
    {
      name: "product-title",
      transformIndexHtml(html) {
        const build = command === "serve" ? "Development" : frontendBuildTime;
        return html
          .replace(/%PRODUCT_NAME%/g, PRODUCT_NAME)
          .replace(/%SPLASH_BUILD%/g, `v${nativeConfig.app.version} · ${build}`);
      },
    },
    replayLabDevRoutePlugin(mode === "replay-lab-static"),
  ],
  server: {
    // 7779 sits next to the daemon's 7777 so supergit's two ports cluster
    // together, and avoids the very common 5173 clash with other Vite
    // dev servers we might have running in parallel. PORT env wins if
    // set for the rare case someone wants a different port without
    // editing this file.
    port: process.env.PORT ? Number(process.env.PORT) : 7779,
    // Bind to all interfaces by default so other machines on the LAN
    // can hit the dev UI (matches the daemon, which listens on
    // 0.0.0.0 for session-share). HOST env still wins if set, so
    // `HOST=localhost bun dev` recovers the old behaviour.
    host: process.env.HOST ?? "0.0.0.0",
    strictPort: true,
    proxy:
      mode === "replay-lab-static"
        ? {}
        : {
            "/api": {
              // Daemon port follows SUPERGIT_PORT (the same env the daemon
              // itself reads). dev.ts passes the resolved dev-daemon port
              // (default 7777, overridable via SUPERGIT_DEV_PORT) through to
              // the Vite child so the two stay in lockstep when the user runs
              // a second worktree on a different port set.
              target: `http://localhost:${process.env.SUPERGIT_PORT ?? 7777}`,
              // Forward WebSocket upgrades too — used by /api/terminals/:id/io
              // for xterm.js byte streaming.
              ws: true,
            },
          },
  },
  preview: mode === "replay-lab-static" ? { proxy: {} } : undefined,
  build: {
    outDir: mode === "replay-lab-static" ? "dist-replay-lab" : undefined,
    sourcemap: envFlag(process.env.TREETOP_BUILD_SOURCEMAPS),
    rollupOptions: {
      input:
        mode === "replay-lab-static"
          ? {
              replayLab: fileURLToPath(
                new URL("./replay-lab.html", import.meta.url),
              ),
            }
          : {
              app: fileURLToPath(new URL("./index.html", import.meta.url)),
              replayLab: fileURLToPath(
                new URL("./replay-lab.html", import.meta.url),
              ),
            },
    },
  },
}));
