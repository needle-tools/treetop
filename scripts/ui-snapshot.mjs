#!/usr/bin/env node
import { spawnSync } from "node:child_process";
import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const DEFAULT_URL = "http://localhost:17779/";
const DEFAULT_SESSION = "supergit-ui-snapshot";
const DEFAULT_OUT_DIR = "/tmp/supergit-ui-snapshots";

export function parseViewportArg(value) {
  const match = /^(\d+)x(\d+)(?:@(\d+(?:\.\d+)?))?$/.exec(value);
  if (!match) {
    throw new Error(`Invalid viewport "${value}". Use WIDTHxHEIGHT or WIDTHxHEIGHT@DPR.`);
  }
  return {
    width: Number(match[1]),
    height: Number(match[2]),
    dpr: match[3] ? Number(match[3]) : 1,
  };
}

export function sanitizeSegment(value) {
  return String(value)
    .trim()
    .replace(/['"]/g, "")
    .replace(/[^a-z0-9]+/gi, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 80)
    .toLowerCase() || "element";
}

export function defaultOutName(prefix, index, label) {
  return `${sanitizeSegment(prefix)}-${String(index).padStart(3, "0")}-${sanitizeSegment(label)}.png`;
}

export function clampClipToViewport(rect, viewport, padding) {
  const x = Math.max(0, Math.floor(rect.left - padding));
  const y = Math.max(0, Math.floor(rect.top - padding));
  const right = Math.min(viewport.width, Math.ceil(rect.left + rect.width + padding));
  const bottom = Math.min(viewport.height, Math.ceil(rect.top + rect.height + padding));
  return {
    x,
    y,
    width: Math.max(1, right - x),
    height: Math.max(1, bottom - y),
    scale: 1,
  };
}

function parseArgs(argv) {
  const options = {
    all: false,
    beforeJs: [],
    index: 0,
    isolate: false,
    noOpen: false,
    out: "",
    outDir: DEFAULT_OUT_DIR,
    padding: 8,
    prefix: "snapshot",
    selector: "",
    session: DEFAULT_SESSION,
    url: DEFAULT_URL,
    viewport: { width: 1440, height: 1000, dpr: 1 },
    wait: 300,
    zoom: 3,
  };

  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    const readValue = () => {
      const value = argv[++i];
      if (!value) throw new Error(`Missing value after ${arg}`);
      return value;
    };
    if (arg === "--help" || arg === "-h") return { ...options, help: true };
    if (arg === "--all") options.all = true;
    else if (arg === "--isolate") options.isolate = true;
    else if (arg === "--no-open") options.noOpen = true;
    else if (arg === "--before-js") options.beforeJs.push(readValue());
    else if (arg === "--index") options.index = Number(readValue());
    else if (arg === "--out") options.out = readValue();
    else if (arg === "--out-dir") options.outDir = readValue();
    else if (arg === "--padding") options.padding = Number(readValue());
    else if (arg === "--prefix") options.prefix = readValue();
    else if (arg === "--selector") options.selector = readValue();
    else if (arg === "--session") options.session = readValue();
    else if (arg === "--url") options.url = readValue();
    else if (arg === "--viewport") options.viewport = parseViewportArg(readValue());
    else if (arg === "--wait") options.wait = Number(readValue());
    else if (arg === "--zoom") options.zoom = Number(readValue());
    else throw new Error(`Unknown argument ${arg}`);
  }

  if (!options.selector && !options.help) {
    throw new Error("Missing --selector CSS selector.");
  }
  if (!Number.isFinite(options.zoom) || options.zoom <= 0) {
    throw new Error("--zoom must be a positive number.");
  }
  if (!Number.isFinite(options.padding) || options.padding < 0) {
    throw new Error("--padding must be a non-negative number.");
  }
  return options;
}

function usage() {
  return `Usage:
  node scripts/ui-snapshot.mjs --selector ".sticky[data-kind='note']" --out /tmp/note.png --zoom 4
  node scripts/ui-snapshot.mjs --selector ".session-dock .dock-dot" --all --out-dir /tmp/dock --prefix dock

Options:
  --url URL             Page to open first. Default: ${DEFAULT_URL}
  --session NAME        agent-browser session name. Default: ${DEFAULT_SESSION}
  --viewport WxH[@DPR]  Browser viewport before capture. Default: 1440x1000@1
  --selector CSS        Element selector to capture.
  --index N             Element index when not using --all. Default: 0
  --all                 Capture every matching element into --out-dir.
  --out PATH            Output PNG for a single element.
  --out-dir DIR         Output directory for --all. Default: ${DEFAULT_OUT_DIR}
  --prefix NAME         Filename prefix for --all. Default: snapshot
  --zoom N              Screenshot device scale. Default: 3
  --padding PX          CSS-pixel padding around element. Default: 8
  --isolate             Clone the target into a fixed viewport stage before capture.
  --before-js SCRIPT    JS to run before capture. Repeatable.
  --no-open             Reuse the current page in the named browser session.
`;
}

function runAgentBrowser(session, args) {
  const result = spawnSync("agent-browser", ["--session", session, ...args], {
    cwd: process.cwd(),
    encoding: "utf8",
  });
  if (result.status !== 0) {
    throw new Error(
      `agent-browser ${args.join(" ")} failed:\n${result.stderr || result.stdout}`,
    );
  }
  return result.stdout.trim();
}

class CdpClient {
  constructor(url) {
    this.url = url;
    this.id = 0;
    this.pending = new Map();
  }

  async connect() {
    if (typeof WebSocket === "undefined") {
      throw new Error("This Node runtime does not expose WebSocket.");
    }
    this.ws = new WebSocket(this.url);
    this.ws.addEventListener("message", (event) => {
      const message = JSON.parse(event.data);
      if (!message.id) return;
      const pending = this.pending.get(message.id);
      if (!pending) return;
      this.pending.delete(message.id);
      if (message.error) pending.reject(new Error(JSON.stringify(message.error)));
      else pending.resolve(message.result);
    });
    await new Promise((resolve, reject) => {
      this.ws.addEventListener("open", resolve, { once: true });
      this.ws.addEventListener("error", reject, { once: true });
    });
  }

  send(method, params = {}) {
    const id = ++this.id;
    this.ws.send(JSON.stringify({ id, method, params }));
    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject });
    });
  }

  close() {
    this.ws?.close();
  }
}

async function resolvePageCdpUrl(cdpUrl) {
  if (!cdpUrl.includes("/devtools/browser/")) return cdpUrl;
  const listUrl = cdpUrl
    .replace(/^ws:/, "http:")
    .replace(/^wss:/, "https:")
    .replace(/\/devtools\/browser\/.*$/, "/json/list");
  const response = await fetch(listUrl);
  if (!response.ok) {
    throw new Error(`Failed to list CDP targets from ${listUrl}: ${response.status}`);
  }
  const targets = await response.json();
  const page =
    targets.find((target) => target.type === "page" && target.url !== "about:blank") ??
    targets.find((target) => target.type === "page");
  if (!page?.webSocketDebuggerUrl) {
    throw new Error(`No page target available from ${listUrl}`);
  }
  return page.webSocketDebuggerUrl;
}

async function evaluate(client, expression) {
  const result = await client.send("Runtime.evaluate", {
    expression,
    awaitPromise: true,
    returnByValue: true,
  });
  if (result.exceptionDetails) {
    throw new Error(result.exceptionDetails.text || "Browser evaluation failed.");
  }
  return result.result?.value;
}

async function discoverTargets(client, selector, all, index) {
  const js = `
    (() => Array.from(document.querySelectorAll(${JSON.stringify(selector)})).map((el, index) => {
      const text = (el.getAttribute("aria-label") || el.textContent || el.className || ${JSON.stringify(selector)})
        .replace(/\\s+/g, " ")
        .trim()
        .slice(0, 80);
      return { index, label: text || ${JSON.stringify(selector)} };
    }))()
  `;
  const targets = await evaluate(client, js);
  if (!Array.isArray(targets) || targets.length === 0) {
    throw new Error(`No elements matched selector ${selector}`);
  }
  return all ? targets : [targets[index] ?? targets[0]];
}

async function measureTarget(client, selector, index, padding, isolate) {
  const js = `
    (async () => {
      const el = Array.from(document.querySelectorAll(${JSON.stringify(selector)}))[${Number(index)}];
      if (!el) return null;
      document.getElementById("__supergit_ui_snapshot_stage__")?.remove();
      const label = (el.getAttribute("aria-label") || el.textContent || el.className || ${JSON.stringify(selector)})
        .replace(/\\s+/g, " ")
        .trim()
        .slice(0, 80);
      if (${JSON.stringify(Boolean(isolate))}) {
        const sourceRect = el.getBoundingClientRect();
        const stage = document.createElement("div");
        stage.id = "__supergit_ui_snapshot_stage__";
        stage.style.cssText = [
          "position: absolute",
          "left: " + (window.scrollX + 64) + "px",
          "top: " + (window.scrollY + 64) + "px",
          "z-index: 2147483647",
          "pointer-events: none",
          "background: transparent",
          "overflow: visible",
          "contain: layout style paint",
          "width: " + Math.max(1, sourceRect.width) + "px",
          "height: " + Math.max(1, sourceRect.height) + "px"
        ].join(";");
        const clone = el.cloneNode(true);
        const cs = getComputedStyle(el);
        clone.style.position = "static";
        clone.style.left = "auto";
        clone.style.top = "auto";
        clone.style.margin = "0";
        clone.style.transform = "none";
        clone.style.width = Math.max(1, sourceRect.width) + "px";
        clone.style.height = Math.max(1, sourceRect.height) + "px";
        if (cs.backgroundImage && cs.backgroundImage !== "none") {
          clone.style.backgroundImage = cs.backgroundImage;
          clone.style.backgroundPosition = cs.backgroundPosition;
          clone.style.backgroundSize = cs.backgroundSize;
          clone.style.backgroundRepeat = cs.backgroundRepeat;
          clone.style.backgroundColor = cs.backgroundColor;
        }
        stage.appendChild(clone);
        document.body.appendChild(stage);
        await new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve)));
        const rect = stage.getBoundingClientRect();
        return {
          rect: { left: rect.left + window.scrollX, top: rect.top + window.scrollY, width: rect.width, height: rect.height },
          viewport: { width: document.documentElement.scrollWidth, height: document.documentElement.scrollHeight },
          label,
          isolated: true,
          captureBeyondViewport: true
        };
      }
      el.scrollIntoView({ block: "center", inline: "center", behavior: "instant" });
      await new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve)));
      let rect = el.getBoundingClientRect();
      if (
        rect.bottom < 0 ||
        rect.top > window.innerHeight ||
        rect.right < 0 ||
        rect.left > window.innerWidth
      ) {
        const targetLeft = rect.left + window.scrollX - window.innerWidth / 2 + rect.width / 2;
        const targetTop = rect.top + window.scrollY - window.innerHeight / 2 + rect.height / 2;
        window.scrollTo({
          left: Math.max(0, targetLeft),
          top: Math.max(0, targetTop),
          behavior: "instant"
        });
        await new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve)));
        rect = el.getBoundingClientRect();
      }
      const pageWidth = Math.max(
        document.documentElement.scrollWidth,
        document.body?.scrollWidth || 0,
        window.innerWidth
      );
      const pageHeight = Math.max(
        document.documentElement.scrollHeight,
        document.body?.scrollHeight || 0,
        window.innerHeight
      );
      let fixed = false;
      for (let node = el; node && node !== document.documentElement; node = node.parentElement) {
        if (getComputedStyle(node).position === "fixed") {
          fixed = true;
          break;
        }
      }
      return {
        rect: {
          left: fixed ? rect.left : rect.left + window.scrollX,
          top: fixed ? rect.top : rect.top + window.scrollY,
          width: rect.width,
          height: rect.height
        },
        viewport: fixed
          ? { width: window.innerWidth, height: window.innerHeight }
          : { width: pageWidth, height: pageHeight },
        label,
        captureBeyondViewport: !fixed
      };
    })()
  `;
  const value = await evaluate(client, js);
  if (!value) throw new Error(`Element ${selector}[${index}] disappeared before capture.`);
  return {
    clip: clampClipToViewport(value.rect, value.viewport, padding),
    label: value.label || selector,
    isolated: Boolean(value.isolated),
    captureBeyondViewport: value.captureBeyondViewport !== false,
  };
}

async function captureTarget(client, selector, target, options) {
  const measured = await measureTarget(
    client,
    selector,
    target.index,
    options.padding,
    options.isolate,
  );
  try {
    const result = await client.send("Page.captureScreenshot", {
      format: "png",
      fromSurface: true,
      captureBeyondViewport: measured.captureBeyondViewport,
      clip: { ...measured.clip, scale: options.zoom },
    });
    const outPath = options.all
      ? path.join(options.outDir, defaultOutName(options.prefix, target.index, measured.label))
      : options.out || path.join(options.outDir, `${sanitizeSegment(options.prefix)}.png`);
    await mkdir(path.dirname(outPath), { recursive: true });
    await writeFile(outPath, Buffer.from(result.data, "base64"));
    return {
      selector,
      index: target.index,
      label: measured.label,
      path: outPath,
      cssClip: measured.clip,
      zoom: options.zoom,
      isolated: Boolean(measured.isolated),
    };
  } finally {
    if (options.isolate) {
      await evaluate(
        client,
        'document.getElementById("__supergit_ui_snapshot_stage__")?.remove()',
      ).catch(() => {});
    }
  }
}

async function main() {
  const options = parseArgs(process.argv.slice(2));
  if (options.help) {
    console.log(usage());
    return;
  }

  if (!options.noOpen) {
    runAgentBrowser(options.session, [
      "set",
      "viewport",
      String(options.viewport.width),
      String(options.viewport.height),
      String(options.viewport.dpr),
    ]);
    runAgentBrowser(options.session, ["open", options.url]);
    runAgentBrowser(options.session, ["wait", String(options.wait)]);
  }

  const cdpUrl = await resolvePageCdpUrl(
    runAgentBrowser(options.session, ["get", "cdp-url"]),
  );
  const client = new CdpClient(cdpUrl);
  await client.connect();
  try {
    await client.send("Page.enable");
    await client.send("Runtime.enable");
    for (const script of options.beforeJs) {
      await evaluate(client, `(async () => { ${script} })()`);
    }
    if (options.beforeJs.length > 0) {
      await evaluate(
        client,
        "new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve)))",
      );
    }
    const targets = await discoverTargets(
      client,
      options.selector,
      options.all,
      options.index,
    );
    const captures = [];
    for (const target of targets) {
      captures.push(await captureTarget(client, options.selector, target, options));
    }
    console.log(JSON.stringify({ captures }, null, 2));
  } finally {
    client.close();
  }
}

const mainPath = process.argv[1] ? path.resolve(process.argv[1]) : "";
if (mainPath && fileURLToPath(import.meta.url) === mainPath) {
  main().catch((error) => {
    console.error(error instanceof Error ? error.message : String(error));
    process.exit(1);
  });
}
