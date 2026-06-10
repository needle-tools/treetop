import { defineConfig } from "vite";
import { svelte } from "@sveltejs/vite-plugin-svelte";
import { PRODUCT_NAME } from "../../product";

export default defineConfig({
  plugins: [
    svelte(),
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
