import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {RecoveryController,readTaskRecords} from "../extensions/recovery-v3.mjs";
const root=fs.mkdtempSync(path.join(os.tmpdir(),"durable-cleanup-v3-"));
const logPath=path.join(root,"worker.jsonl");fs.writeFileSync(logPath,'{"type":"agent_start"}\n{"type":"agent_settled"}\n');
const record={version:1,taskId:"task-cleanup-aaaa",mode:"async-rmux",parentSessionId:"parent",parentSessionPath:path.join(root,"parent.jsonl"),logPath};
const base={ledgerDir:path.join(root,"ledger"),controllerRegistryPath:path.join(root,"controllers.json"),parentSessionId:record.parentSessionId,parentSessionPath:record.parentSessionPath,pollMs:60000};
const disk=()=>readTaskRecords(base.ledgerDir,"parent")[0];
let sent=0,cleanup=0,retired=0,failed=true;
const make=()=>new RecoveryController({...base,probe:async()=>({state:"dead",exitCode:0}),deliver:async()=>{sent++;return true;},cleanup:async()=>{cleanup++;if(failed)throw Error("fixture cleanup fault");return true;},onCompleted:()=>retired++});
let controller;
try {
 controller=make();controller.track(record);await controller.tick();
 assert.equal(disk().cleanupState,"cleanup_pending");assert.ok(disk().deliveredAt);assert.ok(disk().result);assert.equal(retired,1);
 assert.ok(controller.records.has(record.taskId),"ACK must retain cleanup authority");controller.close();
 failed=false;controller=make();await controller.recover();
 assert.equal(cleanup,2);assert.equal(sent,1,"delivered result is not sent again after cold cleanup recovery");assert.equal(retired,1,"already retired ownership is not replayed");
 assert.equal(disk().cleanupState,"cleaned");assert.ok(fs.existsSync(logPath));assert.equal(controller.records.size,0);controller.close();
 // Failed post-ACK ownership retirement is ALSO recoverable, not silently
 // skipped because deliveredAt was already written.
 const second={...record,taskId:"task-retire-bbbb"};let retirementFault=true;
 const options={...base,probe:async()=>({state:"dead",exitCode:0}),deliver:async()=>true,cleanup:async()=>true,onCompleted:()=>{if(retirementFault)throw Error("retirement fixture fault");}};
 controller=new RecoveryController(options);controller.track(second);await controller.tick();
 let r=readTaskRecords(base.ledgerDir,"parent").find(r=>r.taskId===second.taskId);assert.ok(r.deliveredAt);assert.equal(r.retirementState,"retirement_pending");controller.close();
 retirementFault=false;controller=new RecoveryController(options);await controller.recover();
 r=readTaskRecords(base.ledgerDir,"parent").find(r=>r.taskId===second.taskId);assert.equal(r.retirementState,"retired");assert.equal(controller.records.size,0);
 console.log("OK: cold cleanup after deliveredAt, outbox/log preservation, independent ACK and recoverable retirement faults");
}finally{controller?.close();fs.rmSync(root,{recursive:true,force:true});}
