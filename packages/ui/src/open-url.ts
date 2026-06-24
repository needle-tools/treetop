/**
 * Open a URL or file path in the user's default app. Routes through the daemon
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

const WINDOW_OPEN_FALLBACK_PROTOCOLS = new Set(["http:", "https:", "mailto:"]);
const SCHEME_RE = /^[a-z][a-z0-9+.-]*:/i;

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

export function isLocalFileMarkdownHref(
  href: string | null | undefined,
): boolean {
  if (!href) return false;
  if (href.startsWith("#") || href.startsWith("?")) return false;
  if (href.startsWith("//")) return false;
  if (href.startsWith("file://")) return true;
  if (SCHEME_RE.test(href)) return false;
  return true;
}

export function resolveLocalFileMarkdownHref(
  href: string | null | undefined,
  cwd: string | null | undefined,
): string | null {
  if (!isLocalFileMarkdownHref(href)) return null;
  const value = href!;

  if (value.startsWith("file://")) {
    try {
      return decodeUrlPath(new URL(value).pathname);
    } catch {
      return null;
    }
  }

  const pathPart = decodeUrlPath(value.split(/[?#]/, 1)[0] ?? "");
  if (!pathPart || pathPart.startsWith("~")) return null;
  if (pathPart.startsWith("/")) return normalizePosixPath(pathPart);
  if (!cwd || !cwd.startsWith("/")) return null;
  return normalizePosixPath(`${cwd}/${pathPart}`);
}

function decodeUrlPath(path: string): string {
  try {
    return decodeURIComponent(path);
  } catch {
    return path;
  }
}

function normalizePosixPath(path: string): string {
  const parts: string[] = [];
  for (const part of path.split("/")) {
    if (!part || part === ".") continue;
    if (part === "..") {
      parts.pop();
    } else {
      parts.push(part);
    }
  }
  return `/${parts.join("/")}`;
}

export function shouldUseWindowOpenFallback(target: string): boolean {
  if (!SCHEME_RE.test(target)) return false;
  let url: URL;
  try {
    url = new URL(target);
  } catch {
    return false;
  }
  return WINDOW_OPEN_FALLBACK_PROTOCOLS.has(url.protocol);
}

export function openUrl(url: string): void {
  fetch(apiUrl("/api/open-default"), {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ path: url }),
  }).catch(() => {
    if (!shouldUseWindowOpenFallback(url)) return;
    window.open(url, "_blank", "noopener,noreferrer");
  });
}
