/**
 * ============================================================================
 *  PROVISION / UNINSTALL DOCKER E2E — OPT-IN, NEVER RUNS IN THE DEFAULT SUITE
 * ============================================================================
 *
 * Drives the REAL ssh+tar+spawner+manager chain against a REAL "box" — a
 * throwaway Debian container running sshd — for both flows:
 *
 *   - provision: ship the payload over ssh → the box extracts it (gzip tar)
 *     → run install.sh --no-pull → capture its printed token → register.
 *   - uninstall: run install.sh --uninstall over ssh → unregister.
 *
 * The box runs a STUB deploy/install.sh (writes/removes a marker + prints a
 * SUPERGIT_CONNECT token) so the test is DETERMINISTIC and OFFLINE — it
 * exercises supergit's plumbing (the bits that had live bugs: the binary
 * stdin pipe, `tar -x -z` extraction, the run-only uninstall, token capture,
 * register/unregister), NOT the real installer's bun/go/network download
 * (that's verified by hand + bash -n).
 *
 * WHY GUARDED: it builds + runs a container and binds a port — slow, and not
 * something an agent should trigger on every `bun test`. Run it deliberately:
 *
 *     bun run test:provision-docker
 *
 * Requires: Docker running + network (to build the box image once). Loopback
 * only; the container is force-removed in afterAll even if setup throws.
 */

import {
  describe,
  test,
  expect,
  beforeAll,
  afterAll,
} from "bun:test";
import { mkdtemp, rm, mkdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ProvisionManager } from "../src/provision-manager";
import { makeProvisionSpawner } from "../src/provision-spawn";

const ENABLED = process.env.SUPERGIT_DOCKER_TESTS === "1";
const suite = ENABLED ? describe : describe.skip;

const IMAGE = "supergit-test-box:latest";
const CONTAINER = "supergit-e2e-box";

/** Run a host command; return {code, stdout, stderr}. */
async function run(
  cmd: string[],
  opts: { stdin?: string } = {},
): Promise<{ code: number; stdout: string; stderr: string }> {
  const proc = Bun.spawn(cmd, {
    stdin: opts.stdin ? new TextEncoder().encode(opts.stdin) : "ignore",
    stdout: "pipe",
    stderr: "pipe",
  });
  const stdout = await new Response(proc.stdout).text();
  const stderr = await new Response(proc.stderr).text();
  const code = await proc.exited;
  return { code, stdout, stderr };
}

const dx = (args: string[]) => run(["docker", "exec", CONTAINER, ...args]);

/** The stub installer the box runs in place of the real one. */
const STUB_INSTALL_SH = `#!/usr/bin/env bash
set -e
DIR="$(cd "$(dirname "$0")/.." && pwd)"
case "$1" in
  --uninstall)
    rm -f "$DIR/.installed"
    echo "stub-install: uninstalled"
    ;;
  *)
    touch "$DIR/.installed"
    echo "stub-install: installed (args: $*)"
    echo "SUPERGIT_CONNECT=supergit1:TESTTOKEN"
    ;;
esac
`;

let tmp = "";
let keyPath = "";
let sshPort = 0;
let started = false;

async function dockerAvailable(): Promise<boolean> {
  return (await run(["docker", "version", "--format", "{{.Server.Version}}"]))
    .code === 0;
}

suite("provision/uninstall docker e2e", () => {
  beforeAll(async () => {
    if (!(await dockerAvailable())) throw new Error("docker not available");
    tmp = await mkdtemp(join(tmpdir(), "supergit-docker-e2e-"));

    // 1. A throwaway ssh keypair the host will use as the box's admin key.
    keyPath = join(tmp, "id_ed25519");
    expect(
      (await run(["ssh-keygen", "-t", "ed25519", "-N", "", "-f", keyPath, "-q"]))
        .code,
    ).toBe(0);
    const pub = await Bun.file(`${keyPath}.pub`).text();

    // 2. Build the box image: debian + sshd + tar, root login by our key.
    const ctx = join(tmp, "ctx");
    await mkdir(ctx, { recursive: true });
    await writeFile(join(ctx, "authorized_keys"), pub);
    await writeFile(
      join(ctx, "Dockerfile"),
      `FROM debian:stable-slim
RUN apt-get update -qq && apt-get install -y -qq openssh-server tar >/dev/null \\
 && mkdir -p /run/sshd /root/.ssh && chmod 700 /root/.ssh \\
 && sed -i 's/^#\\?PermitRootLogin.*/PermitRootLogin prohibit-password/' /etc/ssh/sshd_config
COPY authorized_keys /root/.ssh/authorized_keys
RUN chmod 600 /root/.ssh/authorized_keys
CMD ["/usr/sbin/sshd","-D","-e"]
`,
    );
    const build = await run(["docker", "build", "-t", IMAGE, ctx]);
    if (build.code !== 0) throw new Error(`docker build failed:\n${build.stderr}`);

    // 3. Run it, mapped to a random loopback port.
    await run(["docker", "rm", "-f", CONTAINER]); // clear a stale one
    const up = await run([
      "docker", "run", "-d", "--name", CONTAINER,
      "-p", "127.0.0.1::22", IMAGE,
    ]);
    if (up.code !== 0) throw new Error(`docker run failed:\n${up.stderr}`);
    started = true;

    const portOut = await run(["docker", "port", CONTAINER, "22"]);
    // e.g. "127.0.0.1:54321"
    sshPort = Number(portOut.stdout.trim().split(":").pop());
    expect(sshPort).toBeGreaterThan(0);

    // 4. Wait for sshd to accept our key.
    let ready = false;
    for (let i = 0; i < 30 && !ready; i++) {
      const r = await run([
        "ssh", "-i", keyPath,
        "-o", "BatchMode=yes",
        "-o", "StrictHostKeyChecking=no",
        "-o", "UserKnownHostsFile=/dev/null",
        "-p", String(sshPort), "root@127.0.0.1", "true",
      ]);
      if (r.code === 0) ready = true;
      else await Bun.sleep(500);
    }
    if (!ready) throw new Error("sshd never accepted the key");
  }, 180_000);

  afterAll(async () => {
    if (started) await run(["docker", "rm", "-f", CONTAINER]);
    if (tmp) await rm(tmp, { recursive: true, force: true });
  });

  test("provision: ships the payload, runs the installer, captures the token", async () => {
    // A fake "packaged bundle": a stub install.sh + a package.json, gzip-tarred
    // by the spawner and shipped to the box.
    const bundle = join(tmp, "bundle");
    await mkdir(join(bundle, "deploy"), { recursive: true });
    await writeFile(join(bundle, "deploy", "install.sh"), STUB_INSTALL_SH);
    await writeFile(join(bundle, "package.json"), '{"name":"stub"}\n');

    const registered: string[] = [];
    const mgr = new ProvisionManager({
      spawn: makeProvisionSpawner(),
      register: async (token) => {
        registered.push(token);
        return { id: "d-e2e" };
      },
      newId: () => "p1",
    });
    const id = mgr.start({
      kind: "provision",
      payloadRoot: bundle,
      mode: "packaged",
      target: {
        host: "127.0.0.1",
        user: "root",
        sshPort,
        identityPath: keyPath,
      },
    });
    await mgr.wait(id);

    const job = mgr.get(id)!;
    expect(job.status).toBe("done");
    // The stub printed a SUPERGIT_CONNECT marker; the manager captured it.
    expect(registered).toEqual(["supergit1:TESTTOKEN"]);
    // The source really landed on the box (binary stdin pipe + tar -x -z).
    expect((await dx(["test", "-f", "/opt/supergit/deploy/install.sh"])).code).toBe(0);
    // The stub install ran (--no-pull) and wrote its marker.
    expect((await dx(["test", "-f", "/opt/supergit/.installed"])).code).toBe(0);
  }, 60_000);

  test("uninstall: runs the uninstaller over ssh, then unregisters", async () => {
    // Ensure the stub is on the box (provision test placed it; be self-sufficient).
    await dx(["mkdir", "-p", "/opt/supergit/deploy"]);
    await run(
      ["docker", "exec", "-i", CONTAINER, "tee", "/opt/supergit/deploy/install.sh"],
      { stdin: STUB_INSTALL_SH },
    );
    await dx(["touch", "/opt/supergit/.installed"]);

    const unregistered: string[] = [];
    const mgr = new ProvisionManager({
      spawn: makeProvisionSpawner(),
      register: async () => ({ id: "x" }),
      unregister: async (daemonId) => {
        unregistered.push(daemonId);
      },
      newId: () => "u1",
    });
    const id = mgr.start({
      kind: "uninstall",
      daemonId: "d-e2e",
      payloadRoot: "",
      target: {
        host: "127.0.0.1",
        user: "root",
        sshPort,
        identityPath: keyPath,
        // The server route sets this; mirror it since we drive the manager
        // directly here. Without it the plan defaults to --no-pull.
        installArgs: ["--uninstall"],
      },
    });
    await mgr.wait(id);

    const job = mgr.get(id)!;
    expect(job.status).toBe("done");
    expect(unregistered).toEqual(["d-e2e"]); // forgot it locally
    // The stub uninstaller removed its marker on the box.
    expect((await dx(["test", "-f", "/opt/supergit/.installed"])).code).not.toBe(0);
  }, 60_000);
});
