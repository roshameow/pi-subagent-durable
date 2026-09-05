import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

/** Apply the parent session's effective context window inside a child process. */
export default function (pi: ExtensionAPI) {
	const requested = Number(process.env.PI_SUBAGENT_CONTEXT_WINDOW || 0);
	const contextWindow = Number.isFinite(requested) && requested > 0 ? Math.floor(requested) : 0;
	if (!contextWindow) return;

	const apply = (model: any) => {
		if (!model || !Number.isFinite(model.contextWindow)) return;
		model.contextWindow = contextWindow;
	};

	pi.on("session_start", (_event, ctx) => apply(ctx.model as any));
	pi.on("model_select", (event) => apply(event.model as any));
	pi.on("before_agent_start", (_event, ctx) => apply(ctx.model as any));
}
