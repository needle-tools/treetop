import { defineConfig, type Plugin } from "vite";
import { svelte } from "@sveltejs/vite-plugin-svelte";
import { fileURLToPath } from "node:url";
import { PRODUCT_NAME } from "../../product.ts";
import nativeConfig from "../../electrobun.config.ts";

// Captured once per frontend build, rather than once per page request.
const frontendBuildTime = new Date()
  .toISOString()
  .replace("T", " ")
  .replace(/\.\d{3}Z$/, " UTC");

function envFlag(value: string | undefined): boolean {
  if (value === undefined) return false;
  const normalized = value.trim().toLowerCase();
  return normalized === "1" || normalized === "true" || normalized === "yes";
}

/** This plugin is excluded from builds and previews. Its browser dialog is
 * independent of the app API, so it still works when every /api proxy fails. */
export function devDaemonRecoveryPlugin(
  port: number,
  {
    pollMs = 3000,
    failureLimit = 10,
  }: { pollMs?: number; failureLimit?: number } = {},
): Plugin {
  return {
    name: "treetop-dev-backend-recovery",
    apply: "serve",
    configureServer(server) {
      server.middlewares.use(async (req, res, next) => {
        if (
          req.url?.split("?")[0] !== "/__treetop_dev/backend-health" ||
          req.method !== "GET"
        ) {
          next();
          return;
        }
        let reachable = false;
        try {
          const response = await fetch(`http://127.0.0.1:${port}/api/health`, {
            signal: AbortSignal.timeout(2000),
          });
          reachable = response.ok;
          await response.body?.cancel();
        } catch {
          /* The status endpoint must remain available during backend failure. */
        }
        res.setHeader("Content-Type", "application/json");
        res.setHeader("Cache-Control", "no-store");
        res.end(JSON.stringify({ reachable }));
      });
    },
    transformIndexHtml() {
      return [
        {
          tag: "script",
          attrs: { type: "module" },
          injectTo: "body",
          children: `
        let failures=0, shown=false, pending=false, dialog;
        async function check() {
          if(pending || document.hidden) return;
          pending=true;
          try {
            const response=await fetch('/__treetop_dev/backend-health',{cache:'no-store',signal:AbortSignal.timeout(4000)});
            const status=await response.json();
            if(status.reachable) {failures=0;shown=false;dialog?.close();return;}
            if(++failures<${failureLimit} || shown) return;
            shown=true;
            if(!dialog) {
              dialog=document.createElement('dialog');
              dialog.setAttribute('aria-labelledby','treetop-dev-recovery-title');
              dialog.style.cssText='max-width:32rem;padding:1.5rem;border:1px solid #777;border-radius:12px;color-scheme:light dark;font:14px/1.5 system-ui';
              dialog.innerHTML='<h2 id="treetop-dev-recovery-title">Dev backend is unavailable</h2><p>The dev launcher attempts recovery twice when the backend stops listening. Check the dev terminal for a startup error. If it keeps failing, fix that error and restart <code>bun dev</code>.</p><p>Production is not affected.</p><button type="button" data-reload>Reload page</button> <button type="button" data-dismiss>Dismiss</button>';
              dialog.querySelector('[data-reload]').onclick=()=>location.reload();
              dialog.querySelector('[data-dismiss]').onclick=()=>dialog.close();
              document.body.appendChild(dialog);
            }
            dialog.showModal();
          } catch { /* Vite itself may be restarting; try again on the next tick. */ }
          finally {pending=false;}
        }
        setInterval(check,${pollMs});
        void check();
      `,
        },
      ];
    },
  };
}

export function replayLabDevRoutePlugin(standalone = false): Plugin {
  return {
    name: "replay-lab-dev-route",
    configureServer(server) {
      server.middlewares.use((req, _res, next) => {
        const url = req.url ?? "";
        const match =
          /^\/(?:replay-lab|codex-replay)\/?([?#].*)?$/.exec(url) ??
          (standalone ? /^\/(?:index\.html)?([?#].*)?$/.exec(url) : null);
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
          .replace(
            /%SPLASH_BUILD%/g,
            `v${nativeConfig.app.version} · ${build}`,
          );
      },
    },
    replayLabDevRoutePlugin(mode === "replay-lab-static"),
    ...(mode === "replay-lab-static"
      ? []
      : [devDaemonRecoveryPlugin(Number(process.env.SUPERGIT_PORT ?? 7777))]),
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
