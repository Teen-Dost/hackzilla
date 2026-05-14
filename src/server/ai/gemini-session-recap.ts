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

/** Reduces false blocks on academic / tutoring transcripts (AI Studio). */
const safetySettings = [
  { category: "HARM_CATEGORY_HARASSMENT", threshold: "BLOCK_ONLY_HIGH" },
  { category: "HARM_CATEGORY_HATE_SPEECH", threshold: "BLOCK_ONLY_HIGH" },
  { category: "HARM_CATEGORY_SEXUALLY_EXPLICIT", threshold: "BLOCK_ONLY_HIGH" },
  { category: "HARM_CATEGORY_DANGEROUS_CONTENT", threshold: "BLOCK_ONLY_HIGH" },
] as const;

/** `v1` first — some model aliases resolve here while `v1beta` returns 404. */
const API_VERSIONS = ["v1", "v1beta"] as const;

const DEFAULT_MODELS = [
  "gemini-2.0-flash-lite",
  "gemini-2.0-flash",
  "gemini-2.0-flash-001",
  "gemini-1.5-flash-8b",
  "gemini-1.5-flash-8b-latest",
] as const;

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

/** Parses `Please retry in 58.03s` from Gemini 429 bodies. */
function parseRetryAfterMs(errText: string): number | null {
  const m = errText.match(/retry in ([\d.]+)\s*s/i);
  if (!m) return null;
  const sec = Number(m[1]);
  if (!Number.isFinite(sec) || sec < 0) return null;
  return Math.min(65_000, Math.ceil(sec * 1000) + 400);
}

type FetchOutcome =
  | { ok: true; raw: unknown }
  | { ok: false; status: number; errText: string };

async function postGenerateContent(url: string, body: object): Promise<FetchOutcome> {
  const res = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  const errText = await res.text();
  if (!res.ok) {
    return { ok: false, status: res.status, errText };
  }
  try {
    return { ok: true, raw: JSON.parse(errText) };
  } catch {
    return { ok: false, status: res.status, errText: errText.slice(0, 200) };
  }
}

async function postWith429Retry(url: string, body: object, model: string, mode: string): Promise<FetchOutcome> {
  let out = await postGenerateContent(url, body);
  if (!out.ok && out.status === 429) {
    const wait = parseRetryAfterMs(out.errText) ?? 3500;
    logger.warn("gemini.session_recap.rate_limit_wait", { model, mode, waitMs: wait });
    await sleep(wait);
    out = await postGenerateContent(url, body);
  }
  return out;
}

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

  const modelsToTry = [env.GEMINI_MODEL, ...DEFAULT_MODELS].filter((m, i, a): m is string => Boolean(m) && a.indexOf(m) === i);

  const transcript =
    input.messages.length === 0
      ? "(No chat messages — whiteboard-only or very short session.)"
      : input.messages.map((m) => `${m.speaker}: ${m.body}`).join("\n");

  const jsonShape = `Return a single JSON object (no markdown fences) with this exact shape:
{
  "summaryMarkdown": "markdown string, 2-4 short paragraphs",
  "keyPoints": ["3-6 short strings"],
  "misconceptionsAddressed": ["0-3 strings or empty array"],
  "recommendedNextSteps": ["2-4 strings"],
  "tutorStrengthsObserved": ["1-3 strings"]
}`;

  const sessionBlock = `Session title: ${input.requestTitle}
Subject slug: ${input.subjectSlug ?? "general"}
Request context (may be truncated):
${(input.requestBody ?? "").slice(0, 2000)}

Chat transcript (chronological):
${transcript.slice(0, 24_000)}`;

  const promptJsonMode = `You are an expert learning scientist and tutor coach. Analyze this peer tutoring session.
${jsonShape}

${sessionBlock}`;

  const promptTextMode = `You are an expert learning scientist and tutor coach. Analyze this peer tutoring session.
${jsonShape}
Rules: Output ONLY the JSON object. No prose before or after. No markdown code fences.

${sessionBlock}`;

  const modes: Array<{ name: "json_mime" | "text_plain"; generationConfig: Record<string, unknown>; prompt: string }> = [
    {
      name: "json_mime",
      generationConfig: {
        temperature: 0.35,
        maxOutputTokens: 8192,
        responseMimeType: "application/json",
      },
      prompt: promptJsonMode,
    },
    {
      name: "text_plain",
      generationConfig: {
        temperature: 0.35,
        maxOutputTokens: 8192,
      },
      prompt: promptTextMode,
    },
  ];

  for (const apiVersion of API_VERSIONS) {
    for (const model of modelsToTry) {
      for (const mode of modes) {
        const url = `https://generativelanguage.googleapis.com/${apiVersion}/models/${model}:generateContent?key=${encodeURIComponent(apiKey)}`;
        const body = {
          contents: [{ role: "user", parts: [{ text: mode.prompt }] }],
          safetySettings,
          generationConfig: mode.generationConfig,
        };

        const out = await postWith429Retry(url, body, model, mode.name);
        if (!out.ok) {
          logger.warn("gemini.session_recap.http_error", {
            apiVersion,
            model,
            mode: mode.name,
            status: out.status,
            errText: out.errText.slice(0, 800),
          });
          if (out.status === 404) {
            break;
          }
          continue;
        }

        if (out.raw && typeof out.raw === "object" && "error" in out.raw) {
          logger.warn("gemini.session_recap.api_error", { apiVersion, model, mode: mode.name, error: (out.raw as { error?: unknown }).error });
          continue;
        }

        const blocked = logIfBlocked(out.raw, apiVersion, model, mode.name);
        if (blocked) continue;

        const text = extractGeminiText(out.raw);
        if (!text?.trim()) {
          logger.warn("gemini.session_recap.empty_text", {
            apiVersion,
            model,
            mode: mode.name,
            rawKeys: out.raw && typeof out.raw === "object" ? Object.keys(out.raw) : [],
          });
          continue;
        }

        const json = parseJsonLenient(text);
        if (!json) {
          logger.warn("gemini.session_recap.json_parse", { apiVersion, model, mode: mode.name, text: text.slice(0, 500) });
          continue;
        }

        const normalized = normalizeRecapPayload(json);
        if (normalized) {
          return normalized;
        }

        const parsed = recapSchema.safeParse(json);
        if (parsed.success) {
          return parsed.data;
        }
        logger.warn("gemini.session_recap.schema", { apiVersion, model, mode: mode.name, issues: parsed.error.flatten() });
      }
    }
  }

  return null;
}

function logIfBlocked(body: unknown, apiVersion: string, model: string, mode: string): boolean {
  if (!body || typeof body !== "object") return false;
  const b = body as {
    promptFeedback?: { blockReason?: string };
    candidates?: Array<{ finishReason?: string }>;
  };
  const pr = b.promptFeedback?.blockReason;
  if (pr) {
    logger.warn("gemini.session_recap.blocked_prompt", { apiVersion, model, mode, blockReason: pr });
    return true;
  }
  const c0 = b.candidates?.[0];
  if (c0?.finishReason && c0.finishReason !== "STOP" && c0.finishReason !== "MAX_TOKENS") {
    logger.warn("gemini.session_recap.finish_reason", { apiVersion, model, mode, finishReason: c0.finishReason });
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
      /* fall through */
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

function coerceStringArray(v: unknown): string[] {
  if (v == null) return [];
  if (Array.isArray(v)) return v.map((x) => String(x).trim()).filter(Boolean);
  if (typeof v === "string") {
    const t = v.trim();
    return t ? [t] : [];
  }
  return [];
}

/** Accepts common alternate keys / shapes models return. */
function normalizeRecapPayload(json: unknown): SessionRecapPayload | null {
  if (!json || typeof json !== "object") return null;
  const o = json as Record<string, unknown>;
  const mdRaw = o.summaryMarkdown ?? o.summary ?? o.session_summary ?? o.recap ?? o.overview;
  const summaryMarkdown = typeof mdRaw === "string" ? mdRaw.trim() : "";
  if (!summaryMarkdown) return null;

  let keyPoints = coerceStringArray(o.keyPoints ?? o.key_points ?? o.takeaways ?? o.highlights);
  if (keyPoints.length === 0) {
    keyPoints = ["Review the chat above for specifics."];
  }

  return {
    summaryMarkdown,
    keyPoints: keyPoints.slice(0, 8),
    misconceptionsAddressed: coerceStringArray(o.misconceptionsAddressed ?? o.misconceptions ?? o.misconceptionAddressed).slice(0, 5),
    recommendedNextSteps: coerceStringArray(o.recommendedNextSteps ?? o.nextSteps ?? o.followUp).slice(0, 6),
    tutorStrengthsObserved: coerceStringArray(o.tutorStrengthsObserved ?? o.tutorStrengths ?? o.tutor_highlights).slice(0, 4),
  };
}

function extractGeminiText(body: unknown): string | null {
  if (!body || typeof body !== "object") return null;
  const candidates = (body as { candidates?: unknown }).candidates;
  if (!Array.isArray(candidates) || !candidates[0]) return null;
  const c0 = candidates[0] as { content?: { parts?: unknown } };
  const parts = c0.content?.parts;
  if (!Array.isArray(parts) || parts.length === 0) return null;

  const chunks: string[] = [];
  for (const p of parts) {
    if (p && typeof p === "object" && "text" in p) {
      const t = (p as { text?: unknown }).text;
      if (typeof t === "string" && t.length) chunks.push(t);
    }
  }
  if (chunks.length === 0) return null;
  return chunks.join("");
}
