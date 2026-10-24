/** Kernel/job or pipe ownership also covers an unexpected broker crash. This
 * runs only in the standalone broker, never in a daemon or the test runner. */
export async function protectBrokerChildren(log: (message: string) => void) {
  if (process.platform === "win32") {
    const { dlopen, FFIType, ptr } = await import("bun:ffi");
    const api = dlopen("kernel32.dll", {
      GetConsoleWindow: { args: [], returns: FFIType.u64 },
      CreateJobObjectW: {
        args: [FFIType.u64, FFIType.u64],
        returns: FFIType.u64,
      },
      SetInformationJobObject: {
        args: [FFIType.u64, FFIType.u32, FFIType.u64, FFIType.u32],
        returns: FFIType.i32,
      },
      AssignProcessToJobObject: {
        args: [FFIType.u64, FFIType.u64],
        returns: FFIType.i32,
      },
      CloseHandle: { args: [FFIType.u64], returns: FFIType.i32 },
    });
    log(
      `background process consoleAttached=${api.symbols.GetConsoleWindow() !== 0n}`,
    );
    const job = api.symbols.CreateJobObjectW(0n, 0n);
    if (!job) throw new Error("Cannot create broker process ownership job");
    const limits = new Uint8Array(144);
    new DataView(limits.buffer).setUint32(16, 0x2000, true); // JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE
    if (
      !api.symbols.SetInformationJobObject(
        job,
        9,
        BigInt(ptr(limits)),
        limits.length,
      ) ||
      !api.symbols.AssignProcessToJobObject(job, BigInt.asUintN(64, -1n))
    ) {
      api.symbols.CloseHandle(job);
      throw new Error(
        "Cannot establish broker process ownership; refusing unprotected background processes",
      );
    }
    // Keep both DLL and the non-inheritable job handle alive. The kernel closes
    // it on process death and terminates all descendants assigned to this job.
    log(
      "Windows job ownership established; broker death terminates owned descendants",
    );
    return { job, api };
  }
  // The broker is launched detached as its own session/process-group leader.
  // A tiny detached guard sees pipe EOF even on SIGKILL and reaps that group.
  // It owns no user command and exits immediately after confirmed cleanup.
  const group = process.pid;
  const script = `cat >/dev/null; /bin/kill -TERM -- -${group} 2>/dev/null; sleep 1; /bin/kill -KILL -- -${group} 2>/dev/null; exit 0`;
  const guard = Bun.spawn(["/bin/sh", "-c", script], {
    detached: true,
    stdin: "pipe",
    stdout: "ignore",
    stderr: "ignore",
  });
  guard.unref();
  log(`process-group crash guard started pid=${guard.pid} group=${group}`);
  return guard;
}
