import { WorkflowEntrypoint, WorkflowEvent, WorkflowStep } from "cloudflare:workers";
import type { Env } from "./types";

type Final = {
    summaryBullets: string[];
    actionItems: { owner: "Rep" | "Customer"; item: string }[];
    followupEmail: string;
};

// Reuse robust JSON extraction helper
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

function extractJsonObject(text: string): string | null {
    const start = text.indexOf("{");
    const end = text.lastIndexOf("}");
    if (start === -1 || end === -1 || end <= start) return null;
    return text.slice(start, end + 1);
}

export class FinalizeCallWorkflow extends WorkflowEntrypoint<Env, { sessionId: string }> {
    async run(event: WorkflowEvent<{ sessionId: string }>, step: WorkflowStep) {
        const { sessionId } = event.payload;
        if (!sessionId) throw new Error("Missing sessionId in workflow payload");

        const env = this.env;

        // Read session state from Durable Object
        const id = env.SALES_AGENT.idFromName(sessionId);
        const stub = env.SALES_AGENT.get(id);

        const stateResp = await stub.fetch("https://do/internal/state");
        const s = await stateResp.json<any>();

        const model = "@cf/meta/llama-3.3-70b-instruct-fp8-fast";
        const convo = (s.messages ?? [])
            .map((m: any) => `${m.role.toUpperCase()}: ${m.content}`)
            .join("\n");

        // Step 1: Summary bullets
        const sumPrompt = `
Return ONLY valid JSON:
{ "summaryBullets": string[] }  // exactly 6 bullets max
Conversation:
${convo}
`.trim();

        const sumResp = await env.AI.run(model, {
            messages: [{ role: "user", content: sumPrompt }],
        });

        const sumRaw = normalizeAIText(sumResp);
        const sumJson = extractJsonObject(sumRaw) ?? sumRaw;

        let summaryBullets: string[] = [];
        try {
            const sumParsed = JSON.parse(sumJson);
            summaryBullets = Array.isArray(sumParsed.summaryBullets) ? sumParsed.summaryBullets : [];
        } catch (e) {
            console.error("Failed to parse summary bullets", e);
        }

        // Step 2: Action items
        const actionPrompt = `
Return ONLY valid JSON:
{ "actionItems": [{"owner":"Rep"|"Customer","item":string}] }
Based on this summary:
${summaryBullets.map((b) => `- ${b}`).join("\n")}
`.trim();

        const actResp = await env.AI.run(model, {
            messages: [{ role: "user", content: actionPrompt }],
        });

        const actRaw = normalizeAIText(actResp);
        const actJson = extractJsonObject(actRaw) ?? actRaw;

        let actionItems: any[] = [];
        try {
            const actParsed = JSON.parse(actJson);
            actionItems = Array.isArray(actParsed.actionItems) ? actParsed.actionItems : [];
        } catch (e) {
            console.error("Failed to parse action items", e);
        }

        // Step 3: Follow-up email
        const emailPrompt = `
Write a concise follow-up email (120-180 words).
Context:
- Summary: ${summaryBullets.join(" ")}
- Next steps: ${actionItems.map((a: any) => `${a.owner}: ${a.item}`).join("; ")}
Return ONLY plain text. No subject line.
`.trim();

        const emailResp = await env.AI.run(model, {
            messages: [{ role: "user", content: emailPrompt }],
        });

        const followupEmail = normalizeAIText(emailResp).trim();

        const final: Final = {
            summaryBullets: summaryBullets.slice(0, 6),
            actionItems,
            followupEmail,
        };

        // Save final output back into Durable Object
        await stub.fetch("https://do/internal/save-final", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ final }),
        });

        return { ok: true, sessionId };
    }
}
