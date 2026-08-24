import { describe, expect, test } from "bun:test";
import {
  buildSparseArtifactRows,
  sparseArtifactRowActionSummary,
  sparseArtifactRowLifecycle,
} from "../src/sparse-artifact-tree";
import type { VisualWorkArtifact } from "../src/last-user-message";

function artifact(
  path: string,
  overrides: Partial<VisualWorkArtifact> = {},
): VisualWorkArtifact {
  return {
    id: path,
    kind: "file",
    action: "used",
    path,
    label: path.split("/").at(-1) ?? path,
    ...overrides,
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

  test("coalesces absolute and relative artifacts for the same worktree file", () => {
    const rows = buildSparseArtifactRows(
      [
        artifact("/repo/lib/Workbench.svelte:1-100", {
          label: "Workbench.svelte:1-100",
        }),
        artifact("lib/Workbench.svelte", {
          action: "changed",
          additions: 2,
          deletions: 3,
        }),
      ],
      "/repo",
    );

    const files = rows.filter((row) => row.kind === "file");
    expect(files).toHaveLength(1);
    expect(files[0]?.label).toBe("Workbench.svelte");
    expect(files[0]?.path).toBe("/repo/lib/Workbench.svelte");
    expect(files[0]?.hrefPath).toBe("lib/Workbench.svelte");
    expect(files[0]?.artifacts.map((item) => item.action)).toEqual([
      "used",
      "changed",
    ]);
  });

  test("keeps multiple read ranges on one artifact row", () => {
    const rows = buildSparseArtifactRows(
      [
        artifact("/repo/scripts/optimize-asset.mjs:1-80", {
          label: "optimize-asset.mjs:1-80",
        }),
        artifact("/repo/scripts/optimize-asset.mjs:360-445", {
          label: "optimize-asset.mjs:360-445",
        }),
      ],
      "/repo",
    );

    const files = rows.filter((row) => row.kind === "file");
    expect(files).toHaveLength(1);
    expect(files[0]?.label).toBe("optimize-asset.mjs");
    expect(files[0]?.artifacts).toHaveLength(2);
  });

  test("keeps a read parent folder visible instead of folding it into its child", () => {
    const rows = buildSparseArtifactRows(
      [
        artifact("/Users/herbst/Downloads"),
        artifact("/Users/herbst/Downloads/videos_cloud/nefertiti-vid.otiod"),
      ],
      undefined,
    );

    expect(
      rows.map((row) => ({
        label: row.label,
        depth: row.depth,
        kind: row.kind,
        artifacts: row.artifacts.length,
      })),
    ).toEqual([
      { label: "Users / herbst", depth: 0, kind: "folder", artifacts: 0 },
      { label: "Downloads", depth: 1, kind: "folder", artifacts: 1 },
      { label: "videos_cloud", depth: 2, kind: "folder", artifacts: 0 },
      { label: "nefertiti-vid.otiod", depth: 3, kind: "file", artifacts: 1 },
    ]);
  });

  test("summarizes created files with line counts when the session provided them", () => {
    const rows = buildSparseArtifactRows(
      [
        artifact("/repo/src/new-file.ts", {
          action: "changed",
          additions: 400,
          fileAction: "added",
        }),
      ],
      "/repo",
    );

    const file = rows.find((row) => row.kind === "file");
    expect(file).toBeDefined();
    expect(sparseArtifactRowLifecycle(file!)).toBe("added");
    expect(sparseArtifactRowActionSummary(file!)).toMatchObject({
      kind: "changed",
      additions: 400,
      deletions: undefined,
      fallbackLabel: "+",
      fileLifecycle: "added",
    });
  });

  test("uses lifecycle symbols for count-less created and deleted files", () => {
    const rows = buildSparseArtifactRows(
      [
        artifact("/repo/src/countless-created.ts", {
          action: "changed",
          fileAction: "added",
        }),
        artifact("/repo/src/countless-deleted.ts", {
          action: "changed",
          fileAction: "deleted",
        }),
      ],
      "/repo",
    );

    const created = rows.find((row) => row.label === "countless-created.ts");
    const deleted = rows.find((row) => row.label === "countless-deleted.ts");
    expect(created).toBeDefined();
    expect(deleted).toBeDefined();
    expect(sparseArtifactRowActionSummary(created!)).toMatchObject({
      kind: "changed",
      additions: undefined,
      deletions: undefined,
      fallbackLabel: "+",
      fileLifecycle: "added",
    });
    expect(sparseArtifactRowActionSummary(deleted!)).toMatchObject({
      kind: "changed",
      additions: undefined,
      deletions: undefined,
      fallbackLabel: "-",
      fileLifecycle: "deleted",
    });
  });
});
