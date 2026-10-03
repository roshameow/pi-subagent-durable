// Real subprocesses and inherited pipes: no daemon/provider/real RMUX commands.
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawn } from "node:child_process";
import { pathToFileURL } from "node:url";
const root=fs.mkdtempSync(path.join(os.tmpdir(),"durable-exit-v3-"));
const syncUrl=pathToFileURL(path.resolve("extensions/rmux-sync-client-v3.mjs")).href;
const recoveryUrl=pathToFileURL(path.resolve("extensions/recovery-v3.mjs")).href;
const runner=pathToFileURL(path.resolve("extensions/rmux-command-v3.mjs")).href;
const printModeUrl = new URL("./modes/print-mode.js", import.meta.resolve("@earendil-works/pi-coding-agent")).href;
const lifecycle=pathToFileURL(path.resolve("extensions/lifecycle-v3.mjs")).href;
const cli=path.join(root,"mock-cli.cjs");
fs.writeFileSync(cli,`const {spawn}=require('node:child_process');
const child=spawn(process.execPath,['-e',"process.on('SIGTERM',()=>{});setInterval(()=>{},1000)"],{stdio:['ignore','inherit','inherit']});
require('node:fs').writeFileSync(process.argv[2],JSON.stringify({leader:process.pid,descendant:child.pid}));
process.on('SIGTERM',()=>{});
if(process.argv[3]==='exit')setTimeout(()=>process.exit(0),100);else setInterval(()=>{},1000);
`);
const children=[];
async function run(code, timeout=3000) {
  const child=spawn(process.execPath,["--input-type=module","-e",code],{stdio:["ignore","pipe","pipe"]});children.push(child);
  let out="",err="";child.stdout.on("data",d=>out+=d);child.stderr.on("data",d=>err+=d);
  const exit=await new Promise((resolve,reject)=>{
    const watchdog=setTimeout(()=>{child.kill("SIGKILL");reject(Error(`did not naturally exit: ${err}`));},timeout);
    child.once("error",reject);child.once("close",status=>{clearTimeout(watchdog);resolve(status);});
  });
  assert.equal(exit,0,err);return out;
}
try {
  const base=`import {RmuxCommandScope} from ${JSON.stringify(runner)};import {MonitorScope} from ${JSON.stringify(lifecycle)};`;
  // Unref baseline and formerly ref legacy/nested monitor actually naturally exit.
  assert.match(await run(base+`const m=new MonitorScope();const timer=setInterval(()=>{},1000);m.add('legacy',()=>clearInterval(timer));m.close();const t=setInterval(()=>{},1000);t.unref();console.log('shutdown');`),/shutdown/);
  assert.match(await run(base+`const s=new RmuxCommandScope({executable:process.execPath});const r=await s.run(['-e','console.log("done")']);s.close();console.log(r.stdout);`),/done/);
  for(const mode of ["timeout","abort","close","leader-exit"]) {
    const marker=path.join(root,`${mode}.json`);
    const cancel=mode==="abort"?`setTimeout(()=>ac.abort(),180);`:mode==="close"?`setTimeout(()=>s.close(),180);`:"";
    const output=await run(base+`
      const s=new RmuxCommandScope({executable:process.execPath,timeoutMs:400,killGraceMs:100});
      const ac=new AbortController();${cancel}
      try{await s.run(${JSON.stringify([cli,marker,mode==="leader-exit"?"exit":"hold"])},{signal:ac.signal});throw Error('unexpected success');}
      catch(e){if(!/abort|closed|timed out/.test(e.message))throw e;}
      s.close();if(s.pending.size)throw Error('pending child');console.log('shutdown returned');
    `);
    assert.match(output,/shutdown returned/);
    const ids=JSON.parse(fs.readFileSync(marker,"utf8"));
    for(const pid of Object.values(ids)) assert.throws(()=>process.kill(pid,0),undefined,`${mode}: owned child/descendant ${pid} survived`);
  }
  const bin=path.join(root,"bin");fs.mkdirSync(bin);const syncMarker=path.join(root,"sync.json");
  fs.writeFileSync(path.join(bin,"rmux"),`#!${process.execPath}\nconst {spawn}=require('node:child_process');const child=spawn(process.execPath,['-e',"process.on('SIGTERM',()=>{});setInterval(()=>{},1000)"],{stdio:['ignore','inherit','inherit']});require('node:fs').writeFileSync(${JSON.stringify(syncMarker)},JSON.stringify({leader:process.pid,descendant:child.pid}));process.on('SIGTERM',()=>{});setInterval(()=>{},1000);`,{mode:0o700});
  await run(`import {runRmuxSync} from ${JSON.stringify(syncUrl)};process.env.PATH=${JSON.stringify(bin)}+':'+process.env.PATH;const r=runRmuxSync(['fixture'],1000);if(!/timed out/.test(r.stderr))throw Error('sync timeout failed');console.log('sync cancelled');`);
  for(const pid of Object.values(JSON.parse(fs.readFileSync(syncMarker,'utf8'))))assert.throws(()=>process.kill(pid,0),undefined,"sync supervisor must reap its CLI group");
  const probeMarker=path.join(root,"probe.json");
  await run(base+`
    import {RecoveryController} from ${JSON.stringify(recoveryUrl)};
    const s=new RmuxCommandScope({executable:process.execPath,timeoutMs:2000});let underlying;
    const c=new RecoveryController({probe:(_r,options)=>{underlying=s.run(${JSON.stringify([cli,probeMarker,"hold"])},options);return underlying;}});
    const pending=c.probe({taskId:'task-probe-aaaa'});
    setTimeout(()=>c.close(),180);
    const result=await pending;if(result.state!=='unknown')throw Error('not cancelled');
    await underlying.catch(()=>{});if(s.pending.size)throw Error('owned probe survived');console.log('probe cancelled');
  `);
  // The installed Pi's actual print host returns naturally after dispose;
  // provider/session are mocks, but shutdown closes real owned CLI resources.
  const printMarker=path.join(root,"print.json");
  await run(base+`
    import {runPrintMode} from ${JSON.stringify(printModeUrl)};
    const s=new RmuxCommandScope({executable:process.execPath,timeoutMs:1000});
    const m=new MonitorScope();const timer=setInterval(()=>{},1000);m.add('legacy',()=>clearInterval(timer));
    const pending=s.run(${JSON.stringify([cli,printMarker,"hold"])}).catch(e=>{if(!/closed/.test(e.message))throw e;});
    const session={bindExtensions:async()=>{},subscribe:()=>()=>{},sessionManager:{getHeader:()=>null},agent:{subscribe:()=>()=>{}},prompt:async()=>{}};
    const host={session,setRebindSession(){},dispose:async()=>{m.close();s.close();}};
    await runPrintMode(host,{mode:'json',initialMessage:'isolated'});await pending;console.log('print shutdown returned');
  `);
  // Closing a scope must NOT terminate an unrelated live background worker.
  const worker=spawn(process.execPath,["-e","setInterval(()=>{},1000)"],{stdio:"ignore"});children.push(worker);
  await new Promise(r=>worker.once("spawn",r));
  await run(base+`const s=new RmuxCommandScope();s.close();const m=new MonitorScope();m.close();`);
  process.kill(worker.pid,0);worker.kill();await new Promise(r=>worker.once("exit",r));
  console.log("OK: real natural exit; timeout/AbortSignal/scope close kill owned groups and inherited pipes; unrelated workers preserved");
} finally {for(const child of children)if(child.exitCode===null)child.kill("SIGKILL");fs.rmSync(root,{recursive:true,force:true});}
