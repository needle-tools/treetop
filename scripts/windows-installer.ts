import { appendFile, mkdir, open, readFile, rename, rm, lstat, readdir } from "node:fs/promises";
import { join, resolve, relative, isAbsolute } from "node:path";
import { dlopen, ptr } from "bun:ffi";
import { replaceInstallation, InstallationRecoveryError } from "./windows-installer-core";

async function command(args: string[], env = process.env): Promise<string> {
  const child = Bun.spawn(args, {env,windowsHide:true,stdin:"ignore",stdout:"pipe",stderr:"pipe"});
  const [out,err,code] = await Promise.all([new Response(child.stdout).text(),new Response(child.stderr).text(),child.exited]);
  if (code !== 0) throw Error(`${args[0]} exited ${code}: ${err.trim()}`);
  return out;
}
function dialog(message: string, error = false) {
  const dll=dlopen("user32.dll",{MessageBoxW:{args:["u64","ptr","ptr","u32"],returns:"i32"}});
  try { dll.symbols.MessageBoxW(0n,ptr(Buffer.from(message+"\0","utf16le")),ptr(Buffer.from("Treetop installer\0","utf16le")),error?0x10:0x40); }
  finally {dll.close();}
}
type InstalledProcess = {pid:number;name:string};
async function installedProcesses(app: string): Promise<InstalledProcess[]> {
  // A path boundary excludes other Treetop builds and the workspace broker.
  const out=await command(["powershell.exe","-NoProfile","-NonInteractive","-Command",
    "$ErrorActionPreference='Stop'; $prefix=$env:TREETOP_INSTALL_APP.TrimEnd('\\')+'\\'; $items=@(Get-Process | Where-Object { $_.Path -and $_.Path.StartsWith($prefix,[StringComparison]::OrdinalIgnoreCase) } | ForEach-Object { @{pid=$_.Id;name=$_.ProcessName} }); ConvertTo-Json -InputObject $items -Compress"],{...process.env,TREETOP_INSTALL_APP:app});
  const parsed=JSON.parse(out);
  if (!Array.isArray(parsed)) throw Error("Could not enumerate installation processes");
  return parsed;
}
async function waitFor(check:()=>Promise<boolean>, ms:number, description:string) {
  const until=Date.now()+ms;
  while(Date.now()<until) { if(await check())return; await Bun.sleep(250); }
  throw Error(description);
}
async function writeRequest(parent:string, request:unknown) {
  const path=join(parent,"update-request.json");
  await Bun.write(path+".tmp",JSON.stringify(request)); await rename(path+".tmp",path);
}
export async function handoffInstallation(parent:string, app:string, id:string, log:(s:string)=>Promise<void>) {
  const processes=await installedProcesses(app);
  if (!processes.length)return;
  const workers=processes.filter(p=>["bun","supergit"].includes(p.name.toLowerCase()));
  if (!workers.length) throw Error("An older Treetop process is locking the installation. No processes were stopped.");
  const request={id,phase:"prepare",expiresAt:Date.now()+120_000,pids:workers.map(p=>p.pid)};
  await log(`Preparing update for ${JSON.stringify(processes)}`);
  await writeRequest(parent,request);
  await waitFor(async()=>{
    const states=await Promise.all(workers.map(async p=>{
      try {return JSON.parse(await readFile(join(parent,`update-${id}-${p.pid}.json`),"utf8"));}
      catch(error:any){if(error.code==="ENOENT")return null;throw error;}
    }));
    const failure=states.find(s=>s?.state==="error");
    if(failure)throw Error(`Treetop declined the update: ${failure.error}`);
    return states.every((s,i)=>s?.id===id && s.pid===workers[i]!.pid && s.state==="ready");
  },15_000,"The running Treetop version does not support a safe update handoff, or did not respond. The installation was left unchanged and no processes were force-stopped. Close the old Treetop window/tray hosts and daemon before retrying; keep the workspace terminal-broker running to retain its sessions.");
  // Close UIs first so their window state is saved while the daemon is alive.
  await writeRequest(parent,{...request,phase:"exit",pids:workers.filter(p=>p.name.toLowerCase()==="bun").map(p=>p.pid)});
  await waitFor(async()=>!(await installedProcesses(app)).some(p=>p.name.toLowerCase()!=="supergit"),15_000,"Treetop windows or another process still hold installation files. Update cancelled.");
  await writeRequest(parent,{...request,phase:"exit",pids:workers.filter(p=>p.name.toLowerCase()==="supergit").map(p=>p.pid)});
  await waitFor(async()=>!(await installedProcesses(app)).length,15_000,"The daemon did not release its installation files. Update cancelled.");
  await log("All installation processes exited; session broker was not stopped.");
}
async function validateBundle(root:string) {
  for(const file of ["bin/launcher.exe","bin/bun.exe","bin/libNativeWrapper.dll","Resources/app/bun/index.js","Resources/app/supergit.exe","Resources/app/terminal-broker.exe","Resources/app/pty-helper.exe"]) {
    const stat=await lstat(join(root,file)); if(!stat.isFile()||stat.size===0)throw Error(`Incomplete installation: ${file}`);
  }
  const info=JSON.parse(await readFile(join(root,"Resources/app/build-info.json"),"utf8"));
  if(!Number.isFinite(Date.parse(info.buildTime)))throw Error("Invalid build metadata");
  return info.buildTime as string;
}
async function removeOwned(parent:string,path:string) {
  const rel=relative(resolve(parent),resolve(path));
  if(!rel || rel.startsWith("..")||isAbsolute(rel))throw Error("Refusing cleanup outside installer directory");
  await rm(path,{recursive:true,force:true});
}

/** Called only by the packaged setup executable, never when imported by tests. */
export async function runInstaller(payload:string,expectedHash:string) {
  // Packaging verification must never touch the installed app or show dialogs.
  if(process.argv.includes("--verify-payload")) {
    const hash=new Bun.CryptoHasher("sha256").update(await Bun.file(payload).arrayBuffer()).digest("hex");
    if(hash!==expectedHash)throw Error("Embedded installer payload checksum failed");
    console.log("Embedded installer payload verified");
    return;
  }
  const parent=join(process.env.LOCALAPPDATA!,"tools.needle.supergit","stable");
  const app=join(parent,"app"),id=crypto.randomUUID(),stage=join(parent,`update-stage-${id}`);
  const logPath=join(parent,"installer.log"), backup=join(parent,`previous-${id}`);
  await mkdir(parent,{recursive:true});
  const log=async(s:string)=>{await appendFile(logPath,`[${new Date().toISOString()}] ${s}\n`);};
  let lock:Awaited<ReturnType<typeof open>>|undefined,installed=false,handoffStarted=false;
  const launch=()=>{
    const child=Bun.spawn([join(app,"bin/launcher.exe")],{cwd:join(app,"bin"),detached:true,windowsHide:true,stdin:"ignore",stdout:"ignore",stderr:"ignore"});
    child.unref();
    return child;
  };
  try {
    // Fail closed on a crashed installer's lock; never guess its ownership.
    lock=await open(join(parent,"installer.lock"),"wx");
    await lock.writeFile(JSON.stringify({pid:process.pid,id}));
    await log(`Starting installer ${id}`);
    const bytes=await Bun.file(payload).arrayBuffer();
    if(new Bun.CryptoHasher("sha256").update(bytes).digest("hex")!==expectedHash)throw Error("Installer payload checksum failed");
    await mkdir(stage);
    const archive=join(stage,"payload.tar.zst"); await Bun.write(archive,bytes);
    const listing=await command(["tar.exe","-tf",archive]);
    for(const name of listing.trim().split(/\r?\n/)) {
      if(!name.startsWith("Treetop/") || name.includes("\\") || name.split("/").includes(".."))throw Error("Unsafe archive entry");
    }
    await command(["tar.exe","-xf",archive,"-C",stage]);
    const staged=join(stage,"Treetop"),buildTime=await validateBundle(staged);
    await log(`Validated staged build ${buildTime}`);
    handoffStarted=true;
    await handoffInstallation(parent,app,id,log);
    await replaceInstallation({app,staged,backup,log,
      assertStopped:async()=>{if((await installedProcesses(app)).length)throw Error("Treetop relaunched during installation; update cancelled");},
      verify:async()=>{if(await validateBundle(app)!==buildTime)throw Error("Installed build verification failed");},
    });
    installed=true;
    await log(`Installed and verified ${buildTime}; rollback retained at ${backup}`);
    // Shortcuts always target the canonical app path, not staging or the installer.
    await command(["powershell.exe","-NoProfile","-NonInteractive","-Command",
      "$ErrorActionPreference='Stop'; $w=New-Object -ComObject WScript.Shell; foreach($folder in @([Environment]::GetFolderPath('Desktop'),[Environment]::GetFolderPath('Programs'))) { $s=$w.CreateShortcut((Join-Path $folder 'Treetop.lnk')); $s.TargetPath=Join-Path $env:TREETOP_INSTALL_APP 'bin\\launcher.exe'; $s.WorkingDirectory=Join-Path $env:TREETOP_INSTALL_APP 'bin'; $s.IconLocation=$s.TargetPath; $s.Save() }"],{...process.env,TREETOP_INSTALL_APP:app});
    // Keep just the latest rollback. Old backups must be unused before removal.
    for(const entry of await readdir(parent,{withFileTypes:true})) {
      const path=join(parent,entry.name);
      if(entry.isDirectory() && /^previous-[0-9a-f-]{36}$/.test(entry.name) && path!==backup && !(await installedProcesses(path)).length)
        await removeOwned(parent,path).catch(error=>log(`Old rollback cleanup deferred: ${error}`));
    }
    await removeOwned(parent,stage);
    await rm(join(parent,"update-request.json"),{force:true});
    // Reconnect before a modal success dialog: leaving that dialog open must
    // not consume the broker's fifteen-minute absence lease.
    launch();
    dialog(`Treetop updated successfully.\nBuild: ${buildTime}\n\nYour background broker was not stopped. Treetop is reopening.\n\nLog: ${logPath}`);
  } catch(error) {
    if(lock) await rm(join(parent,"update-request.json"),{force:true});
    await log(`ERROR installed=${installed}: ${error}`);
    if(handoffStarted && !(error instanceof InstallationRecoveryError)) {
      try {
        if(!(await installedProcesses(app)).some(p=>["bun","launcher"].includes(p.name.toLowerCase()))) {
          await validateBundle(app); launch(); await log("Reopened the available installation after update failure");
        }
      } catch(recoveryError) {await log(`Could not reopen installation: ${recoveryError}`);}
    }
    if(lock && !(error instanceof InstallationRecoveryError)) await removeOwned(parent,stage).catch(cleanupError=>log(`Staging cleanup deferred: ${cleanupError}`));
    dialog(`${installed?"The new build was installed, but a finishing step failed.":"Treetop update did not complete."}\n\n${error}\n\nLog: ${logPath}`,true);
    process.exitCode=1;
  } finally {
    if(lock) {
      await rm(join(parent,"update-request.json"),{force:true});
      for(const entry of await readdir(parent))if(entry.startsWith(`update-${id}-`))await rm(join(parent,entry),{force:true});
      await lock.close(); await rm(join(parent,"installer.lock"),{force:true});
    }
  }
}
