import type {
  VisualWorkArtifact,
  VisualWorkArtifactChange,
} from "./last-user-message";

export interface SparseArtifactTreeRow {
  id: string;
  label: string;
  path: string;
  hrefPath: string;
  depth: number;
  kind: "folder" | "file" | "other";
  artifacts: VisualWorkArtifact[];
}

export type SparseArtifactFileLifecycle = "added" | "edited" | "deleted";

export type SparseArtifactRowActionSummary =
  | {
      kind: "changed";
      additions?: number;
      deletions?: number;
      rangeLabel?: string;
      fallbackLabel: "+" | "-" | "write";
      fileLifecycle?: SparseArtifactFileLifecycle;
    }
  | { kind: "range"; label: string }
  | { kind: "action"; labels: string[] };

interface MutableTreeNode {
  id: string;
  label: string;
  path: string;
  hrefPath: string;
  kind: "folder" | "file" | "other";
  artifacts: VisualWorkArtifact[];
  children: MutableTreeNode[];
  childById: Map<string, MutableTreeNode>;
}

export function stripArtifactRange(path: string): string {
  return path.trim().replace(/:\d+(?:-\d+)?$/, "");
}

export function normalizeArtifactPath(path: string | undefined): string {
  if (!path) return "";
  return stripArtifactRange(path).replace(/\\/g, "/").replace(/\/+/g, "/");
}

function normalizedWorktreePath(worktreePath: string | undefined): string {
  return normalizeArtifactPath(worktreePath).replace(/\/$/, "");
}

function isAbsoluteArtifactPath(path: string): boolean {
  return path.startsWith("/") || /^[A-Za-z]:\//.test(path);
}

function canonicalArtifactPath(
  path: string | undefined,
  worktreePath: string | undefined,
): string {
  const clean = normalizeArtifactPath(path);
  const root = normalizedWorktreePath(worktreePath);
  if (!clean || !root) return clean;
  if (clean === root || clean.startsWith(`${root}/`)) return clean;
  if (isAbsoluteArtifactPath(clean) || clean.startsWith("../")) return clean;
  return normalizeArtifactPath(`${root}/${clean.replace(/^\.\//, "")}`);
}

function displayPathForArtifact(
  path: string,
  worktreePath: string | undefined,
): string {
  const clean = normalizeArtifactPath(path);
  const root = normalizedWorktreePath(worktreePath);
  if (!root) return clean;
  if (clean === root) return ".";
  return clean.startsWith(`${root}/`) ? clean.slice(root.length + 1) : clean;
}

function isInsideWorktree(
  path: string,
  worktreePath: string | undefined,
): boolean {
  const clean = normalizeArtifactPath(path);
  const root = normalizedWorktreePath(worktreePath);
  return !!root && (clean === root || clean.startsWith(`${root}/`));
}

function artifactLabel(artifact: VisualWorkArtifact): string {
  return artifact.label || normalizeArtifactPath(artifact.path) || "artifact";
}

function createNode(
  id: string,
  label: string,
  path: string,
  hrefPath: string,
  kind: MutableTreeNode["kind"],
): MutableTreeNode {
  return {
    id,
    label,
    path,
    hrefPath,
    kind,
    artifacts: [],
    children: [],
    childById: new Map(),
  };
}

function upsertChild(
  parent: MutableTreeNode,
  child: Omit<MutableTreeNode, "children" | "childById" | "artifacts">,
): MutableTreeNode {
  const existing = parent.childById.get(child.id);
  if (existing) return existing;
  const node = createNode(
    child.id,
    child.label,
    child.path,
    child.hrefPath,
    child.kind,
  );
  parent.childById.set(node.id, node);
  parent.children.push(node);
  return node;
}

function artifactCanonicalPath(
  artifact: VisualWorkArtifact,
  worktreePath: string | undefined,
): string {
  return canonicalArtifactPath(artifact.path, worktreePath);
}

function folderArtifactPaths(
  artifacts: readonly VisualWorkArtifact[],
  worktreePath: string | undefined,
): Set<string> {
  const paths = artifacts
    .map((artifact) => artifactCanonicalPath(artifact, worktreePath))
    .filter(Boolean);
  const folders = new Set<string>();
  for (const path of paths) {
    if (paths.some((other) => other.startsWith(`${path}/`))) {
      folders.add(path);
    }
  }
  return folders;
}

function upsertFolderPath(
  root: MutableTreeNode,
  displayParts: readonly string[],
): MutableTreeNode {
  let currentPath = "";
  let parent = root;
  for (const part of displayParts) {
    currentPath = currentPath ? `${currentPath}/${part}` : part;
    parent = upsertChild(parent, {
      id: `folder:${currentPath}`,
      label: part,
      path: currentPath,
      hrefPath: currentPath,
      kind: "folder",
    });
  }
  return parent;
}

function foldedFolder(node: MutableTreeNode): MutableTreeNode {
  let current = node;
  const labels = [current.label];
  while (
    current.kind === "folder" &&
    current.artifacts.length === 0 &&
    current.children.length === 1 &&
    current.children[0]?.kind === "folder" &&
    current.children[0].artifacts.length === 0
  ) {
    current = current.children[0];
    labels.push(current.label);
  }
  if (current === node) return node;
  return {
    id: node.id,
    label: labels.join(" / "),
    path: current.path,
    hrefPath: current.hrefPath,
    kind: "folder",
    artifacts: [],
    children: current.children,
    childById: current.childById,
  };
}

function flattenRows(
  nodes: readonly MutableTreeNode[],
  depth: number,
  rows: SparseArtifactTreeRow[],
): void {
  for (const node of nodes) {
    const folded = node.kind === "folder" ? foldedFolder(node) : node;
    rows.push({
      id: folded.id,
      label: folded.label,
      path: folded.path,
      hrefPath: folded.hrefPath,
      depth,
      kind: folded.kind,
      artifacts: folded.artifacts,
    });
    if (folded.children.length > 0) {
      flattenRows(folded.children, depth + 1, rows);
    }
  }
}

export function sparseArtifactSignature(
  values: readonly VisualWorkArtifact[],
  worktreePath: string | undefined,
): string {
  return [
    normalizeArtifactPath(worktreePath),
    ...values.map((artifact) =>
      [
        artifact.id,
        artifact.action,
        artifact.kind,
        canonicalArtifactPath(artifact.path, worktreePath),
        artifact.label,
        artifact.additions ?? "",
        artifact.deletions ?? "",
        artifact.diff ?? "",
        artifact.fileAction ?? "",
        ...(artifact.changes ?? []).map((change) =>
          [
            change.action,
            canonicalArtifactPath(change.path, worktreePath),
            change.label,
            change.additions ?? "",
            change.deletions ?? "",
            change.diff ?? "",
            change.fileAction ?? "",
          ].join("\u0003"),
        ),
      ].join("\u0001"),
    ),
  ].join("\u0002");
}

export function buildSparseArtifactRows(
  values: readonly VisualWorkArtifact[],
  worktreePath: string | undefined,
): SparseArtifactTreeRow[] {
  const root = createNode("root", "", "", "", "folder");
  const fileArtifacts = values.filter((artifact) => artifact.path);
  const folderPaths = folderArtifactPaths(fileArtifacts, worktreePath);

  for (const artifact of fileArtifacts) {
    const clean = normalizeArtifactPath(artifact.path);
    const canonical = canonicalArtifactPath(clean, worktreePath);
    const displayPath = displayPathForArtifact(canonical || clean, worktreePath);
    const displayParts = displayPath.split("/").filter(Boolean);
    const isFolderArtifact = !!canonical && folderPaths.has(canonical);

    if (isFolderArtifact) {
      const folderRow = upsertFolderPath(root, displayParts);
      folderRow.artifacts.push(artifact);
      continue;
    }

    const parent = upsertFolderPath(root, displayParts.slice(0, -1));

    const fileLabel =
      displayParts[displayParts.length - 1] ?? artifactLabel(artifact);
    const filePath = canonical || clean || artifact.path!;
    const hrefPath = isInsideWorktree(filePath, worktreePath)
      ? displayPath
      : filePath;
    const fileRow = upsertChild(parent, {
      id: `file:${filePath}`,
      label: fileLabel,
      path: filePath,
      hrefPath,
      kind: "file",
    });
    fileRow.artifacts.push(artifact);
  }

  for (const artifact of values.filter((value) => !value.path)) {
    const node = upsertChild(root, {
      id: artifact.id,
      label: artifactLabel(artifact),
      path: artifact.label,
      hrefPath: artifact.label,
      kind: "other",
    });
    node.artifacts.push(artifact);
  }

  const rows: SparseArtifactTreeRow[] = [];
  flattenRows(root.children, 0, rows);
  return rows;
}

function actionLabel(action: VisualWorkArtifact["action"]): string {
  if (action === "changed") return "write";
  if (action === "produced") return "created";
  return "read";
}

function artifactChanges(
  artifact: VisualWorkArtifact,
): VisualWorkArtifactChange[] {
  return artifact.changes && artifact.changes.length > 0
    ? artifact.changes
    : [
        {
          action: artifact.action,
          label: artifact.label,
          path: artifact.path,
          title: artifact.title,
          additions: artifact.additions,
          deletions: artifact.deletions,
          diff: artifact.diff,
          diffKind: artifact.diffKind,
          fileAction: artifact.fileAction,
        },
      ];
}

export function sparseArtifactRowChanges(
  row: Pick<SparseArtifactTreeRow, "artifacts">,
): VisualWorkArtifactChange[] {
  return row.artifacts.flatMap(artifactChanges);
}

export function sparseArtifactRowDiffChanges(
  row: Pick<SparseArtifactTreeRow, "artifacts">,
): VisualWorkArtifactChange[] {
  return sparseArtifactRowChanges(row).filter(
    (change) => change.diff !== undefined,
  );
}

function artifactRange(
  artifact: VisualWorkArtifact | VisualWorkArtifactChange,
): string | undefined {
  const value = `${artifact.label} ${artifact.path ?? ""}`;
  const match = value.match(/:(\d+(?:-\d+)?)\b/);
  return match?.[1];
}

function uniqueStrings(values: Array<string | undefined>): string[] {
  return [...new Set(values.filter((value): value is string => !!value))];
}

export function sparseArtifactRowLifecycle(
  row: Pick<SparseArtifactTreeRow, "artifacts">,
): SparseArtifactFileLifecycle | undefined {
  const lifecycles = sparseArtifactRowChanges(row)
    .map((change) => change.fileAction)
    .filter(
      (value): value is SparseArtifactFileLifecycle =>
        value === "added" || value === "edited" || value === "deleted",
    );
  if (lifecycles.includes("added") && !lifecycles.includes("deleted")) {
    return "added";
  }
  if (lifecycles.includes("deleted") && !lifecycles.includes("added")) {
    return "deleted";
  }
  if (lifecycles.includes("edited")) return "edited";
  return lifecycles.at(-1);
}

export function sparseArtifactRowActionSummary(
  row: Pick<SparseArtifactTreeRow, "artifacts">,
): SparseArtifactRowActionSummary {
  const changes = sparseArtifactRowChanges(row);
  const ranges = uniqueStrings(changes.map(artifactRange));
  const rangeLabel =
    ranges.length === 0
      ? undefined
      : ranges.length === 1
        ? ranges[0]!
        : `${ranges.length} ranges`;
  const changed = changes.filter((change) => change.action === "changed");
  if (changed.length > 0) {
    const additions = changed.reduce(
      (sum, change) => sum + (change.additions ?? 0),
      0,
    );
    const deletions = changed.reduce(
      (sum, change) => sum + (change.deletions ?? 0),
      0,
    );
    const fileLifecycle = sparseArtifactRowLifecycle(row);
    return {
      kind: "changed",
      additions: changed.some((change) => change.additions !== undefined)
        ? additions
        : undefined,
      deletions: changed.some((change) => change.deletions !== undefined)
        ? deletions
        : undefined,
      rangeLabel,
      fallbackLabel:
        fileLifecycle === "added"
          ? "+"
          : fileLifecycle === "deleted"
            ? "-"
            : "write",
      fileLifecycle,
    };
  }
  if (rangeLabel) {
    return {
      kind: "range",
      label: rangeLabel,
    };
  }
  return {
    kind: "action",
    labels: uniqueStrings(changes.map((change) => actionLabel(change.action))),
  };
}
