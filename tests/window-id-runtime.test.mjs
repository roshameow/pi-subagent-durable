// Execute the actual index capture/binding blocks with adapters only. No host,
// daemon, subprocess, global runtime state, or controller registry is contacted.
import assert from "node:assert/strict";
import fs from "node:fs";
import crypto from "node:crypto";
import { isRmuxWindowId } from "../extensions/window-binding-v4.mjs";
const source=fs.readFileSync(new URL("../extensions/index.ts",import.meta.url),"utf8");
assert.match(source,/from "\.\/dead-window-v5\.mjs"/);
assert.match(source,/from "\.\/window-binding-v4\.mjs"/);
assert.doesNotMatch(source,/\/\^\\\$\\d\+\$\//,"runtime must never validate $session IDs as windows");
assert.match(source,/rmuxWindowId: launchedWindowId, requireRmuxIdentity: true/);
const AsyncFunction=Object.getPrototypeOf(async function(){}).constructor;
const start=source.indexOf("let launchedWindowId: string | undefined;");
const end=source.indexOf('fs.appendFileSync(logPath, JSON.stringify({ type: "pi_subagent_launch"',start);
assert.ok(start>0&&end>start);
const capture=source.slice(start,end).replace("let launchedWindowId: string | undefined;","let launchedWindowId;");
const runCapture=new AsyncFunction("rmux","rmuxTarget","isRmuxWindowId",capture+"return launchedWindowId;");
for(const [stdout,expected] of [["@42\n","@42"],["$42",undefined],["%42",undefined],["42",undefined],["@42;kill-session",undefined],["@bad",undefined]]) {
  const calls=[];
  const id=await runCapture({cmd:async(...args)=>{calls.push(args);return {returnCode:0,stdout};}},"pi-agents:worker-task-fixture-aaaa.0",isRmuxWindowId);
  assert.equal(id,expected);assert.deepEqual(calls,[["display-message","-p","-t","pi-agents:worker-task-fixture-aaaa.0","#{window_id}"]]);
  const launchRecord={rmuxWindowId:id,requireRmuxIdentity:true};assert.equal(launchRecord.rmuxWindowId,expected);
}
assert.equal(await runCapture({cmd:async()=>({returnCode:1,stdout:"@42"})},"fixture",isRmuxWindowId),undefined);
// Startup registration's real typed gate also rejects session selectors before
// a register callback or global binding assignment can occur.
const bindStart=source.indexOf('const binding = await rmux.cmd("display-message", "-p", "-t", win, "#{window_id}");');
const bindEnd=source.indexOf('(globalThis as any).__pi_subagent_window_binding_v3__ = binding;',bindStart);
assert.ok(bindStart>0&&bindEnd>bindStart);
const bindingBlock=source.slice(bindStart,bindEnd+'(globalThis as any).__pi_subagent_window_binding_v3__ = binding;'.length)
  .replace('(globalThis as any)','globalThis').replace('(...args: string[])','(...args)')+'\n}';
const runBinding=new AsyncFunction("rmux","win","sessFile","crypto","registerWindowBinding","globalThis","isRmuxWindowId",bindingBlock);
for(const [stdout,registered] of [["@7",true],["$7",false]]) {
  const bindings=[],globals={};
  await runBinding({cmd:async()=>({returnCode:0,stdout})},"fixture:window","/fixture/session.jsonl",crypto,async(_cmd,b)=>bindings.push(b),globals,isRmuxWindowId);
  assert.equal(bindings.length,registered?1:0);assert.equal(Boolean(globals.__pi_subagent_window_binding_v3__),registered);
  if(registered)assert.equal(bindings[0].windowId,"@7");
}
// Stop target matching must be unique, two-column, and typed before kill-window.
const stop=source.slice(source.indexOf('const parts = String(query.stdout'),source.indexOf('// Exact task suffix, stable window ID'));
const runStop=new Function("query","entry","durable","isRmuxWindowId",stop+"return hit[1];");
const entry={rmuxTarget:"pi-agents:worker-task-fixture-aaaa.0"};
assert.equal(runStop({stdout:`${entry.rmuxTarget}|@9`},entry,{rmuxWindowId:"@9"},isRmuxWindowId),"@9");
for(const stdout of [`${entry.rmuxTarget}|$9`,`${entry.rmuxTarget}|@9\n${entry.rmuxTarget}|@10`,`${entry.rmuxTarget}|@9|extra`,`${entry.rmuxTarget}|@10`])
  assert.equal(runStop({stdout},entry,{rmuxWindowId:"@9"},isRmuxWindowId),false);
console.log("OK: actual runtime launch capture, startup binding and stop matching use @window IDs only; $session selectors refused");

const legacyDead=await import("../extensions/dead-window-v4.mjs");
const freshDead=await import("../extensions/dead-window-v5.mjs");
const legacyBinding=await import("../extensions/window-binding-v3.mjs");
const freshBinding=await import("../extensions/window-binding-v4.mjs");
assert.notEqual(legacyDead.cleanupDeadWindowResult,freshDead.cleanupDeadWindowResult);
assert.notEqual(legacyBinding.registerWindowBinding,freshBinding.registerWindowBinding);
for(const key of Object.keys(legacyDead))assert.ok(key in freshDead,"dead-window exports remain compatible");
for(const key of Object.keys(legacyBinding))assert.ok(key in freshBinding,"binding exports remain compatible");
console.log("OK: native ESM fresh paths bypass cached legacy helpers and preserve existing exports");
