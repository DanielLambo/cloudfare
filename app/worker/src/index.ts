import type { Env } from "./types";

export { SalesAgent } from "./salesAgentDO";
export { FinalizeCallWorkflow } from "./workflows";

export default {
	async fetch(request: Request, env: Env): Promise<Response> {
		const url = new URL(request.url);

		// --- /api/chat ---
		if (url.pathname === "/api/chat" && request.method === "POST") {
			const { sessionId, message } = await request.json<{
				sessionId: string;
				message: string;
			}>();

			if (!sessionId || !message) {
				return new Response("Missing sessionId or message", { status: 400 });
			}

			const id = env.SALES_AGENT.idFromName(sessionId);
			const stub = env.SALES_AGENT.get(id);

			const resp = await stub.fetch("https://do/internal/chat", {
				method: "POST",
				headers: { "Content-Type": "application/json" },
				body: JSON.stringify({ message }),
			});

			return resp; // returns {reply, dealMemory}
		}

		if (url.pathname === "/" && request.method === "GET") {
			return new Response(
				"OK. Use POST /api/chat with JSON { sessionId, message }",
				{ headers: { "Content-Type": "text/plain" } }
			);
		}

		// --- /api/results ---
		if (url.pathname === "/api/results" && request.method === "GET") {
			const sessionId = url.searchParams.get("sessionId");
			if (!sessionId) return new Response("Missing sessionId", { status: 400 });

			const id = env.SALES_AGENT.idFromName(sessionId);
			const stub = env.SALES_AGENT.get(id);

			const resp = await stub.fetch("https://do/internal/state");
			return resp; // includes final outputs when ready
		}

		// --- /api/debug (temporary) ---
		if (url.pathname === "/api/debug" && request.method === "GET") {
			const sessionId = url.searchParams.get("sessionId");
			if (!sessionId) return new Response("Missing sessionId", { status: 400 });

			const id = env.SALES_AGENT.idFromName(sessionId);
			const stub = env.SALES_AGENT.get(id);

			return await stub.fetch("https://do/internal/state");
		}

		// --- /api/end-call ---
		if (url.pathname === "/api/end-call" && request.method === "POST") {
			const { sessionId } = await request.json<{ sessionId: string }>();
			if (!sessionId) return new Response("Missing sessionId", { status: 400 });

			// Start workflow instance
			const instance = await env.FINALIZE_CALL.create({ payload: { sessionId } });

			return Response.json({ ok: true, workflowId: instance.id });
		}

		// --- /api/reset (temporary for testing) ---
		if (url.pathname === "/api/reset" && request.method === "POST") {
			const { sessionId } = await request.json<{ sessionId: string }>();
			if (!sessionId) return new Response("Missing sessionId", { status: 400 });

			const id = env.SALES_AGENT.idFromName(sessionId);
			const stub = env.SALES_AGENT.get(id);

			return await stub.fetch("https://do/internal/reset", { method: "POST" });
		}

		return new Response("Not found", { status: 404 });
	},
};
