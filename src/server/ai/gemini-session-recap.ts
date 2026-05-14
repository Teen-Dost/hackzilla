import { z } from "zod";
import { getServerEnv } from "@/lib/env/server";
import { logger } from "@/lib/logger";

const recapSchema = z.object({
  summaryMarkdown: z.string().min(1),
  keyPoints: z.array(z.string()).min(1).max(8),
  misconceptionsAddressed: z.array(z.string()).max(5).optional().default([]),
  recommendedNextSteps: z.array(z.string()).max(6).optional().default([]),
  tutorStrengthsObserved: z.array(z.string()).max(4).optional().default([]),
});

export type SessionRecapPayload = z.infer<typeof recapSchema>;

export function formatSessionRecapMarkdown(payload: SessionRecapPayload): string {
  const lines: string[] = [`## Session recap\n`, payload.summaryMarkdown.trim(), `\n`];
  if (payload.keyPoints.length) {
    lines.push(`\n### Key takeaways\n`, ...payload.keyPoints.map((k) => `- ${k}`), `\n`);
  }
  if (payload.misconceptionsAddressed.length) {
    lines.push(`\n### Misconceptions & clarifications\n`, ...payload.misconceptionsAddressed.map((k) => `- ${k}`), `\n`);
  }
  if (payload.recommendedNextSteps.length) {
    lines.push(`\n### Recommended next steps\n`, ...payload.recommendedNextSteps.map((k) => `- ${k}`), `\n`);
  }
  if (payload.tutorStrengthsObserved.length) {
    lines.push(`\n### Tutor strengths (from the thread)\n`, ...payload.tutorStrengthsObserved.map((k) => `- ${k}`), `\n`);
  }
  return lines.join("\n");
}

type MessageLine = { speaker: string; body: string };

/**
 * Calls Gemini when `GEMINI_API_KEY` is set; otherwise returns `null` so callers can fall back.
 */
export async function generateSessionRecapWithGemini(input: {
  requestTitle: string;
  requestBody?: string;
  subjectSlug?: string;
  messages: MessageLine[];
}): Promise<SessionRecapPayload | null> {
  let env: ReturnType<typeof getServerEnv>;
  try {
    env = getServerEnv();
  } catch {
    return null;
  }
  const apiKey = env.GEMINI_API_KEY;
  if (!apiKey) return null;

  const model = env.GEMINI_MODEL ?? "gemini-2.0-flash";
  const transcript =
    input.messages.length === 0
      ? "(No chat messages — whiteboard-only or very short session.)"
      : input.messages.map((m) => `${m.speaker}: ${m.body}`).join("\n");

  const prompt = `You are an expert learning scientist and tutor coach. Analyze this peer tutoring session and return ONLY valid JSON (no markdown code fences) matching this shape:
{
  "summaryMarkdown": "string in markdown: 2-4 short paragraphs on what happened and what the learner likely gained",
  "keyPoints": ["3-6 strings: concrete concepts or skills touched"],
  "misconceptionsAddressed": ["0-3 strings, or empty array"],
  "recommendedNextSteps": ["2-4 actionable items for the student"],
  "tutorStrengthsObserved": ["1-3 specific strengths you infer from how the tutor explained or scaffolded — cite behaviors, not flattery"]
}

Session title: ${input.requestTitle}
Subject slug: ${input.subjectSlug ?? "general"}
Request context (may be truncated):
${(input.requestBody ?? "").slice(0, 2000)}

Chat transcript (chronological):
${transcript.slice(0, 24_000)}`;

  const url = `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent?key=${encodeURIComponent(apiKey)}`;

  const res = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      contents: [{ role: "user", parts: [{ text: prompt }] }],
      generationConfig: {
        temperature: 0.35,
        maxOutputTokens: 2048,
        responseMimeType: "application/json",
        responseSchema: {
          type: "object",
          properties: {
            summaryMarkdown: { type: "string" },
            keyPoints: { type: "array", items: { type: "string" } },
            misconceptionsAddressed: { type: "array", items: { type: "string" } },
            recommendedNextSteps: { type: "array", items: { type: "string" } },
            tutorStrengthsObserved: { type: "array", items: { type: "string" } },
          },
          required: ["summaryMarkdown", "keyPoints"],
        },
      },
    }),
  });

  if (!res.ok) {
    const errText = await res.text().catch(() => "");
    logger.error("gemini.session_recap.http_error", { status: res.status, errText: errText.slice(0, 500) });
    return null;
  }

  const raw: unknown = await res.json();
  const text = extractGeminiText(raw);
  if (!text) {
    logger.error("gemini.session_recap.empty_text", {});
    return null;
  }

  let json: unknown;
  try {
    json = JSON.parse(text);
  } catch {
    logger.error("gemini.session_recap.json_parse", { text: text.slice(0, 400) });
    return null;
  }

  const parsed = recapSchema.safeParse(json);
  if (!parsed.success) {
    logger.error("gemini.session_recap.schema", { issues: parsed.error.flatten() });
    return null;
  }
  return parsed.data;
}

function extractGeminiText(body: unknown): string | null {
  if (!body || typeof body !== "object") return null;
  const candidates = (body as { candidates?: unknown }).candidates;
  if (!Array.isArray(candidates) || !candidates[0]) return null;
  const c0 = candidates[0] as { content?: { parts?: unknown } };
  const parts = c0.content?.parts;
  if (!Array.isArray(parts) || !parts[0]) return null;
  const t = (parts[0] as { text?: unknown }).text;
  return typeof t === "string" ? t : null;
}
