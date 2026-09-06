export function commandName(token: string | undefined): string {
  return (token ?? "").replace(/\\/g, "/").split("/").pop() ?? "";
}

export function lowerCommandName(token: string | undefined): string {
  return commandName(token).toLowerCase().replace(/\.(?:exe|cmd|bat)$/i, "");
}

export function optionValue(
  tokens: readonly string[],
  names: readonly string[],
): string | undefined {
  for (let index = 0; index < tokens.length; index += 1) {
    const token = tokens[index]!;
    for (const name of names) {
      if (token === name) return tokens[index + 1];
      if (token.startsWith(`${name}=`)) return token.slice(name.length + 1);
    }
  }
  return undefined;
}

export function positionalTokens(
  tokens: readonly string[],
  optionsWithValues = new Set<string>(),
): string[] {
  const values: string[] = [];
  for (let index = 0; index < tokens.length; index += 1) {
    const token = tokens[index]!;
    if (token === "--") {
      values.push(...tokens.slice(index + 1));
      break;
    }
    if (token.startsWith("-") && token !== "-") {
      const option = token.slice(0, 2);
      if (
        !token.includes("=") &&
        (optionsWithValues.has(token) || optionsWithValues.has(option))
      ) {
        index += 1;
      }
      continue;
    }
    values.push(token);
  }
  return values;
}

export function lastPathSegment(path: string): string {
  const cleaned = path.replace(/[\\/]+$/g, "");
  return cleaned.replace(/\\/g, "/").split("/").pop() || cleaned;
}
