import { DurableObject } from "cloudflare:workers";
import type { Env } from "./types";

export type DealMemory = {
    customerName: string;
    company: string;
    industry: string;
    painPoints: string[];
    budget: string;
    timeline: string;
    objections: string[];
    nextSteps: string[];
};

export type AgentState = {
    messages: { role: "user" | "assistant"; content: string }[];
    dealMemory: DealMemory;
    rollingSummary: string;
    userTurnCount: number;
    final?: any;
};

const DEFAULT_DEAL_MEMORY: DealMemory = {
    customerName: "",
    company: "",
    industry: "",
    painPoints: [],
    budget: "",
    timeline: "",
    objections: [],
    nextSteps: [],
};

const DEFAULT_STATE: AgentState = {
    messages: [],
    dealMemory: DEFAULT_DEAL_MEMORY,
    rollingSummary: "",
    userTurnCount: 0,
};

// --- Helper Functions ---

function lastN<T>(arr: T[], n: number) {
    return arr.slice(Math.max(0, arr.length - n));
}

function safeJsonParse<T>(text: string): T | null {
    try {
        return JSON.parse(text) as T;
    } catch {
        return null;
    }
}

function normalizeAIText(output: any): string {
    if (!output) return "";
    if (typeof output === "string") return output;
    if (typeof output.response === "string") return output.response;
    if (typeof output.output_text === "string") return output.output_text;
    if (typeof output.result?.response === "string") return output.result.response;
    try {
        return JSON.stringify(output);
    } catch {
        return "";
    }
}

function extractBetween(text: string, startTag: string, endTag: string): string | null {
    const startIndex = text.indexOf(startTag);
    const endIndex = text.lastIndexOf(endTag);
    if (startIndex === -1 || endIndex === -1 || endIndex <= startIndex) return null;
    return text.slice(startIndex + startTag.length, endIndex).trim();
}

function extractJsonObject(text: string): string | null {
    const start = text.indexOf("{");
    const end = text.lastIndexOf("}");
    if (start === -1 || end === -1 || end <= start) return null;
    return text.slice(start, end + 1);
}

// Durable Object Class

export class SalesAgent extends DurableObject {
    constructor(ctx: DurableObjectState, env: Env) {
        super(ctx, env);
    }

    private async load(): Promise<AgentState> {
        const stored = await this.ctx.storage.get<Partial<AgentState>>("state");
        if (!stored) return { ...DEFAULT_STATE };

        // Robust merge to ensure no fields are missing (migration logic)
        return {
            messages: Array.isArray(stored.messages) ? stored.messages : DEFAULT_STATE.messages,
            dealMemory: {
                ...DEFAULT_DEAL_MEMORY,
                ...(stored.dealMemory || {}),
            },
            rollingSummary: stored.rollingSummary ?? DEFAULT_STATE.rollingSummary,
            userTurnCount: typeof stored.userTurnCount === "number" ? stored.userTurnCount : DEFAULT_STATE.userTurnCount,
            final: stored.final,
        };
    }

    private async save(s: AgentState) {
        await this.ctx.storage.put("state", s);
    }

    async fetch(request: Request): Promise<Response> {
        const url = new URL(request.url);

        // --- /internal/chat ---
        if (url.pathname === "/internal/chat" && request.method === "POST") {
            try {
                const { message } = await request.json<{ message: string }>();
                const s = await this.load();

                // 1. Update State
                s.messages.push({ role: "user", content: message });
                s.userTurnCount += 1;

                // 2. Build Context
                const recent = lastN(s.messages, 10);
                const recentText = recent.map(m => `${m.role.toUpperCase()}: ${m.content}`).join("\n");

                // 3. System Prompt (Enforce <json> tags)
                const systemPrompt = `
You are a sales objection coach. Your job is to help a sales rep respond to a customer message.
Response format:
<json>
{
  "reply": "string (2-4 sentences)",
  "followUps": ["question 1", "question 2"]
}
</json>

Be practical, confident, and specific. No markdown outside tags.
`.trim();

                const userPrompt = `
Rolling summary: ${s.rollingSummary || "(none yet)"}
Deal Memory: ${JSON.stringify(s.dealMemory)}

Recent conversation:
${recentText}

Now respond to the latest USER message.
`.trim();

                // 4. Run LLM
                const model = "@cf/meta/llama-3.3-70b-instruct-fp8-fast";
                const aiResp = await this.env.AI.run(model, {
                    messages: [
                        { role: "system", content: systemPrompt },
                        { role: "user", content: userPrompt },
                    ],
                });

                // 5. Safe Parse
                let rawText = normalizeAIText(aiResp);
                let jsonStr = extractBetween(rawText, "<json>", "</json>") ?? extractJsonObject(rawText);
                let parsed = safeJsonParse<{ reply: string; followUps: string[] }>(jsonStr || "");

                // Fallback attempt: if parsing failed, try to treat rawText as just the reply if it doesn't look like JSON
                if (!parsed && !rawText.trim().startsWith("{")) {
                    // The model might have just refused and chatted
                    parsed = { reply: rawText, followUps: [] };
                }

                const reply = parsed?.reply ?? "I can help—can you tell me what price point you were expecting?";
                const followUps = parsed?.followUps?.length === 2
                    ? parsed.followUps
                    : ["What's driving that concern?", "What would make this a clear yes for you?"];

                // 6. Periodic Memory Update (Every 3 turns)
                if (s.userTurnCount > 0 && s.userTurnCount % 3 === 0) {
                    const memSystem = `
Extract Deal Memory. Output strictly valid JSON inside <json> tags.
Keys: customerName, company, industry, painPoints, budget, timeline, objections, nextSteps, rollingSummary.
<json>
{ ... }
</json>
`.trim();

                    const memUser = `
Current Memory: ${JSON.stringify(s.dealMemory)}
Rolling Summary: ${s.rollingSummary}
Conversation:
${recentText}
`.trim();

                    const memResp = await this.env.AI.run(model, {
                        messages: [
                            { role: "system", content: memSystem },
                            { role: "user", content: memUser },
                        ],
                    });

                    const memRaw = normalizeAIText(memResp);
                    const memJson = extractBetween(memRaw, "<json>", "</json>") ?? extractJsonObject(memRaw);
                    const memParsed = safeJsonParse<Partial<DealMemory> & { rollingSummary?: string }>(memJson || "");

                    if (memParsed) {
                        s.dealMemory = {
                            customerName: memParsed.customerName ?? s.dealMemory.customerName,
                            company: memParsed.company ?? s.dealMemory.company,
                            industry: memParsed.industry ?? s.dealMemory.industry,
                            painPoints: Array.isArray(memParsed.painPoints) ? memParsed.painPoints : s.dealMemory.painPoints,
                            budget: memParsed.budget ?? s.dealMemory.budget,
                            timeline: memParsed.timeline ?? s.dealMemory.timeline,
                            objections: Array.isArray(memParsed.objections) ? memParsed.objections : s.dealMemory.objections,
                            nextSteps: Array.isArray(memParsed.nextSteps) ? memParsed.nextSteps : s.dealMemory.nextSteps,
                        };
                        s.rollingSummary = memParsed.rollingSummary ?? s.rollingSummary;
                    }
                }

                // 7. Save & Return
                s.messages.push({ role: "assistant", content: reply });
                await this.save(s);

                return Response.json({
                    reply,
                    followUps,
                    dealMemory: s.dealMemory,
                    rollingSummary: s.rollingSummary,
                    userTurnCount: s.userTurnCount,
                });

            } catch (err) {
                // Fallback for catastrophic failure
                return Response.json({
                    reply: "I'm having trouble connecting. Could you repeat that?",
                    followUps: [],
                    dealMemory: (await this.load()).dealMemory,
                    rollingSummary: "",
                    userTurnCount: 0
                });
            }
        }

        // --- /internal/state ---
        if (url.pathname === "/internal/state" && request.method === "GET") {
            const s = await this.load();
            return Response.json(s);
        }

        // --- /internal/save-final ---
        if (url.pathname === "/internal/save-final" && request.method === "POST") {
            const { final } = await request.json<{ final: any }>();
            const s = await this.load();
            s.final = final;
            await this.save(s);
            return Response.json({ ok: true });
        }

        // --- /internal/reset ---
        if (url.pathname === "/internal/reset" && request.method === "POST") {
            await this.ctx.storage.deleteAll();
            return Response.json({ ok: true, message: "State reset" });
        }

        return new Response("Not found", { status: 404 });
    }
}
