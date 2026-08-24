import type { VisualWorkArtifact } from "./last-user-message";

export interface SparseArtifactTreeRow {
  id: string;
  label: string;
  path: string;
  hrefPath: string;
  depth: number;
  kind: "folder" | "file" | "other";
  artifacts: VisualWorkArtifact[];
}

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
        normalizeArtifactPath(artifact.path),
        artifact.label,
        artifact.additions ?? "",
        artifact.deletions ?? "",
        artifact.diff ?? "",
        ...(artifact.changes ?? []).map((change) =>
          [
            change.action,
            normalizeArtifactPath(change.path),
            change.label,
            change.additions ?? "",
            change.deletions ?? "",
            change.diff ?? "",
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

  for (const artifact of fileArtifacts) {
    const clean = normalizeArtifactPath(artifact.path);
    const displayPath = displayPathForArtifact(clean, worktreePath);
    const displayParts = displayPath.split("/").filter(Boolean);
    let currentPath = "";
    let parent = root;

    for (const part of displayParts.slice(0, -1)) {
      currentPath = currentPath ? `${currentPath}/${part}` : part;
      parent = upsertChild(parent, {
        id: `folder:${currentPath}`,
        label: part,
        path: currentPath,
        hrefPath: currentPath,
        kind: "folder",
      });
    }

    const fileLabel =
      displayParts[displayParts.length - 1] ?? artifactLabel(artifact);
    const filePath = clean || artifact.path!;
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
