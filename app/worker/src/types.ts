import { DateTime, Str } from "chanfana";
import type { Context } from "hono";
import { z } from "zod";
import type { SalesAgent } from "./salesAgentDO";

export interface Env {
	AI: any; // Workers AI binding
	SALES_AGENT: DurableObjectNamespace<SalesAgent>;
	FINALIZE_CALL: any; // Workflow binding
}

export type AppContext = Context<{ Bindings: Env }>;

export const Task = z.object({
	name: Str({ example: "lorem" }),
	slug: Str(),
	description: Str({ required: false }),
	completed: z.boolean().default(false),
	due_date: DateTime(),
});
