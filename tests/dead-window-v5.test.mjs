import assert from "node:assert/strict";
import { cleanupDeadWindow, cleanupDeadWindowResult, DEAD_FORMAT } from "../extensions/dead-window-v5.mjs";
const taskId="task-fixture-aaaa",target=`pi-agents:worker-${taskId}.0`;
const dead=`${target}|@2|%3|1`,live=dead.replace(/1$/,"0");
async function scenario(rows, {conditionalFail=false, respawn=false, record={taskId,rmuxTarget:target}}={}) {
  let queries=0,kills=0,saved=false,guarded=false,fences=0;
  const command=async(...args)=>{
    if(args[0]==="list-panes") {assert.equal(args.at(-1),DEAD_FORMAT);return {returnCode:0,stdout:rows[Math.min(queries++,rows.length-1)]};}
    assert.equal(args[0],"if-shell"); assert.equal(args[3],"@2");
    assert.ok(saved && guarded); assert.match(args.at(-1),/pane_dead/); kills++;
    if(conditionalFail) return {returnCode:1};
    return {returnCode:0};
  };
  const promise=cleanupDeadWindow(command,record,()=>fences++,op=>{guarded=true;return op();},()=>{saved=true;});
  if(conditionalFail) {await assert.rejects(promise,/conditional/);return {kills};}
  return {ok:await promise,kills,fences};
}
assert.equal((await scenario([dead,dead,""])).ok,true);
assert.equal((await scenario([live])).kills,0);
assert.equal((await scenario([dead],{record:{taskId,rmuxTarget:target,requireRmuxIdentity:true}})).kills,0,"missing launch identity cannot be guessed");
assert.equal((await scenario([dead+`\n${target.replace(/\.0$/,".1")}|@2|%4|0`])).kills,0,"mixed window never killed");
assert.equal((await scenario([dead,live])).kills,0,"respawn during verification is refused");
assert.equal((await scenario([dead,dead,live])).ok,false,"daemon false conditional/respawn stays pending");
assert.equal((await scenario([dead],{record:{taskId,rmuxTarget:target,rmuxWindowId:"@99"}})).kills,0);
assert.equal((await scenario([dead],{conditionalFail:true})).kills,1);
assert.equal((await scenario([""])).ok,true,"verified absence is idempotent");
await assert.rejects(cleanupDeadWindow(async()=>({returnCode:1}),{taskId,rmuxTarget:target}),/query failed/);
await assert.rejects(cleanupDeadWindow(async()=>({returnCode:0,stdout:dead}),{taskId:"task-other-aaaa",rmuxTarget:target}),/mismatch/);
console.log("OK: exact task/window IDs, all-dead, revalidation/respawn, daemon conditional, unknown and absent cleanup");

// Real RMUX metadata grammar: @window, %pane; $session is never accepted.
const readonly=stdout=>async(...args)=>{assert.equal(args[0],"list-panes");return {returnCode:0,stdout};};
await assert.rejects(cleanupDeadWindowResult(readonly(dead.replace("@2","$2")),{taskId,rmuxTarget:target}),/unrecognized/);
await assert.rejects(cleanupDeadWindowResult(readonly(dead),{taskId,rmuxTarget:target,rmuxWindowId:"$2"}),/unsafe recorded/);
await assert.rejects(cleanupDeadWindowResult(readonly(dead+"\n"+dead),{taskId,rmuxTarget:target}),/ambiguous/);
assert.equal((await cleanupDeadWindowResult(readonly(dead),{taskId,rmuxTarget:target,requireRmuxIdentity:true})).state,"blocked_manual");
assert.equal((await cleanupDeadWindowResult(readonly(dead.replace(target,"pi-agents:renamed.0")),{taskId,rmuxTarget:target,rmuxWindowId:"@2"})).state,"retry","renamed recorded ID is not absence");
assert.equal((await cleanupDeadWindowResult(readonly(dead+"\npi-other:foreign.1|@2|%9|1"),{taskId,rmuxTarget:target})).state,"retry","foreign pane sharing ID prevents cleanup");
assert.equal((await cleanupDeadWindowResult(readonly(dead.replace(".0|",".1|")),{taskId,rmuxTarget:target})).state,"retry","another pane is not window absence");
// Supplied real snapshot shape, synthesized without live RMUX access: 263 rows,
// 26 live/237 dead, including 22 identity-required legacy terminal candidates.
const records=Array.from({length:22},(_,i)=>({taskId:`task-legacy-a${i}`,rmuxTarget:`pi-agents:worker-task-legacy-a${i}.0`,requireRmuxIdentity:true}));
const rows=records.map((r,i)=>`${r.rmuxTarget}|@${i}|%${i}|1`);
for(let i=22;i<263;i++)rows.push(`pi-other:window-${i}.0|@${i}|%${i}|${i<48?0:1}`);
const snapshot=readonly(rows.join("\n"));
for(const record of records){const result=await cleanupDeadWindowResult(snapshot,record);assert.equal(result.state,"blocked_manual");assert.equal(result.code,"missing_launch_identity");assert.equal(record.rmuxWindowId,undefined);}
console.log("OK: @window/%pane 263-row snapshot; 22 blocked_manual, none cleaned/adopted; $session and foreign/ambiguous identity refused");
