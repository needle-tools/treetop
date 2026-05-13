import { defineConfig } from "vite";
import { svelte } from "@sveltejs/vite-plugin-svelte";

export default defineConfig({
  plugins: [svelte()],
  server: {
    // 7779 sits next to the daemon's 7777 so supergit's two ports cluster
    // together, and avoids the very common 5173 clash with other Vite
    // dev servers we might have running in parallel. PORT env wins if
    // set for the rare case someone wants a different port without
    // editing this file.
    port: process.env.PORT ? Number(process.env.PORT) : 7779,
    // Bind to "localhost" by default; HOST env can override. Don't use
    // 127.0.0.1 unless asked — Vite resolves "localhost" via the OS so
    // it works for both IPv4 and IPv6 clients.
    host: process.env.HOST ?? "localhost",
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
});
