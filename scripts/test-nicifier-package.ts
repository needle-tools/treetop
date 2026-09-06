#!/usr/bin/env bun
import { mkdtemp, mkdir, readFile, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

const repositoryRoot = resolve(import.meta.dir, "..");
const packageRoot = join(repositoryRoot, "packages", "nicifier");
const tempRoot = await mkdtemp(join(tmpdir(), "treetop-nicifier-package-"));
const packDir = join(tempRoot, "pack");
const consumerDir = join(tempRoot, "consumer");

function run(command: string[], cwd: string): string {
  const result = Bun.spawnSync(command, {
    cwd,
    stdout: "pipe",
    stderr: "pipe",
    env: process.env,
  });
  const stdout = result.stdout.toString();
  const stderr = result.stderr.toString();
  if (result.exitCode !== 0) {
    throw new Error(
      `${command.join(" ")} failed (${result.exitCode})\n${stdout}${stderr}`,
    );
  }
  return stdout;
}

try {
  await mkdir(packDir);
  await mkdir(consumerDir);
  const packOutput = run(
    ["npm", "pack", packageRoot, "--pack-destination", packDir, "--json"],
    repositoryRoot,
  );
  const jsonStart = packOutput.lastIndexOf("\n[\n");
  if (jsonStart < 0) throw new Error("npm pack did not return JSON metadata");
  const packJson = JSON.parse(packOutput.slice(jsonStart + 1)) as {
    filename: string;
    files: { path: string }[];
  }[];
  const packed = packJson[0];
  if (!packed) throw new Error("npm pack produced no artifact");
  const packedPaths = new Set(packed.files.map((file) => file.path));
  for (const required of ["dist/index.js", "src/index.ts", "package.json"]) {
    if (!packedPaths.has(required)) {
      throw new Error(`package is missing ${required}`);
    }
  }

  const tarball = join(packDir, packed.filename);
  await Bun.write(
    join(consumerDir, "package.json"),
    JSON.stringify({
      name: "nicifier-external-consumer",
      private: true,
      type: "module",
      dependencies: { "@treetop/nicifier": `file:${tarball}` },
    }),
  );
  const runtimeFixture = `
import { estimateSessionTokenCost, modelPricingAt, modelsDevPricingSnapshotFrom, nicifyCommand } from "@treetop/nicifier";
const nested = nicifyCommand(\`ssh host 'docker exec app sh -lc "npm view pkg version && cargo check"'\`);
if (nested.text !== "Inspect npm package pkg · Run Cargo check" || !nested.fullyNicified) throw new Error("nested nicification failed");
const partial = nicifyCommand("git status --short && frobnicate --all");
if (partial.fullyNicified || partial.unnicifiedParts[0] !== "frobnicate --all") throw new Error("recursive fallback was hidden");
const modelsDev = modelsDevPricingSnapshotFrom({ openai: { id: "openai", models: { "gpt-package-test": { id: "gpt-package-test", cost: { input: 2, output: 12, cache_read: 0.2 } } } } }, "2026-09-06T10:00:00.000Z");
const pricing = modelPricingAt("gpt-package-test", "2026-09-06T10:00:01.000Z", { modelsDev });
if (pricing?.rates.output !== 12) throw new Error("packed models.dev pricing failed");
const sessionCost = estimateSessionTokenCost([{ model: "gpt-package-test", at: "2026-09-06T10:00:01.000Z", usage: { input: 1_000_000, cachedInput: 0, cacheWriteInput: 0, output: 1_000_000, reasoningOutput: 0, total: 2_000_000 } }], undefined, { modelsDev });
if (sessionCost.totalUsd !== 14) throw new Error("packed session pricing failed");
console.log(JSON.stringify({ nested: nested.text, partial: partial.unnicifiedParts, pricing: pricing.rates, sessionCost: sessionCost.totalUsd }));
`.trim();
  await Bun.write(join(consumerDir, "consumer.mjs"), runtimeFixture);
  await Bun.write(
    join(consumerDir, "consumer.ts"),
    `import { estimateSessionTokenCost, nicifyCommand, type ModelsDevPricingSnapshot, type NicifiedCommand, type SessionTokenUsageSegment } from "@treetop/nicifier";\nconst result: NicifiedCommand = nicifyCommand("python3 -m pytest tests");\nconst snapshot: ModelsDevPricingSnapshot | undefined = undefined;\nconst segment: SessionTokenUsageSegment | undefined = undefined;\nconst complete: boolean = result.fullyNicified;\nconsole.log(result.text, complete, snapshot, segment, estimateSessionTokenCost([]));\n`,
  );
  await Bun.write(
    join(consumerDir, "tsconfig.json"),
    JSON.stringify({
      compilerOptions: {
        module: "NodeNext",
        moduleResolution: "NodeNext",
        strict: true,
        noEmit: true,
        skipLibCheck: true,
      },
      include: ["consumer.ts"],
    }),
  );

  run(["npm", "install", "--ignore-scripts"], consumerDir);
  const nodeOutput = run(["node", "consumer.mjs"], consumerDir).trim();
  const bunOutput = run(["bun", "consumer.mjs"], consumerDir).trim();
  if (nodeOutput !== bunOutput) {
    throw new Error("Node and Bun consumers produced different results");
  }
  run(
    [
      join(repositoryRoot, "node_modules", ".bin", "tsc"),
      "-p",
      "tsconfig.json",
    ],
    consumerDir,
  );

  const archive = await readFile(tarball);
  const checksum = new Bun.CryptoHasher("sha256").update(archive).digest("hex");
  const installed = await readdir(
    join(consumerDir, "node_modules", "@treetop", "nicifier"),
  );
  console.log(
    JSON.stringify({
      revision: run(["git", "rev-parse", "HEAD"], repositoryRoot).trim(),
      tarball,
      checksum,
      installed,
      result: JSON.parse(nodeOutput),
    }),
  );
} finally {
  await rm(tempRoot, { recursive: true, force: true });
}
