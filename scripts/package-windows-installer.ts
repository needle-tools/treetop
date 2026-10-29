import { resolve, join } from "node:path";
import { setWindowsGuiSubsystem } from "./build-native-options";

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
