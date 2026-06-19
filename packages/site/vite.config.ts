import { defineConfig } from "vite";
import type { Plugin } from "vite";
import { svelte } from "@sveltejs/vite-plugin-svelte";
import { PRODUCT_NAME } from "../../product";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { extname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const SITE_DIR = fileURLToPath(new URL(".", import.meta.url));
const UI_PUBLIC_DIR = resolve(SITE_DIR, "../ui/public");
const UI_PUBLIC_PREFIXES = ["/agents/", "/icons/apps/"];

function contentType(path: string): string {
  switch (extname(path)) {
    case ".svg":
      return "image/svg+xml";
    case ".png":
      return "image/png";
    case ".webp":
      return "image/webp";
    case ".ico":
      return "image/x-icon";
    default:
      return "application/octet-stream";
  }
}

function walkFiles(dir: string): string[] {
  const out: string[] = [];
  for (const name of readdirSync(dir)) {
    const path = join(dir, name);
    const stat = statSync(path);
    if (stat.isDirectory()) out.push(...walkFiles(path));
    else out.push(path);
  }
  return out;
}

function uiPublicAssets(): Plugin {
  return {
    name: "ui-public-assets",
    configureServer(server) {
      server.middlewares.use((req, res, next) => {
        const url = req.url?.split("?")[0] ?? "";
        if (!UI_PUBLIC_PREFIXES.some((prefix) => url.startsWith(prefix))) {
          next();
          return;
        }
        const path = resolve(UI_PUBLIC_DIR, `.${url}`);
        if (!path.startsWith(UI_PUBLIC_DIR)) {
          next();
          return;
        }
        try {
          res.setHeader("Content-Type", contentType(path));
          res.end(readFileSync(path));
        } catch {
          next();
        }
      });
    },
    generateBundle() {
      for (const prefix of UI_PUBLIC_PREFIXES) {
        const dir = resolve(UI_PUBLIC_DIR, `.${prefix}`);
        for (const path of walkFiles(dir)) {
          this.emitFile({
            type: "asset",
            fileName: relative(UI_PUBLIC_DIR, path),
            source: readFileSync(path),
          });
        }
      }
    },
  };
}

export default defineConfig({
  resolve: {
    alias: {
      "@supergit/ui/components": new URL(
        "../ui/src/components.ts",
        import.meta.url,
      ).pathname,
      "@supergit/ui/styles": new URL("../ui/src/styles", import.meta.url)
        .pathname,
    },
  },
  plugins: [
    svelte(),
    uiPublicAssets(),
    // Keep the marketing page's <title> sourced from the shared product
    // module, exactly like the dashboard (packages/ui) does — the product
    // name has one home (../../product.ts), not three.
    {
      name: "product-title",
      transformIndexHtml(html) {
        return html.replace(/%PRODUCT_NAME%/g, PRODUCT_NAME);
      },
    },
  ],
  server: {
    // 7780 sits just past the dashboard UI (7779) and daemon (7777) so the
    // three dev servers cluster together without clashing. PORT wins if set.
    port: process.env.PORT ? Number(process.env.PORT) : 7780,
    host: process.env.HOST ?? "0.0.0.0",
    strictPort: true,
  },
});
