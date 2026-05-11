// Starts the daemon (watch mode) and UI (Vite dev server) together
// with hot reload. Ctrl-C kills both.

const daemon = Bun.spawn(["bun", "--watch", "run", "src/server.ts"], {
  cwd: "packages/daemon",
  stdout: "inherit",
  stderr: "inherit",
});

const ui = Bun.spawn(["bun", "run", "dev"], {
  cwd: "packages/ui",
  stdout: "inherit",
  stderr: "inherit",
});

const cleanup = () => {
  daemon.kill();
  ui.kill();
  process.exit(0);
};

process.on("SIGINT", cleanup);
process.on("SIGTERM", cleanup);

await Promise.all([daemon.exited, ui.exited]);
