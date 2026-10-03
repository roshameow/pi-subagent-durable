import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { workerPipelineCommand } from "../extensions/worker-pipeline-v3.mjs";
import { parseRecoveryResult } from "../extensions/recovery-v3.mjs";
const quote=s=>`'${s.replace(/'/g,"'\\''")}'`;
for(const code of [0,7]) {
 const script=`console.log(JSON.stringify({type:'agent_start'}));console.log(JSON.stringify({type:'agent_settled'}));process.exitCode=${code}`;
 const command=workerPipelineCommand(`${quote(process.execPath)} -e ${quote(script)}`,"cat");
 const child=spawn("/bin/sh",["-c",command],{stdio:["ignore","pipe","pipe"]});
 let raw="",stderr="";child.stdout.on("data",d=>raw+=d);child.stderr.on("data",d=>stderr+=d);
 const status=await new Promise((resolve,reject)=>{const t=setTimeout(()=>{child.kill("SIGKILL");reject(Error("pipeline exit timeout"));},3000);child.once("close",c=>{clearTimeout(t);resolve(c)});});
 assert.equal(status,0,stderr); // filter success alone must not classify worker
 const result=parseRecoveryResult(raw,"task-pipeline-aaaa",status);
 assert.equal(result.exitCode,code);assert.equal(result.interrupted,code!==0);
 assert.match(raw,/pi_subagent_exit/);
}
console.log("OK: real shell/filter pipeline preserves nonzero worker status despite filter exit0");
