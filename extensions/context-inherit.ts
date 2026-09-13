import * as fs from "node:fs";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

/** Apply parent runtime metadata inside a durable child process. */
export default function (pi: ExtensionAPI) {
	const requested = Number(process.env.PI_SUBAGENT_CONTEXT_WINDOW || 0);
	const contextWindow = Number.isFinite(requested) && requested > 0 ? Math.floor(requested) : 0;
	const parentSessionFile = process.env.PI_SUBAGENT_PARENT_SESSION_FILE || "";

	const applyContextWindow = (model: any) => {
		if (!contextWindow || !model || !Number.isFinite(model.contextWindow)) return;
		model.contextWindow = contextWindow;
	};

	pi.on("session_start", (_event, ctx) => {
		applyContextWindow(ctx.model as any);

		// SessionManager.getHeader() returns the in-memory header object. A new
		// session has not been flushed yet at session_start, so adding the standard
		// parentSession field here makes /resume and session viewers build the same
		// lineage as the durable task ledger. Never overwrite lineage on resume.
		if (!parentSessionFile || !fs.existsSync(parentSessionFile)) return;
		const header = (ctx as any).sessionManager?.getHeader?.() as any;
		if (header?.type === "session" && !header.parentSession) {
			header.parentSession = parentSessionFile;
		}
	});
	pi.on("model_select", (event) => applyContextWindow(event.model as any));
	pi.on("before_agent_start", (_event, ctx) => applyContextWindow(ctx.model as any));
}
