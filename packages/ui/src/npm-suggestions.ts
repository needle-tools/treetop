const NPM_SHORTHANDS = new Set(["start", "stop", "test", "restart"]);

export function filterNpmSuggestions(cmd: string, scripts: string[]): string[] {
  if (scripts.length === 0) return [];
  const trimmed = cmd.trimStart();
  if (trimmed.length === 0) return [];

  // ── npm ───────────────────────────────────────────────────────
  if (/^n(p(m(\s+(r(u(n)?)?)?)?)?)?$/i.test(trimmed)) {
    return scripts.map(s => `npm run ${s}`);
  }
  const npmRun = trimmed.match(/^npm\s+run(\s+(\S*))?$/i);
  if (npmRun) {
    const typed = npmRun[2] ?? "";
    const matches = typed
      ? scripts.filter(s => s.toLowerCase().startsWith(typed.toLowerCase()))
      : scripts;
    return matches.map(s => `npm run ${s}`);
  }
  const npmBare = trimmed.match(/^npm\s+(\S+)$/i);
  if (npmBare) {
    const typed = npmBare[1];
    const matches = scripts.filter(s => s.toLowerCase().startsWith(typed.toLowerCase()));
    const results: string[] = [];
    for (const s of matches) {
      if (NPM_SHORTHANDS.has(s)) results.push(`npm ${s}`);
      results.push(`npm run ${s}`);
    }
    return results;
  }

  // ── yarn ──────────────────────────────────────────────────────
  if (/^y(a(r(n)?)?)?$/i.test(trimmed)) {
    return scripts.map(s => `yarn run ${s}`);
  }
  const yarnRun = trimmed.match(/^yarn\s+run(\s+(\S*))?$/i);
  if (yarnRun) {
    const typed = yarnRun[2] ?? "";
    const matches = typed
      ? scripts.filter(s => s.toLowerCase().startsWith(typed.toLowerCase()))
      : scripts;
    return matches.map(s => `yarn run ${s}`);
  }
  const yarnBare = trimmed.match(/^yarn\s+(\S*)$/i);
  if (yarnBare) {
    const typed = yarnBare[1];
    const matches = typed
      ? scripts.filter(s => s.toLowerCase().startsWith(typed.toLowerCase()))
      : scripts;
    const results: string[] = [];
    for (const s of matches) {
      results.push(`yarn ${s}`);
      results.push(`yarn run ${s}`);
    }
    return results;
  }

  // ── bun ───────────────────────────────────────────────────────
  if (/^b(u(n)?)?$/i.test(trimmed)) {
    return scripts.map(s => `bun run ${s}`);
  }
  const bunRun = trimmed.match(/^bun\s+run(\s+(\S*))?$/i);
  if (bunRun) {
    const typed = bunRun[2] ?? "";
    const matches = typed
      ? scripts.filter(s => s.toLowerCase().startsWith(typed.toLowerCase()))
      : scripts;
    return matches.map(s => `bun run ${s}`);
  }
  const bunBare = trimmed.match(/^bun\s+(\S*)$/i);
  if (bunBare) {
    const typed = bunBare[1];
    const matches = typed
      ? scripts.filter(s => s.toLowerCase().startsWith(typed.toLowerCase()))
      : scripts;
    const results: string[] = [];
    for (const s of matches) {
      results.push(`bun ${s}`);
      results.push(`bun run ${s}`);
    }
    return results;
  }

  // ── bare script name → suggest all runners ────────────────────
  const lower = trimmed.toLowerCase();
  const matches = scripts.filter(s => s.toLowerCase().startsWith(lower));
  if (matches.length > 0) {
    const results: string[] = [];
    for (const s of matches) {
      if (NPM_SHORTHANDS.has(s)) results.push(`npm ${s}`);
      results.push(`npm run ${s}`);
      results.push(`yarn ${s}`);
      results.push(`bun ${s}`);
    }
    return results;
  }
  return [];
}

export function npmScriptsPlaceholder(scripts: string[]): string {
  if (scripts.length === 0) return "npm run dev";
  const joined = scripts.join(", ");
  if (joined.length <= 50) return joined;
  return joined.slice(0, 47) + "...";
}
