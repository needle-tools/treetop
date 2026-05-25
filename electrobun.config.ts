// Electrobun wraps `build/supergit-native/` (produced by `bun run build:native`)
// into a native app bundle per platform. The flat layout differs by OS:
//   macOS / Linux: `supergit`, `pty-helper`
//   Windows:       `supergit.exe`, `pty-helper.exe`
// We branch the copy: map accordingly and keep .exe files out of the asar
// (asarUnpack) so the daemon can spawn pty-helper.exe as a child process.

const isWin = process.platform === "win32";
const exe = isWin ? ".exe" : "";

export default {
  app: {
    name: "Supergit",
    identifier: "tools.needle.supergit",
    version: "0.1.0",
  },
  build: {
    bun: {
      entrypoint: "src/electrobun/index.ts",
    },
    mac: {
      icons: "icon.iconset",
    },
    win: {
      icon: "icon.ico",
    },
    // Keep native executables AND the UI directory on disk (extracted
    // from asar). `*.exe` is for the Windows daemon + pty-helper; `ui/**`
    // is so the daemon can serve static SPA files via existsSync/read
    // (the asar isn't a real filesystem). Default electrobun unpack
    // already covers *.node/*.dll/*.dylib/*.so.
    asarUnpack: [
      "*.node", "*.dll", "*.dylib", "*.so", "*.exe",
      "ui/**",
      // Unpack the daemon + pty-helper by exact name (no extension on
      // mac/linux, with .exe on Windows — both patterns are harmless on
      // platforms where the file doesn't exist).
      "supergit", "supergit.exe",
      "pty-helper", "pty-helper.exe",
    ],
    copy: {
      [`build/supergit-native/supergit${exe}`]: `supergit${exe}`,
      [`build/supergit-native/pty-helper${exe}`]: `pty-helper${exe}`,
      "build/supergit-native/ui": "ui",
      "build/supergit-native/build-info.json": "build-info.json",
    },
  },
};
