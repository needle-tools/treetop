/**
 * Open a URL in the user's default browser. Routes through the daemon
 * so it works in both the browser and the native WKWebView app (where
 * window.open doesn't reach the OS browser).
 */
import { apiUrl } from "./api";

const DEFAULT_BROWSER_PROTOCOLS = new Set([
  "http:",
  "https:",
  "mailto:",
  "file:",
]);

export function shouldOpenHrefOutsideApp(
  href: string | null | undefined,
  currentHref: string,
): boolean {
  if (!href) return false;
  if (href.startsWith("#")) return false;

  let url: URL;
  try {
    url = new URL(href, currentHref);
  } catch {
    return false;
  }

  return DEFAULT_BROWSER_PROTOCOLS.has(url.protocol);
}

export function openUrl(url: string): void {
  fetch(apiUrl("/api/open-default"), {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ path: url }),
  }).catch(() => {
    window.open(url, "_blank", "noopener,noreferrer");
  });
}
