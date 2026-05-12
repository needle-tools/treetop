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
        target: "http://localhost:7777",
        // Forward WebSocket upgrades too — used by /api/terminals/:id/io
        // for xterm.js byte streaming.
        ws: true,
      },
    },
  },
});
