// Electrobun wraps `build/supergit-native/` (produced by `bun run build:native`)
// into a native app bundle per platform. The flat layout differs by OS:
//   macOS / Linux: `supergit`, `pty-helper`
//   Windows:       `supergit.exe`, `pty-helper.exe`
// We branch the copy: map accordingly and keep .exe files out of the asar
// (asarUnpack) so the daemon can spawn pty-helper.exe as a child process.

import type { ElectrobunConfig } from "electrobun";

const isWin = process.platform === "win32";
const exe = isWin ? ".exe" : "";

export default {
  app: {
    name: "Treetop",
    identifier: "tools.needle.supergit",
    version: "0.1.8",
  },
  // Runtime is top-level: Electrobun copies this into Resources/build.json.
  // The native tray/menu-bar owner must survive closing the last window.
  runtime: { exitOnLastWindowClosed: false },
  build: {
    // The SDK default (1.3.13) corrupts the VM heap when WebView2 invokes
    // threadsafe FFI callbacks. Use the fixed runtime (oven-sh/bun#31332).
    bunVersion: "1.4.4",
    bun: {
      entrypoint: "src/electrobun/index.ts",
    },
    mac: {
      icons: "icon.iconset",
      entitlements: {
        "com.apple.security.device.audio-input":
          "Treetop uses the microphone for global voice mode.",
      },
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
      "*.node",
      "*.dll",
      "*.dylib",
      "*.so",
      "*.exe",
      "ui/**",
      "tray.png",
      "tray.ico",
      // Unpack the daemon + pty-helper by exact name (no extension on
      // mac/linux, with .exe on Windows — both patterns are harmless on
      // platforms where the file doesn't exist).
      "supergit",
      "supergit.exe",
      "pty-helper",
      "pty-helper.exe",
      "terminal-broker",
      "terminal-broker.exe",
      // Source tree the daemon tars + ships to provision a remote box.
      // Must live on a real filesystem (read via existsSync), so unpack it
      // like ui/**. Absent when the build couldn't bundle it (best-effort).
      "install-payload/**",
    ],
    copy: {
      // SVG-derived transparent template at 4x the menu-bar point size.
      "tray.png": "tray.png",
      "icon.ico": "tray.ico",
      [`build/supergit-native/supergit${exe}`]: `supergit${exe}`,
      [`build/supergit-native/pty-helper${exe}`]: `pty-helper${exe}`,
      [`build/supergit-native/terminal-broker${exe}`]: `terminal-broker${exe}`,
      "build/supergit-native/ui": "ui",
      "build/supergit-native/build-info.json": "build-info.json",
      "build/supergit-native/install-payload": "install-payload",
    },
  },
} satisfies ElectrobunConfig;
