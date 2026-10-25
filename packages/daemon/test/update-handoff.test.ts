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
