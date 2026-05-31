/**
 * A tiny source scanner for `apiUrl(...)` / `apiWsUrl(...)` call sites.
 *
 * Phase B of the remote-daemon work routes every daemon request through
 * `apiUrl(path, daemonId?)` (and `apiWsUrl(path, host, proto, daemonId?)`).
 * A request that targets a SPECIFIC repo/worktree must pass a `daemonId`
 * so a remote folder row's terminal/diff/status/files reach the right
 * daemon; a workspace-global request (events, prefs, editors, the daemon
 * registry itself) must stay local and pass NONE.
 *
 * The danger is a "half-and-half" UI: the repo list is daemon-aware but a
 * row's terminal silently hits the local daemon. To make that state
 * impossible to ship green, a guard test scans the source for every call
 * and asserts each one is correctly routed. This module is the parser that
 * guard relies on — pure and unit-tested so the guard's verdicts are
 * trustworthy. See `packages/ui/test/daemon-routing-guard.test.ts`.
 *
 * It is deliberately a lexical scanner, not a full TS parser: it walks the
 * source tracking string / template / comment context, finds each
 * `apiUrl(`/`apiWsUrl(` call, balances parentheses to capture the whole
 * argument list, splits the top-level arguments, extracts the static path
 * prefix from the first argument, and reports whether the daemonId
 * argument slot is populated.
 */

export interface ApiCall {
  fn: "apiUrl" | "apiWsUrl";
  /** Static path prefix of the first argument (e.g. "/api/diff"), or null
   *  when the first argument isn't a string/template literal (a computed
   *  path the guard can't classify by endpoint). */
  path: string | null;
  /** Whether the daemonId argument slot is populated with something other
   *  than `undefined`/`null`. apiUrl → 2nd arg; apiWsUrl → 4th arg. */
  hasDaemonId: boolean;
  /** Character offset of the `apiUrl`/`apiWsUrl` token in the source. */
  index: number;
  /** 1-based line number of the call (for human-readable diagnostics). */
  line: number;
  /** The raw call text, for diagnostics. */
  raw: string;
}

/** Scan `source` for all apiUrl/apiWsUrl calls. Calls inside comments and
 *  string literals are skipped (so a doc-comment mentioning `apiUrl(...)`
 *  doesn't register as a real call). */
export function findApiCalls(source: string): ApiCall[] {
  const calls: ApiCall[] = [];
  const re = /\bapi(Ws)?Url\s*\(/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(source)) !== null) {
    const tokenIdx = m.index;
    // Skip a match that sits inside a comment or string literal — those
    // aren't real calls. We re-scan context up to the token; cheap enough
    // for the handful of files we audit.
    if (isInIgnoredContext(source, tokenIdx)) continue;
    const openParen = tokenIdx + m[0].length - 1;
    const close = matchParen(source, openParen);
    if (close < 0) continue; // unbalanced — bail on this match
    const inner = source.slice(openParen + 1, close);
    const args = splitTopLevelArgs(inner);
    const fn = m[1] ? "apiWsUrl" : "apiUrl";
    const daemonArgIdx = fn === "apiWsUrl" ? 3 : 1;
    const path = args.length > 0 ? staticPathPrefix(args[0]!) : null;
    const daemonArg = args[daemonArgIdx]?.trim();
    const hasDaemonId =
      daemonArg != null &&
      daemonArg !== "" &&
      daemonArg !== "undefined" &&
      daemonArg !== "null";
    calls.push({
      fn,
      path,
      hasDaemonId,
      index: tokenIdx,
      line: lineAt(source, tokenIdx),
      raw: source.slice(tokenIdx, close + 1),
    });
  }
  return calls;
}

/** Find the index of the `)` that closes the `(` at `open`, tracking
 *  nested (), [], {}, strings, templates (incl. ${} interpolation), and
 *  comments. Returns -1 if unbalanced. */
function matchParen(source: string, open: string | number): number {
  let i = typeof open === "number" ? open : 0;
  let depth = 0;
  const n = source.length;
  for (; i < n; i++) {
    const c = source[i]!;
    if (c === "/" && source[i + 1] === "/") {
      const nl = source.indexOf("\n", i);
      i = nl < 0 ? n : nl;
      continue;
    }
    if (c === "/" && source[i + 1] === "*") {
      const end = source.indexOf("*/", i + 2);
      i = end < 0 ? n : end + 1;
      continue;
    }
    if (c === '"' || c === "'") {
      i = skipString(source, i, c);
      continue;
    }
    if (c === "`") {
      i = skipTemplate(source, i);
      continue;
    }
    if (c === "(" || c === "[" || c === "{") depth++;
    else if (c === ")" || c === "]" || c === "}") {
      depth--;
      if (depth === 0 && c === ")") return i;
    }
  }
  return -1;
}

/** Index of the closing quote of a single/double-quoted string starting at
 *  `start` (the opening quote). Honors backslash escapes. */
function skipString(source: string, start: number, quote: string): number {
  let i = start + 1;
  const n = source.length;
  for (; i < n; i++) {
    const c = source[i]!;
    if (c === "\\") {
      i++;
      continue;
    }
    if (c === quote) return i;
  }
  return n - 1;
}

/** Index of the closing backtick of a template literal starting at `start`
 *  (the opening backtick), descending into `${ ... }` interpolations so a
 *  backtick or paren inside them doesn't end the scan early. */
function skipTemplate(source: string, start: number): number {
  let i = start + 1;
  const n = source.length;
  for (; i < n; i++) {
    const c = source[i]!;
    if (c === "\\") {
      i++;
      continue;
    }
    if (c === "`") return i;
    if (c === "$" && source[i + 1] === "{") {
      // Skip the interpolation, balancing its braces (which may contain
      // nested templates / strings).
      let depth = 1;
      i += 2;
      for (; i < n && depth > 0; i++) {
        const d = source[i]!;
        if (d === "{") depth++;
        else if (d === "}") depth--;
        else if (d === '"' || d === "'") i = skipString(source, i, d);
        else if (d === "`") i = skipTemplate(source, i);
      }
      i--; // for-loop will ++ again
    }
  }
  return n - 1;
}

/** Split an argument-list body into top-level argument strings, ignoring
 *  commas nested inside (), [], {}, strings, and templates. */
function splitTopLevelArgs(inner: string): string[] {
  const args: string[] = [];
  let depth = 0;
  let start = 0;
  const n = inner.length;
  for (let i = 0; i < n; i++) {
    const c = inner[i]!;
    if (c === '"' || c === "'") {
      i = skipString(inner, i, c);
      continue;
    }
    if (c === "`") {
      i = skipTemplate(inner, i);
      continue;
    }
    if (c === "(" || c === "[" || c === "{") depth++;
    else if (c === ")" || c === "]" || c === "}") depth--;
    else if (c === "," && depth === 0) {
      args.push(inner.slice(start, i));
      start = i + 1;
    }
  }
  const last = inner.slice(start);
  if (last.trim() !== "" || args.length > 0) args.push(last);
  return args;
}

/** Extract the static path prefix from a first-argument expression. For a
 *  string or template literal, returns the leading literal text up to the
 *  first `?` (query) or `${` (interpolation). Returns null for a
 *  non-literal (computed) expression. */
function staticPathPrefix(arg: string): string | null {
  const s = arg.trim();
  const q = s[0];
  if (q !== '"' && q !== "'" && q !== "`") return null;
  let out = "";
  for (let i = 1; i < s.length; i++) {
    const c = s[i]!;
    if (c === q) break;
    if (c === "?") break;
    if (c === "\\") {
      i++;
      continue;
    }
    if (q === "`" && c === "$" && s[i + 1] === "{") break;
    out += c;
  }
  return out;
}

/** Whether the regex match at `idx` falls inside a comment or string,
 *  scanned from the start of the file. */
function isInIgnoredContext(source: string, idx: number): boolean {
  let i = 0;
  while (i < idx) {
    const c = source[i]!;
    if (c === "/" && source[i + 1] === "/") {
      const nl = source.indexOf("\n", i);
      if (nl < 0 || nl >= idx) return true;
      i = nl + 1;
      continue;
    }
    if (c === "/" && source[i + 1] === "*") {
      const end = source.indexOf("*/", i + 2);
      if (end < 0 || end + 1 >= idx) return true;
      i = end + 2;
      continue;
    }
    if (c === '"' || c === "'") {
      const end = skipString(source, i, c);
      if (end >= idx) return true;
      i = end + 1;
      continue;
    }
    if (c === "`") {
      const end = skipTemplate(source, i);
      if (end >= idx) return true;
      i = end + 1;
      continue;
    }
    i++;
  }
  return false;
}

function lineAt(source: string, idx: number): number {
  let line = 1;
  for (let i = 0; i < idx && i < source.length; i++) {
    if (source[i] === "\n") line++;
  }
  return line;
}
