import { defineConfig } from "vite";
import { svelte } from "@sveltejs/vite-plugin-svelte";

export default defineConfig({
  plugins: [svelte()],
  server: {
    // 7779 sits next to the daemon's 7777 so supergit's two ports cluster
    // together, and avoids the very common 5173 clash with other Vite
    // dev servers we might have running in parallel.
    // PORT env wins if set (portless injects it when wrapping Vite as
    // `bunx portless supergit-dev …` for the clean dev URL).
    port: process.env.PORT ? Number(process.env.PORT) : 7779,
    // Bind explicitly to whatever portless says (HOST env = 127.0.0.1).
    // Without this, Vite defaults to `localhost` which on macOS often
    // resolves to IPv6 ::1, while portless's proxy probes IPv4 — the
    // result is a 502 at https://supergit-dev.localhost/.
    host: process.env.HOST ?? "localhost",
    strictPort: true,
    proxy: {
      "/api": {
        target: "http://localhost:7777",
        // Forward WebSocket upgrades too — used by /api/terminals/:id/io
        // for xterm.js byte streaming.
        ws: true,
      },
    },
  },
});
