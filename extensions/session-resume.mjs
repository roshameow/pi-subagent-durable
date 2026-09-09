import * as fs from "node:fs";
import * as path from "node:path";

function hasSessionHeader(file, sessionId) {
	try {
		const fd = fs.openSync(file, "r");
		const buf = Buffer.alloc(8192);
		let bytes = 0;
		try { bytes = fs.readSync(fd, buf, 0, buf.length, 0); }
		finally { fs.closeSync(fd); }
		const first = buf.subarray(0, bytes).toString("utf8").split(/\r?\n/, 1)[0];
		const header = JSON.parse(first);
		return header?.type === "session" && header?.id === sessionId;
	} catch {
		return false;
	}
}

/** Find the canonical pi session file, never a per-task subagent mirror. */
export function findRealSessionPathInRoot(sessionsRoot, sessionId) {
	const candidates = [];
	try {
		for (const dirName of fs.readdirSync(sessionsRoot).sort()) {
			const dir = path.join(sessionsRoot, dirName);
			let files = [];
			try { files = fs.readdirSync(dir).sort(); } catch { continue; }
			for (const file of files) {
				if (!file.endsWith(".jsonl")) continue;
				if (file.includes("subagent-task")) continue;
				if (!file.includes(sessionId)) continue;
				const full = path.join(dir, file);
				if (hasSessionHeader(full, sessionId)) candidates.push(full);
			}
		}
	} catch {
		return null;
	}
	return candidates[0] ?? null;
}

export function resolveResumeTarget(sessionsRoot, sessionId) {
	return findRealSessionPathInRoot(sessionsRoot, sessionId) ?? sessionId;
}
