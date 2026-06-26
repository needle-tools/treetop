import { defineConfig } from "vite";
import { svelte } from "@sveltejs/vite-plugin-svelte";
import { PRODUCT_NAME } from "../../product";

function envFlag(value: string | undefined): boolean {
  if (value === undefined) return false;
  const normalized = value.trim().toLowerCase();
  return normalized === "1" || normalized === "true" || normalized === "yes";
}

export default defineConfig(() => ({
  plugins: [
    svelte(),
    // Inject the product name into index.html's <title> from the shared
    // product module, so the static HTML isn't a second source of truth.
    {
      name: "product-title",
      transformIndexHtml(html) {
        return html.replace(/%PRODUCT_NAME%/g, PRODUCT_NAME);
      },
    },
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
    proxy: {
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
  build: {
    sourcemap: envFlag(process.env.TREETOP_BUILD_SOURCEMAPS),
  },
}));
