import { test, expect } from "bun:test";
import { mkdtemp, mkdir, writeFile, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { UpdateHandoff, updateInstallParent, watchForUpdate } from "../../../src/electrobun/update-handoff";
import { replaceInstallation } from "../../../scripts/windows-installer-core";

test("only installed UI and daemon participate, never the workspace broker or dev Bun", () => {
  expect(updateInstallParent("C:\\Apps\\stable\\app\\bin\\bun.exe","ui")).toBe("C:\\Apps\\stable");
  expect(updateInstallParent("C:\\Apps\\stable\\app\\Resources\\app\\supergit.exe","daemon")).toBe("C:\\Apps\\stable");
  expect(updateInstallParent("C:\\workspace\\runtime\\broker.exe","daemon")).toBeUndefined();
  expect(updateInstallParent("C:\\bun\\bun.exe","ui")).toBeUndefined();
});

test("file handoff publishes readiness and cancellation leaves the process alive", async () => {
  const parent=await mkdtemp(join(tmpdir(),"treetop-update-ipc-"));
  let exits=0;
  const stop=watchForUpdate(parent,{prepare:()=>{},exit:()=>{exits++;},log:()=>{}});
  try {
    await writeFile(join(parent,"update-request.json"),JSON.stringify({id:"file-test",expiresAt:Date.now()+10_000,pids:[process.pid],phase:"prepare"}));
    const response=join(parent,`update-file-test-${process.pid}.json`);
    let state:any;
    for(let i=0;i<30;i++){try{state=JSON.parse(await readFile(response,"utf8"));break;}catch{await Bun.sleep(100);}}
    expect(state?.state).toBe("ready");
    await rm(join(parent,"update-request.json"));
    await Bun.sleep(600);
    expect(exits).toBe(0);
  } finally {stop();await rm(parent,{recursive:true,force:true});}
});

test("update handoff prepares before exiting, and ignores other PIDs and expired requests", async () => {
  const actions: string[] = [];
  const handoff = new UpdateHandoff(42, () => actions.push("prepare"), () => actions.push("exit"));
  const request = { id: "fixture", expiresAt: Date.now() + 10_000, phase: "prepare", pids: [42] };
  expect(await handoff.handle({...request, pids: [43]})).toBeUndefined();
  expect(await handoff.handle({...request, expiresAt: 0})).toBeUndefined();
  expect(await handoff.handle({...request, phase: "exit"})).toBeUndefined();
  expect(await handoff.handle(request)).toBe("ready");
  expect(await handoff.handle(request)).toBe("ready");
  expect(actions).toEqual(["prepare"]);
  expect(await handoff.handle({...request, phase: "exit"})).toBe("exiting");
  await handoff.handle({...request, phase: "exit"});
  expect(actions).toEqual(["prepare", "exit"]);
});

test("failed broker preparation never authorizes update exit", async () => {
  let exited = false;
  const handoff = new UpdateHandoff(42, () => { throw Error("Broker unavailable"); }, () => {exited=true;});
  const request = {id:"fixture", expiresAt:Date.now()+10_000, pids:[42], phase:"prepare"};
  await expect(handoff.handle(request)).rejects.toThrow("Broker unavailable");
  expect(await handoff.handle({...request,phase:"exit"})).toBeUndefined();
  expect(exited).toBe(false);
});

test("installation leaves locked app intact, replaces atomically, and rolls back verification failure", async () => {
  const root = await mkdtemp(join(tmpdir(), "treetop-update-test-"));
  const app=join(root,"app"), staged=join(root,"staged"), backup=join(root,"previous");
  try {
    await mkdir(app); await mkdir(staged);
    await writeFile(join(app,"version"),"old"); await writeFile(join(staged,"version"),"new");
    await expect(replaceInstallation({app, staged, backup, assertStopped:async()=>{throw Error("still running");}, verify:async()=>{}})).rejects.toThrow("still running");
    expect(await readFile(join(app,"version"),"utf8")).toBe("old");
    await expect(replaceInstallation({app, staged, backup, assertStopped:async()=>{}, verify:async()=>{throw Error("invalid build");}})).rejects.toThrow("invalid build");
    expect(await readFile(join(app,"version"),"utf8")).toBe("old");
    await replaceInstallation({app, staged, backup, assertStopped:async()=>{}, verify:async()=>{}});
    expect(await readFile(join(app,"version"),"utf8")).toBe("new");
    expect(await readFile(join(backup,"version"),"utf8")).toBe("old");
  } finally { await rm(root,{recursive:true,force:true}); }
});

if (process.platform === "win32") {
  for (const failVerification of [false, true]) {
    test(`installation preserves a helper holding app/bin as cwd; rollback=${failVerification}`, async () => {
      const root = await mkdtemp(join(tmpdir(), "treetop-update-cwd-"));
      const app=join(root,"app"), staged=join(root,"staged"), backup=join(root,"previous");
      await mkdir(join(app,"bin"),{recursive:true});
      await mkdir(join(staged,"bin"),{recursive:true});
      await writeFile(join(app,"bin","version"),"old");
      await writeFile(join(staged,"bin","version"),"new");
      const holder=Bun.spawn([process.execPath,"-e","console.log('ready');setInterval(()=>{},1000)"],{cwd:join(app,"bin"),stdout:"pipe",stderr:"pipe",windowsHide:true});
      try {
        const reader=holder.stdout.getReader();
        await reader.read(); reader.releaseLock();
        const transaction=replaceInstallation({app,staged,backup,assertStopped:async()=>{},verify:async()=>{if(failVerification)throw Error("invalid build");}});
        if(failVerification)await expect(transaction).rejects.toThrow("invalid build");
        else await transaction;
        expect(await readFile(join(app,"bin","version"),"utf8")).toBe(failVerification?"old":"new");
        if(!failVerification)expect(await readFile(join(backup,"bin","version"),"utf8")).toBe("old");
        expect(holder.exitCode).toBeNull();
      } finally { holder.kill();await holder.exited;await rm(root,{recursive:true,force:true}); }
    });
  }
}

test("installer launch reports early exit and retains native stderr", async () => {
  const { launchInstallerApp } = await import("../../../scripts/windows-installer-core");
  const root = await mkdtemp(join(tmpdir(), "treetop-launch-test-"));
  try {
    const log = join(root,"launch.log");
    await expect(launchInstallerApp(process.execPath, root, log, ["-e", "console.error('fixture startup error');process.exit(7)"], 1000)).rejects.toThrow("7");
    expect(await readFile(log,"utf8")).toContain("fixture startup error");
  } finally { await rm(root,{recursive:true,force:true}); }
});

test("installer launch returns after observation without stopping a healthy app", async () => {
  const { launchInstallerApp } = await import("../../../scripts/windows-installer-core");
  const root = await mkdtemp(join(tmpdir(), "treetop-launch-live-"));
  try {
    const marker=join(root,"finished");
    const pid=await launchInstallerApp(process.execPath,root,join(root,"launch.log"),["-e",`setTimeout(()=>require('fs').writeFileSync(${JSON.stringify(marker)},'alive'),500)`],100);
    expect(pid).toBeGreaterThan(0);
    for(let i=0;i<30;i++){try{await readFile(marker);break;}catch{await Bun.sleep(100);}}
    expect(await readFile(marker,"utf8")).toBe("alive");
    await Bun.sleep(200);
  } finally {await rm(root,{recursive:true,force:true});}
});


test("installer waits for readiness and retries only confirmed pre-ready exits", async () => {
  const { launchInstallerApp } = await import("../../../scripts/windows-installer-core");
  const root = await mkdtemp(join(tmpdir(), "treetop-ready-test-"));
  try {
    const counter = join(root,"attempts"), ready = join(root,"ready");
    const code = `const fs=require('fs');const counter=${JSON.stringify(counter)};const n=Number(fs.existsSync(counter)?fs.readFileSync(counter,'utf8'):0)+1;fs.writeFileSync(counter,String(n));if(n<3)process.exit(7);setTimeout(()=>fs.writeFileSync(process.env.TREETOP_INSTALLER_READY,JSON.stringify({pid:process.pid})),100);setTimeout(()=>process.exit(0),1200);`;
    const pid = await launchInstallerApp(process.execPath, root, join(root,"launch.log"), ["-e",code], 2000, { readyPath: ready, retries: 2, settleMs: 20, retryDelayMs: 10 });
    expect(pid).toBeGreaterThan(0);
    expect(await readFile(counter,"utf8")).toBe("3");
    await Bun.sleep(1300);
  } finally { await rm(root,{recursive:true,force:true}); }
});

test("installer does not duplicate a living app that never signals readiness", async () => {
  const { launchInstallerApp } = await import("../../../scripts/windows-installer-core");
  const root = await mkdtemp(join(tmpdir(), "treetop-no-ready-"));
  try {
    const counter=join(root,"attempts");
    const code=`require('fs').appendFileSync(${JSON.stringify(counter)},'x');setTimeout(()=>process.exit(0),4000);`;
    await expect(launchInstallerApp(process.execPath,root,join(root,"launch.log"),["-e",code],2000,{readyPath:join(root,"ready"),retries:2,settleMs:20,retryDelayMs:10})).rejects.toThrow("did not signal");
    expect(await readFile(counter,"utf8")).toBe("x");
    await Bun.sleep(4500);
  } finally {await rm(root,{recursive:true,force:true});}
}, 10_000);

for (const signalsReady of [false, true]) {
  test(`installer bounds failed launch retries; signalsReady=${signalsReady}`, async () => {
    const { launchInstallerApp } = await import("../../../scripts/windows-installer-core");
    const root = await mkdtemp(join(tmpdir(), "treetop-retry-limit-"));
    try {
      const counter = join(root, "attempts");
      const code = `const fs=require('fs');fs.appendFileSync(${JSON.stringify(counter)},'x');if(${signalsReady})fs.writeFileSync(process.env.TREETOP_INSTALLER_READY,JSON.stringify({pid:process.pid}));setTimeout(()=>process.exit(7),250);`;
      await expect(launchInstallerApp(process.execPath, root, join(root, "launch.log"), ["-e", code], 2000,
        { readyPath: join(root, "ready"), retries: 2, settleMs: 1000, retryDelayMs: 10 })).rejects.toThrow("exited during startup");
      expect(await readFile(counter, "utf8")).toBe(signalsReady ? "x" : "xxx");
    } finally { await rm(root, { recursive: true, force: true }); }
  });
}
test("desktop launch reopens its existing host and releases ownership on close", async () => {
  const { claimDesktopInstance } = await import("../../../src/electrobun/update-handoff");
  const reservation = Bun.listen({ hostname: "127.0.0.1", port: 0, socket: { data() {} } });
  const endpoint = reservation.port;
  reservation.stop(true);
  let reopened = 0;
  const owner = await claimDesktopInstance(endpoint, () => { reopened++; });
  expect(owner).not.toBeNull();
  try {
    expect(await claimDesktopInstance(endpoint, () => { throw Error("duplicate host"); })).toBeNull();
    expect(reopened).toBe(1);
  } finally { await owner!.close(); }
  const replacement = await claimDesktopInstance(endpoint, () => {});
  expect(replacement).not.toBeNull();
  await replacement!.close();
});
