import assert from "node:assert/strict";
import { cleanupDeadWindow, DEAD_FORMAT } from "../extensions/dead-window-v3.mjs";
const taskId="task-fixture-aaaa",target=`pi-agents:worker-${taskId}.0`;
const dead=`${target}|$2|%3|1`,live=dead.replace(/1$/,"0");
async function scenario(rows, {conditionalFail=false, respawn=false, record={taskId,rmuxTarget:target}}={}) {
  let queries=0,kills=0,saved=false,guarded=false,fences=0;
  const command=async(...args)=>{
    if(args[0]==="list-panes") {assert.equal(args.at(-1),DEAD_FORMAT);return {returnCode:0,stdout:rows[Math.min(queries++,rows.length-1)]};}
    assert.equal(args[0],"if-shell"); assert.equal(args[3],"$2");
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
assert.equal((await scenario([dead+`\n${target.replace(/\.0$/,".1")}|$2|%4|0`])).kills,0,"mixed window never killed");
assert.equal((await scenario([dead,live])).kills,0,"respawn during verification is refused");
assert.equal((await scenario([dead,dead,live])).ok,false,"daemon false conditional/respawn stays pending");
assert.equal((await scenario([dead],{record:{taskId,rmuxTarget:target,rmuxWindowId:"$99"}})).kills,0);
assert.equal((await scenario([dead],{conditionalFail:true})).kills,1);
assert.equal((await scenario([""])).ok,true,"verified absence is idempotent");
await assert.rejects(cleanupDeadWindow(async()=>({returnCode:1}),{taskId,rmuxTarget:target}),/query failed/);
await assert.rejects(cleanupDeadWindow(async()=>({returnCode:0,stdout:dead}),{taskId:"task-other-aaaa",rmuxTarget:target}),/mismatch/);
console.log("OK: exact task/window IDs, all-dead, revalidation/respawn, daemon conditional, unknown and absent cleanup");
