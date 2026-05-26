import { resolve } from "node:path";

const port = process.env.SUPERGIT_PORT ?? "27787";
const delayMs = Number(process.env.SUPERGIT_RELAUNCH_DELAY_MS ?? "2000");
const waitForShutdownMs = Number(process.env.SUPERGIT_RELAUNCH_WAIT_MS ?? "15000");
const logPath = process.env.SUPERGIT_RELAUNCH_LOG ?? "/tmp/supergit-build-launch.log";
const buildScript = process.env.SUPERGIT_RELAUNCH_BUILD_SCRIPT ?? "build";
const appBundleId = process.env.SUPERGIT_APP_BUNDLE_ID ?? "tools.needle.supergit";
const appPath = process.env.SUPERGIT_APP_PATH ?? defaultAppPath();

function defaultAppPath(): string {
  if (process.platform === "darwin") {
    const macArch = process.arch === "arm64" ? "macos-arm64" : "macos-x64";
    return resolve(`build/stable-${macArch}/Supergit.app`);
  }
  if (process.platform === "win32") {
    return resolve("build/stable-win-x64/Supergit.exe");
  }
  return resolve("build/stable-linux-x64/Supergit");
}

async function runBuild(): Promise<void> {
  const build = Bun.spawn([process.execPath, "run", buildScript], {
    stdout: "inherit",
    stderr: "inherit",
    stdin: "inherit",
    env: {
      ...process.env,
      SUPERGIT_BUILD_OPEN_OUTPUT: "0",
    },
  });
  const code = await build.exited;
  if (code !== 0) {
    throw new Error(`build failed with exit code ${code}`);
  }
}

function scheduleLaunch(): void {
  const relauncher = Bun.spawn([
    process.execPath,
    "--eval",
    `
      const net = await import("node:net");
      const { existsSync } = await import("node:fs");
      const { appendFileSync } = await import("node:fs");
      const delayMs = Number(process.env.SUPERGIT_RELAUNCH_DELAY_MS ?? "2000");
      const waitForShutdownMs = Number(process.env.SUPERGIT_RELAUNCH_WAIT_MS ?? "15000");
      const logPath = process.env.SUPERGIT_RELAUNCH_LOG ?? "/tmp/supergit-build-launch.log";
      const port = process.env.SUPERGIT_PORT ?? "27787";
      const url = "http://localhost:" + port;
      const appPath = process.env.SUPERGIT_APP_PATH;
      const appBundleId = process.env.SUPERGIT_APP_BUNDLE_ID ?? "tools.needle.supergit";

      function log(message) {
        appendFileSync(logPath, new Date().toISOString() + " " + message + "\\n");
      }

      async function appendStream(readable) {
        const reader = readable.getReader();
        const decoder = new TextDecoder();
        while (true) {
          const { done, value } = await reader.read();
          if (done) {
            const rest = decoder.decode();
            if (rest) appendFileSync(logPath, rest);
            return;
          }
          appendFileSync(logPath, decoder.decode(value, { stream: true }));
        }
      }

      async function runLogged(cmd, args) {
        log("$ " + [cmd, ...args].join(" "));
        const child = Bun.spawn([cmd, ...args], {
          stdout: "pipe",
          stderr: "pipe",
          stdin: "ignore",
        });
        const stdout = appendStream(child.stdout);
        const stderr = appendStream(child.stderr);
        const code = await child.exited;
        await Promise.allSettled([stdout, stderr]);
        log(cmd + " exited with code " + code);
        return code ?? 1;
      }

      async function portIsOpen() {
        return await new Promise((resolve) => {
          const socket = net.createConnection({ host: "127.0.0.1", port: Number(port) });
          const finish = (open) => {
            socket.destroy();
            resolve(open);
          };
          socket.once("connect", () => finish(true));
          socket.once("error", () => finish(false));
          socket.setTimeout(500, () => finish(false));
        });
      }

      async function appIsRunning() {
        if (process.platform !== "darwin") return false;
        const child = Bun.spawn([
          "osascript",
          "-e",
          "application id " + JSON.stringify(appBundleId) + " is running",
        ], {
          stdout: "pipe",
          stderr: "ignore",
          stdin: "ignore",
        });
        const stdout = await new Response(child.stdout).text();
        await child.exited;
        return stdout.trim() === "true";
      }

      async function quitApp() {
        if (process.platform !== "darwin") return;
        if (!(await appIsRunning())) {
          log("app is not running");
          return;
        }
        log("quitting Supergit app");
        await runLogged("osascript", [
          "-e",
          "ignoring application responses",
          "-e",
          "tell application id " + JSON.stringify(appBundleId) + " to quit",
          "-e",
          "end ignoring",
        ]);
        const deadline = Date.now() + waitForShutdownMs;
        while (await appIsRunning()) {
          if (Date.now() >= deadline) {
            log("app is still running after quit request");
            return;
          }
          await Bun.sleep(250);
        }
        log("app stopped");
      }

      async function shutdownDaemon() {
        try {
          const res = await fetch(url + "/api/shutdown", {
            method: "POST",
            signal: AbortSignal.timeout(3000),
          });
          log("daemon shutdown request returned HTTP " + res.status);
        } catch (err) {
          log("daemon shutdown request failed: " + (err?.message ?? err));
        }
      }

      async function waitForPortClosed() {
        const deadline = Date.now() + waitForShutdownMs;
        while (await portIsOpen()) {
          if (Date.now() >= deadline) return false;
          await Bun.sleep(250);
        }
        return true;
      }

      async function launchApp() {
        if (!appPath || !existsSync(appPath)) {
          log("app path does not exist: " + appPath);
          process.exit(1);
        }
        if (process.platform === "darwin") {
          const code = await runLogged("open", ["-n", appPath]);
          process.exit(code === 0 ? 0 : code);
        }
        if (process.platform === "win32") {
          const code = await runLogged("cmd.exe", ["/c", "start", "", appPath]);
          process.exit(code === 0 ? 0 : code);
        }
        const code = await runLogged("xdg-open", [appPath]);
        process.exit(code === 0 ? 0 : code);
      }

      log("waiting " + delayMs + "ms before relaunch");
      await Bun.sleep(delayMs);
      await quitApp();
      await shutdownDaemon();
      if (!(await waitForPortClosed())) {
        log("port " + port + " is still in use; not starting a second Supergit");
        process.exit(1);
      }
      log("launching Supergit app");
      await launchApp();
    `,
  ], {
    stdout: "ignore",
    stderr: "ignore",
    stdin: "ignore",
    detached: true,
    env: {
      ...process.env,
      SUPERGIT_RELAUNCH_DELAY_MS: String(delayMs),
      SUPERGIT_RELAUNCH_WAIT_MS: String(waitForShutdownMs),
      SUPERGIT_RELAUNCH_LOG: logPath,
      SUPERGIT_APP_BUNDLE_ID: appBundleId,
      SUPERGIT_APP_PATH: appPath,
    },
  });
  relauncher.unref();
}

await runBuild();
scheduleLaunch();
console.log(`supergit: scheduled app relaunch in ${delayMs}ms`);
console.log(`supergit: app path ${appPath}`);
console.log(`supergit: relaunch log ${logPath}`);

export {};
