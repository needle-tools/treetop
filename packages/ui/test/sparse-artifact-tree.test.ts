import { describe, expect, test } from "bun:test";
import { buildSparseArtifactRows } from "../src/sparse-artifact-tree";
import type { VisualWorkArtifact } from "../src/last-user-message";

function artifact(path: string): VisualWorkArtifact {
  return {
    id: path,
    kind: "file",
    action: "read",
    path,
    label: path.split("/").at(-1) ?? path,
  };
}

describe("buildSparseArtifactRows", () => {
  test("folds single-child folder chains in sparse artifact trees", () => {
    const rows = buildSparseArtifactRows(
      [
        artifact("/repo/crates/trellis-runtime/src/gpu.rs"),
        artifact("/repo/crates/trellis-runtime/src/pipeline.rs"),
        artifact("/repo/crates/trellis-runtime/src/kernels/linear_dispatch.rs"),
        artifact("/repo/crates/trellis-runtime/src/kernels/attention.rs"),
      ],
      "/repo",
    );

    expect(
      rows.map((row) => ({
        label: row.label,
        depth: row.depth,
        kind: row.kind,
      })),
    ).toEqual([
      { label: "crates / trellis-runtime / src", depth: 0, kind: "folder" },
      { label: "gpu.rs", depth: 1, kind: "file" },
      { label: "pipeline.rs", depth: 1, kind: "file" },
      { label: "kernels", depth: 1, kind: "folder" },
      { label: "linear_dispatch.rs", depth: 2, kind: "file" },
      { label: "attention.rs", depth: 2, kind: "file" },
    ]);
  });

  test("keeps branch folders visible once they have multiple children", () => {
    const rows = buildSparseArtifactRows(
      [
        artifact("/repo/packages/ui/src/App.svelte"),
        artifact("/repo/packages/daemon/src/server.ts"),
      ],
      "/repo",
    );

    expect(
      rows.map((row) => ({
        label: row.label,
        depth: row.depth,
        kind: row.kind,
      })),
    ).toEqual([
      { label: "packages", depth: 0, kind: "folder" },
      { label: "ui / src", depth: 1, kind: "folder" },
      { label: "App.svelte", depth: 2, kind: "file" },
      { label: "daemon / src", depth: 1, kind: "folder" },
      { label: "server.ts", depth: 2, kind: "file" },
    ]);
  });
});
