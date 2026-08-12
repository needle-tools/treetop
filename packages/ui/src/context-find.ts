export type ContextFindKind = "session" | "notes";

interface ContextFindScope {
  root: HTMLElement;
  kind: ContextFindKind;
  open: () => void;
  touchedAt: number;
}

const scopes: ContextFindScope[] = [];
let activeScope: ContextFindScope | null = null;

export function isContextFindShortcut(e: KeyboardEvent): boolean {
  return (
    (e.metaKey || e.ctrlKey) &&
    !e.altKey &&
    !e.shiftKey &&
    e.code === "KeyF"
  );
}

export function registerContextFindScope(
  root: HTMLElement,
  kind: ContextFindKind,
  open: () => void,
): () => void {
  const scope: ContextFindScope = { root, kind, open, touchedAt: Date.now() };
  scopes.push(scope);
  const mark = () => {
    scope.touchedAt = Date.now();
    activeScope = scope;
  };
  root.addEventListener("pointerdown", mark, { capture: true });
  root.addEventListener("focusin", mark);
  return () => {
    root.removeEventListener("pointerdown", mark, { capture: true });
    root.removeEventListener("focusin", mark);
    const index = scopes.indexOf(scope);
    if (index >= 0) scopes.splice(index, 1);
    if (activeScope === scope) activeScope = null;
  };
}

export function openContextFindForTarget(target: EventTarget | null): boolean {
  const targetNode = target instanceof Node ? target : null;
  if (targetNode) {
    let el =
      targetNode instanceof Element
        ? targetNode
        : targetNode.parentNode instanceof Element
          ? targetNode.parentNode
          : null;
    while (el) {
      const scope = scopes.find((candidate) => candidate.root === el);
      if (scope) {
        activeScope = scope;
        scope.open();
        return true;
      }
      el = el.parentElement;
    }
  }
  const connectedActive =
    activeScope && activeScope.root.isConnected ? activeScope : null;
  if (connectedActive) {
    connectedActive.open();
    return true;
  }
  const latest = scopes
    .filter((scope) => scope.root.isConnected)
    .sort((a, b) => b.touchedAt - a.touchedAt)[0];
  if (!latest) return false;
  activeScope = latest;
  latest.open();
  return true;
}

export function findRangesInText(
  text: string,
  query: string,
): Array<{ start: number; end: number }> {
  const needle = query.trim();
  if (!needle) return [];
  const haystack = text.toLocaleLowerCase();
  const lowerNeedle = needle.toLocaleLowerCase();
  const ranges: Array<{ start: number; end: number }> = [];
  let index = 0;
  while (index <= haystack.length) {
    const found = haystack.indexOf(lowerNeedle, index);
    if (found < 0) break;
    ranges.push({ start: found, end: found + lowerNeedle.length });
    index = found + Math.max(lowerNeedle.length, 1);
  }
  return ranges;
}

function textNodeSearchable(node: Text, root: HTMLElement): boolean {
  const parent = node.parentElement;
  if (!parent || !root.contains(parent)) return false;
  return !parent.closest(
    "script, style, textarea, input, select, [contenteditable='true'], [data-context-find-ignore]",
  );
}

export function collectContextFindRanges(
  root: HTMLElement,
  query: string,
): Range[] {
  const matches: Range[] = [];
  if (!query.trim()) return matches;
  const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT, {
    acceptNode(node) {
      if (!textNodeSearchable(node as Text, root)) {
        return NodeFilter.FILTER_REJECT;
      }
      return node.textContent?.trim()
        ? NodeFilter.FILTER_ACCEPT
        : NodeFilter.FILTER_REJECT;
    },
  });
  let node = walker.nextNode() as Text | null;
  while (node) {
    const text = node.textContent ?? "";
    for (const match of findRangesInText(text, query)) {
      const range = document.createRange();
      range.setStart(node, match.start);
      range.setEnd(node, match.end);
      matches.push(range);
    }
    node = walker.nextNode() as Text | null;
  }
  return matches;
}

export function clearContextFindHighlights(): void {
  const highlights =
    typeof CSS === "undefined"
      ? undefined
      : (CSS as unknown as { highlights?: Map<string, unknown> }).highlights;
  highlights?.delete("supergit-context-find");
  highlights?.delete("supergit-context-find-active");
}

export function installContextFindHighlights(
  ranges: Range[],
  activeIndex: number,
): void {
  const highlights =
    typeof CSS === "undefined"
      ? undefined
      : (CSS as unknown as { highlights?: Map<string, unknown> }).highlights;
  const HighlightCtor =
    typeof window === "undefined"
      ? undefined
      : (
          window as unknown as {
            Highlight?: new (...ranges: Range[]) => unknown;
          }
        ).Highlight;
  if (!highlights || !HighlightCtor) return;
  highlights.set("supergit-context-find", new HighlightCtor(...ranges));
  const active = ranges[activeIndex];
  if (active) {
    highlights.set("supergit-context-find-active", new HighlightCtor(active));
  } else {
    highlights.delete("supergit-context-find-active");
  }
}

export function scrollContextFindRangeIntoView(range: Range): void {
  const element =
    range.startContainer.parentElement ??
    (range.commonAncestorContainer instanceof HTMLElement
      ? range.commonAncestorContainer
      : null);
  element?.scrollIntoView({
    block: "center",
    inline: "nearest",
    behavior: "smooth",
  });
}
