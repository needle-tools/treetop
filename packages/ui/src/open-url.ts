/**
 * Open a URL in the user's default browser. Routes through the daemon
 * so it works in both the browser and the native WKWebView app (where
 * window.open doesn't reach the OS browser).
 */
import { apiUrl } from "./api";

export function openUrl(url: string): void {
  fetch(apiUrl("/api/open-default"), {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ path: url }),
  }).catch(() => {
    window.open(url, "_blank", "noopener,noreferrer");
  });
}
