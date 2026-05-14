import { z } from "zod";
import { getServerEnv } from "@/lib/env/server";
import { logger } from "@/lib/logger";

const recapSchema = z.object({
  summaryMarkdown: z.string().min(1),
  keyPoints: z.array(z.string()).min(1).max(8),
  misconceptionsAddressed: z.array(z.string()).max(5).nullish().transform((v) => v ?? []),
  recommendedNextSteps: z.array(z.string()).max(6).nullish().transform((v) => v ?? []),
  tutorStrengthsObserved: z.array(z.string()).max(4).nullish().transform((v) => v ?? []),
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

  /** Prefer env override; fall back to widely available models (responseSchema is omitted — it often 400s on AI Studio). */
  const modelsToTry = [env.GEMINI_MODEL, "gemini-2.0-flash", "gemini-2.0-flash-001", "gemini-1.5-flash", "gemini-1.5-flash-latest"].filter(
    (m, i, a): m is string => Boolean(m) && a.indexOf(m) === i,
  );
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

  const requestBody = {
    contents: [{ role: "user", parts: [{ text: prompt }] }],
    generationConfig: {
      temperature: 0.35,
      maxOutputTokens: 4096,
      responseMimeType: "application/json",
    },
  };

  for (const model of modelsToTry) {
    const url = `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent?key=${encodeURIComponent(apiKey)}`;
    const res = await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(requestBody),
    });

    if (!res.ok) {
      const errText = await res.text().catch(() => "");
      logger.warn("gemini.session_recap.http_error", {
        model,
        status: res.status,
        errText: errText.slice(0, 600),
      });
      continue;
    }

    const raw: unknown = await res.json();
    const blocked = logIfBlocked(raw, model);
    if (blocked) continue;

    const text = extractGeminiText(raw);
    if (!text) {
      logger.warn("gemini.session_recap.empty_text", { model });
      continue;
    }

    const json = parseJsonLenient(text);
    if (!json) {
      logger.warn("gemini.session_recap.json_parse", { model, text: text.slice(0, 400) });
      continue;
    }

    const parsed = recapSchema.safeParse(json);
    if (!parsed.success) {
      logger.warn("gemini.session_recap.schema", { model, issues: parsed.error.flatten() });
      continue;
    }
    return parsed.data;
  }

  return null;
}

function logIfBlocked(body: unknown, model: string): boolean {
  if (!body || typeof body !== "object") return false;
  const b = body as {
    promptFeedback?: { blockReason?: string };
    candidates?: Array<{ finishReason?: string; safetyRatings?: unknown }>;
  };
  const pr = b.promptFeedback?.blockReason;
  if (pr) {
    logger.warn("gemini.session_recap.blocked_prompt", { model, blockReason: pr });
    return true;
  }
  const c0 = b.candidates?.[0];
  if (c0?.finishReason && c0.finishReason !== "STOP" && c0.finishReason !== "MAX_TOKENS") {
    logger.warn("gemini.session_recap.finish_reason", { model, finishReason: c0.finishReason });
    return c0.finishReason === "SAFETY" || c0.finishReason === "BLOCKLIST" || c0.finishReason === "PROHIBITED_CONTENT";
  }
  return false;
}

function parseJsonLenient(text: string): unknown | null {
  const trimmed = text.trim();
  try {
    return JSON.parse(trimmed);
  } catch {
    /* fall through */
  }
  const fence = trimmed.match(/```(?:json)?\s*([\s\S]*?)```/i);
  if (fence?.[1]) {
    try {
      return JSON.parse(fence[1].trim());
    } catch {
      return null;
    }
  }
  const start = trimmed.indexOf("{");
  const end = trimmed.lastIndexOf("}");
  if (start >= 0 && end > start) {
    try {
      return JSON.parse(trimmed.slice(start, end + 1));
    } catch {
      return null;
    }
  }
  return null;
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
