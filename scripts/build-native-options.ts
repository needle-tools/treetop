import { open } from "node:fs/promises";
// ssh2 catches a missing CPU detector and uses its normal crypto defaults.
// Keep this optional native addon out of the standalone daemon bundle.
export const DAEMON_BUILD_EXTERNALS = ["cpu-features"];

// Background executables must not allocate a console or Windows Terminal host.
// A spawn-time windowsHide flag alone does not change the executable subsystem.
export const NATIVE_BACKGROUND_COMPILE_ARGS =
  process.platform === "win32" ? ["--windows-hide-console"] : [];

/** Set the Windows GUI subsystem before packaging our own background binaries.
 * Bun's hide-console flag can leave a console-subsystem PE in 1.3.14; the OS
 * must not create a console host before JavaScript startup gets to hide it. */
export async function setWindowsGuiSubsystem(path: string): Promise<void> {
  const file = await open(path, "r+");
  try {
    const dos = Buffer.alloc(64);
    await file.read(dos, 0, dos.length, 0);
    if (dos.readUInt16LE(0) !== 0x5a4d)
      throw new Error("Not a Windows executable: " + path);
    const peOffset = dos.readUInt32LE(0x3c);
    const header = Buffer.alloc(96);
    await file.read(header, 0, header.length, peOffset);
    if (
      header.readUInt32LE(0) !== 0x4550 ||
      ![0x10b, 0x20b].includes(header.readUInt16LE(24))
    )
      throw new Error("Invalid PE header: " + path);
    const subsystem = Buffer.alloc(2);
    subsystem.writeUInt16LE(2); // IMAGE_SUBSYSTEM_WINDOWS_GUI: no console allocation.
    await file.write(subsystem, 0, 2, peOffset + 24 + 68);
  } finally {
    await file.close();
  }
}
