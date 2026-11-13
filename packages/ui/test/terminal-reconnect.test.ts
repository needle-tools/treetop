import { expect, test } from "bun:test";
import { createTerminalReconnect } from "../src/terminal-reconnect";
import { codexResumeCommand, rememberCodexStandalone, createSlowResumeWatch, retryCodexStandalone } from "../src/terminal-reconnect";

test("standalone preference survives reopening and is scoped to daemon and session", () => {
  const values = new Map<string,string>();
  const storage = {getItem:(k:string)=>values.get(k)??null,setItem:(k:string,v:string)=>{values.set(k,v);}};
  const cmd = ["codex","resume","--model","gpt-6.1","session-a"];
  expect(codexResumeCommand(cmd,storage,"session-a")).toEqual(cmd);
  rememberCodexStandalone(storage,"session-a");
  expect(codexResumeCommand(cmd,storage,"session-a")).toEqual(["codex","--no-daemon",...cmd.slice(1)]);
  expect(codexResumeCommand(cmd,storage,"session-b")).toEqual(cmd);
  expect(codexResumeCommand(cmd,storage,"session-a","remote")).toEqual(cmd);
  expect(codexResumeCommand(["codex","--remote","unix://","resume","session-a"],storage,"session-a")).toEqual(["codex","--no-daemon","resume","session-a"]);
});

test("slow resume warning requires twenty continuous seconds of visible startup status", () => {
  const watch = createSlowResumeWatch();
  expect(watch.observe("◐ Resuming session…",0)).toBe(false);
  expect(watch.observe("◓ Resuming session…",19_999)).toBe(false);
  expect(watch.observe("◑ Resuming session…",20_000)).toBe(true);
  expect(watch.observe("› Ask Codex to do anything",20_001)).toBe(false);
  expect(watch.observe("The user says resuming is slow",80_000)).toBe(false);
  expect(watch.observe("Resuming...",90_000)).toBe(false);
  watch.reset();
  expect(watch.observe("Resuming...",110_000)).toBe(false);
});

test("retry waits for confirmed stop and never starts a replacement after a failed stop", async () => {
  const events:string[]=[];
  let finish!:()=>void;
  const pending = retryCodexStandalone({stop:()=>new Promise<void>(r=>{finish=r;events.push("stop");}),remember:()=>events.push("remember"),start:async()=>{events.push("start");}});
  expect(events).toEqual(["stop"]);
  finish();await pending;
  expect(events).toEqual(["stop","remember","start"]);
  await expect(retryCodexStandalone({stop:async()=>{throw new Error("Stop failed");},remember:()=>events.push("bad"),start:async()=>{events.push("bad");}})).rejects.toThrow("Stop failed");
  expect(events).toEqual(["stop","remember","start"]);
});

test("retries with capped backoff, wakes immediately, and cancels on recovery or disposal", () => {
  let pending: (() => void) | undefined;
  const delays: number[] = [];
  let attempts = 0;
  const reconnect = createTerminalReconnect(() => attempts++, {
    schedule: (fn, ms) => {
      pending = fn;
      delays.push(ms);
      return 1;
    },
    cancel: () => {
      pending = undefined;
    },
  });
  reconnect.schedule();
  reconnect.schedule();
  expect(delays).toEqual([1000]);
  for (let i = 0; i < 7; i++) {
    const fn = pending!;
    pending = undefined;
    fn();
    reconnect.schedule();
  }
  expect(delays).toEqual([1000, 2000, 4000, 8000, 16000, 30000, 30000, 30000]);
  reconnect.wake();
  expect(attempts).toBe(8);
  expect(pending).toBeUndefined();
  reconnect.reset();
  reconnect.schedule();
  expect(delays.at(-1)).toBe(1000);
  reconnect.reset();
  expect(pending).toBeUndefined();
  reconnect.wake();
  expect(attempts).toBe(8);
  reconnect.schedule();
  reconnect.dispose();
  reconnect.schedule();
  reconnect.wake();
  expect(pending).toBeUndefined();
  expect(attempts).toBe(8);
});
