import { resolve, join } from "node:path";
import { setWindowsGuiSubsystem } from "./build-native-options";
import { mkdir, cp, chmod, rm } from "node:fs/promises";
import { macInstallerWindowSource } from "./installer-progress";

/** Replace Electrobun's delete-and-copy extractor with our checked installer.
 * The compressed app is embedded so Setup.exe remains standalone. */
export async function packageWindowsInstaller(root:string) {
  const directory=resolve(root,"build/stable-win-x64");
  const payload=join(directory,"Treetop-Setup.tar.zst");
  const hash=new Bun.CryptoHasher("sha256").update(await Bun.file(payload).arrayBuffer()).digest("hex");
  const entry=join(directory,"installer-entry.ts");
  await Bun.write(entry,`import payload from ${JSON.stringify(payload)} with { type: "file" };\nimport splash from ${JSON.stringify(resolve(root,"packages/ui/public/treetop-splash.png"))} with { type: "file" };\nimport {runInstaller} from ${JSON.stringify(resolve(root,"scripts/windows-installer.ts"))};\nawait runInstaller(payload,${JSON.stringify(hash)},splash);\n`);
  const child=Bun.spawn([process.execPath,"build",entry,"--compile","--windows-hide-console",`--outfile=${join(directory,"Treetop-Setup.exe")}`],{windowsHide:true,stdout:"inherit",stderr:"inherit"});
  if(await child.exited!==0)throw Error("Could not compile the safe Windows installer");
  await setWindowsGuiSubsystem(join(directory,"Treetop-Setup.exe"));
}

export async function archiveWindowsInstaller(root:string) {
  // Repack after icon stamping. Never distribute the SDK's original extractor.
  const output=resolve(root,"artifacts/stable-win-x64-Treetop-Setup.zip");
  const child=Bun.spawn(["tar.exe","-a","-cf",output,"Treetop-Setup.exe"],{
    cwd:resolve(root,"build/stable-win-x64"),windowsHide:true,stdout:"inherit",stderr:"inherit",
  });
  if(await child.exited!==0)throw Error("Could not package the safe Windows installer ZIP");
}

/** Built on macOS: a standalone installer app and DMG with no developer-tool
 * dependency on the destination Mac. The shared installer owns the update. */
export async function packageMacInstaller(root: string, app: string) {
  if (process.platform !== "darwin") throw Error("macOS installer packaging requires a Mac");
  const directory = resolve(app, "..");
  const bundle = join(directory, "Treetop-Setup.app");
  const resources = join(bundle, "Contents/Resources"), bin = join(bundle, "Contents/MacOS");
  await Promise.all([mkdir(resources, {recursive:true}), mkdir(bin, {recursive:true}), mkdir(join(root,"artifacts"),{recursive:true})]);
  const run = async (args: string[]) => {
    const child = Bun.spawn(args, {cwd:root, env:{...process.env,COPYFILE_DISABLE:"1"}, windowsHide:true, stdin:"ignore", stdout:"inherit", stderr:"inherit"});
    if (await child.exited !== 0) throw Error(`Installer packaging failed: ${args[0]}`);
  };
  const payload = join(directory,"installer-payload.tar.gz");
  await run(["/usr/bin/tar","-czf",payload,"-C",directory,"Treetop.app"]);
  const swift = join(directory,"installer-window.swift"), helper = join(resources,"installer-window");
  await Bun.write(swift, macInstallerWindowSource);
  const target = process.arch === "arm64" ? "arm64-apple-macosx13.0" : "x86_64-apple-macosx13.0";
  await run(["/usr/bin/xcrun","swiftc",swift,"-target",target,"-framework","AppKit","-O","-o",helper]);
  await run(["/usr/bin/codesign","--force","--sign","-",helper]);
  const hash = new Bun.CryptoHasher("sha256").update(await Bun.file(payload).arrayBuffer()).digest("hex");
  const entry = join(directory,"mac-installer-entry.ts");
  await Bun.write(entry, `import payload from ${JSON.stringify(payload)} with {type:"file"};
import splash from ${JSON.stringify(resolve(root,"packages/ui/public/treetop-splash.png"))} with {type:"file"};
import helper from ${JSON.stringify(helper)} with {type:"file"};
import {runInstaller} from ${JSON.stringify(resolve(root,"scripts/windows-installer.ts"))};
await runInstaller(payload,${JSON.stringify(hash)},splash,helper);
`);
  const executable = join(bin,"Treetop-Setup");
  await run([process.execPath,"build",entry,"--compile",`--outfile=${executable}`]);
  await chmod(executable,0o755);
  await Bun.write(join(bundle,"Contents/Info.plist"), `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict>
<key>CFBundleExecutable</key><string>Treetop-Setup</string>
<key>CFBundleIdentifier</key><string>tools.needle.supergit.installer</string>
<key>CFBundleName</key><string>Treetop installer</string>
<key>CFBundlePackageType</key><string>APPL</string>
<key>CFBundleVersion</key><string>1</string>
<key>LSMinimumSystemVersion</key><string>13.0</string>
<key>NSHighResolutionCapable</key><true/>
</dict></plist>`);
  await run(["/usr/bin/codesign","--force","--deep","--sign","-",bundle]);
  const dmgRoot = join(directory,"installer-dmg");
  await mkdir(dmgRoot,{recursive:true});
  await cp(bundle,join(dmgRoot,"Treetop-Setup.app"),{recursive:true});
  const dmg=resolve(root,`artifacts/stable-macos-${process.arch}-Treetop-Setup.dmg`);
  await rm(dmg,{force:true});
  await run(["/usr/bin/hdiutil","create","-volname","Treetop installer","-srcfolder",dmgRoot,"-ov","-format","UDZO",dmg]);
  return {bundle,dmg};
}
