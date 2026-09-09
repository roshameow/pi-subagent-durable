import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { findRealSessionPathInRoot, resolveResumeTarget } from "../extensions/session-resume.mjs";

const root = fs.mkdtempSync(path.join(os.tmpdir(), "pi-subagent-session-resume-"));
try {
	const project = path.join(root, "--tmp-project--");
	fs.mkdirSync(project, { recursive: true });
	const id = "01a07409-3cc5-7013-bae7-c3c03cb63f3a";
	const header = JSON.stringify({ type: "session", version: 3, id, cwd: "/tmp/project" }) + "\n";
	const oldMirror = path.join(project, `2026-old_subagent-task-old.jsonl`);
	const newMirror = path.join(project, `2026-new_subagent-task-new.jsonl`);
	const canonical = path.join(project, `2026-real_${id}.jsonl`);
	fs.writeFileSync(oldMirror, header + '{"type":"message","message":{"role":"assistant"}}\n');
	fs.writeFileSync(newMirror, header + '{"type":"message","message":{"role":"assistant"}}\n');
	fs.writeFileSync(canonical, header);

	assert.equal(findRealSessionPathInRoot(root, id), canonical);
	assert.equal(resolveResumeTarget(root, id), canonical);
	assert.equal(resolveResumeTarget(root, "missing-session"), "missing-session");

	const falseName = path.join(project, `fake_${id}.jsonl`);
	fs.writeFileSync(falseName, JSON.stringify({ type: "session", id: "different" }) + "\n");
	assert.equal(findRealSessionPathInRoot(root, id), canonical);
	console.log("session resume tests passed");
} finally {
	fs.rmSync(root, { recursive: true, force: true });
}
