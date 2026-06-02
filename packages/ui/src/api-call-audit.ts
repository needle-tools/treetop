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
 * It is deliberately a lexical scanner, not a full TS parser. The scan has
 * two stages:
 *
 *   1. `blankNonCode` rewrites every comment, string, template-literal text
 *      segment, and **regex literal** to same-length whitespace (newlines
 *      preserved), leaving only real code tokens. This is what makes the
 *      scanner robust: a regex literal containing a quote — e.g.
 *      `s.replace(/["\\]/g, …)` — used to open a phantom string in the old
 *      quote-tracking lexer and desync the rest of the file, silently hiding
 *      every later call (StickyNotesLayer's 28 note calls were ALL invisible;
 *      SessionView hid 7). Blanking the regex as a unit closes that hole.
 *      Template `${…}` interpolations are KEPT as code (recursively blanked)
 *      so a nested `apiUrl(...)` inside a template is still seen.
 *   2. On the blanked skeleton (which has no strings/comments/regex to trip
 *      it) finding each `apiUrl(`/`apiWsUrl(`, balancing parens, and
 *      splitting top-level args is trivial bracket counting. Argument TEXT
 *      (the path literal, the daemonId expression) is read from the ORIGINAL
 *      source at the same offsets.
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

/** Scan `source` for all apiUrl/apiWsUrl calls. Calls inside comments,
 *  string/template literals, and regex literals are skipped (so a doc-comment
 *  mentioning `apiUrl(...)` doesn't register as a real call). */
export function findApiCalls(source: string): ApiCall[] {
  const blanked = blankNonCode(source);
  const calls: ApiCall[] = [];
  const re = /\bapi(Ws)?Url\s*\(/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(blanked)) !== null) {
    const tokenIdx = m.index;
    const openParen = tokenIdx + m[0].length - 1;
    const close = matchParen(blanked, openParen);
    if (close < 0) continue; // unbalanced — bail on this match
    const innerBlanked = blanked.slice(openParen + 1, close);
    const innerOrig = source.slice(openParen + 1, close);
    const args = splitTopLevelArgs(innerBlanked, innerOrig);
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

/**
 * Rewrite every comment, string, template-literal text, and regex literal in
 * `source` to same-length whitespace (newlines kept, so line numbers and
 * offsets are preserved). Template `${…}` interpolations are left as code
 * (their `${` / `}` kept as structural braces, their contents recursively
 * blanked), so a nested apiUrl call inside an interpolation survives.
 */
function blankNonCode(source: string): string {
  const out = source.split("");
  const n = source.length;
  const blank = (k: number) => {
    if (out[k] !== "\n") out[k] = " ";
  };
  // A code context tracks brace depth so we can tell an interpolation's
  // closing `}` (depth 0 in an `interp` context → back to the template) from
  // an ordinary block/object `}`.
  type Ctx =
    | { kind: "code"; interp: boolean; brace: number }
    | { kind: "tmpl" };
  const stack: Ctx[] = [{ kind: "code", interp: false, brace: 0 }];
  let prevSig = ""; // last significant code char — disambiguates regex vs `/`
  let i = 0;
  while (i < n) {
    const top = stack[stack.length - 1]!;
    const c = source[i]!;

    if (top.kind === "tmpl") {
      if (c === "\\") {
        blank(i);
        if (i + 1 < n) blank(i + 1);
        i += 2;
        continue;
      }
      if (c === "`") {
        blank(i);
        stack.pop();
        prevSig = ")"; // a template is a value; following `/` is division
        i++;
        continue;
      }
      if (c === "$" && source[i + 1] === "{") {
        // Enter the interpolation as code; keep `${` and its matching `}` as
        // structural braces (don't blank) so arg-splitting sees the nesting.
        stack.push({ kind: "code", interp: true, brace: 0 });
        prevSig = "{";
        i += 2;
        continue;
      }
      blank(i); // literal template text
      i++;
      continue;
    }

    // --- code context ---
    if (c === "/" && source[i + 1] === "/") {
      let j = source.indexOf("\n", i);
      if (j < 0) j = n;
      for (let k = i; k < j; k++) blank(k);
      i = j;
      continue;
    }
    if (c === "/" && source[i + 1] === "*") {
      let j = source.indexOf("*/", i + 2);
      j = j < 0 ? n : j + 2;
      for (let k = i; k < j; k++) blank(k);
      i = j;
      continue;
    }
    if (c === '"' || c === "'") {
      const close = skipString(source, i, c);
      for (let k = i; k <= close; k++) blank(k);
      i = close + 1;
      prevSig = ")"; // a string is a value
      continue;
    }
    if (c === "`") {
      blank(i);
      stack.push({ kind: "tmpl" });
      i++;
      prevSig = "`";
      continue;
    }
    if (c === "{") {
      top.brace++;
      prevSig = "{";
      i++;
      continue;
    }
    if (c === "}") {
      if (top.brace > 0) {
        top.brace--;
      } else if (top.interp && stack.length > 1) {
        stack.pop(); // close the interpolation → back to the template
      }
      prevSig = ")";
      i++;
      continue;
    }
    if (c === "/" && regexAllowed(prevSig)) {
      const close = skipRegex(source, i);
      if (close > i) {
        for (let k = i; k <= close; k++) blank(k);
        i = close + 1;
        prevSig = ")"; // a regex is a value
        continue;
      }
      // not a regex (division / unterminated) — fall through as ordinary char
    }
    if (c !== " " && c !== "\t" && c !== "\n" && c !== "\r") prevSig = c;
    i++;
  }
  return out.join("");
}

/** Whether a `/` at this position begins a regex literal rather than a
 *  division. Heuristic: a regex can't follow a value-ending token. Treats `/`
 *  as division when the previous significant char is an identifier/number
 *  char, `)`, `]`, or `.`; otherwise as a regex. Imperfect (e.g. `return
 *  /re/`) but covers this codebase; a miss only fails to blank, it never
 *  blanks real code. */
function regexAllowed(prevSig: string): boolean {
  if (prevSig === "") return true;
  return !/[A-Za-z0-9_$)\].]/.test(prevSig);
}

/** Index of the closing `/` of a regex literal starting at `start` (the
 *  opening `/`), honoring `\` escapes and `[...]` character classes (a `/`
 *  inside a class doesn't end it). Returns -1 if it hits a newline or EOF
 *  first (then it wasn't a regex — treat the `/` as division). */
function skipRegex(source: string, start: number): number {
  let inClass = false;
  const n = source.length;
  for (let i = start + 1; i < n; i++) {
    const c = source[i]!;
    if (c === "\\") {
      i++;
      continue;
    }
    if (c === "\n") return -1;
    if (c === "[") inClass = true;
    else if (c === "]") inClass = false;
    else if (c === "/" && !inClass) return i;
  }
  return -1;
}

/** Find the index of the `)` that closes the `(` at `open` on the BLANKED
 *  skeleton (no strings/comments/regex remain, so this is pure bracket
 *  counting). Returns -1 if unbalanced. */
function matchParen(blanked: string, open: number): number {
  let depth = 0;
  for (let i = open; i < blanked.length; i++) {
    const c = blanked[i]!;
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
  const n = source.length;
  for (let i = start + 1; i < n; i++) {
    const c = source[i]!;
    if (c === "\\") {
      i++;
      continue;
    }
    if (c === quote) return i;
  }
  return n - 1;
}

/** Split an argument-list body into top-level argument strings. Comma
 *  positions and bracket depth are read from the BLANKED inner (so a comma
 *  inside a string / template / `${…}` interpolation can't split the args);
 *  the returned argument TEXT is sliced from the ORIGINAL inner. */
function splitTopLevelArgs(innerBlanked: string, innerOrig: string): string[] {
  const args: string[] = [];
  let depth = 0;
  let start = 0;
  for (let i = 0; i < innerBlanked.length; i++) {
    const c = innerBlanked[i]!;
    if (c === "(" || c === "[" || c === "{") depth++;
    else if (c === ")" || c === "]" || c === "}") depth--;
    else if (c === "," && depth === 0) {
      args.push(innerOrig.slice(start, i));
      start = i + 1;
    }
  }
  const tail = innerOrig.slice(start);
  if (tail.trim() !== "" || args.length > 0) args.push(tail);
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

function lineAt(source: string, idx: number): number {
  let line = 1;
  for (let i = 0; i < idx && i < source.length; i++) {
    if (source[i] === "\n") line++;
  }
  return line;
}
