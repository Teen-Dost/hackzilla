import { z } from "zod";

/**
 * Centralized server-side env parsing — WHY: fail fast on first access, not at arbitrary import order.
 */
const serverSchema = z.object({
  NODE_ENV: z.enum(["development", "test", "production"]).default("development"),
  DATABASE_URL: z.string().min(1),
  DIRECT_URL: z.string().min(1).optional(),

  CLERK_SECRET_KEY: z.string().min(1),
  CLERK_WEBHOOK_SECRET: z.string().min(1).optional(),

  OPENAI_API_KEY: z.string().min(1).optional(),

  /** Google AI Studio key — session recap + post-session insights when set. */
  GEMINI_API_KEY: z.preprocess((val) => {
    if (val == null) return undefined;
    let s = String(val).trim();
    if (!s) return undefined;
    if ((s.startsWith('"') && s.endsWith('"')) || (s.startsWith("'") && s.endsWith("'"))) {
      s = s.slice(1, -1).trim();
    }
    return s || undefined;
  }, z.string().min(1).optional()),
  /** Optional override, e.g. `gemini-2.0-flash` or `gemini-1.5-flash`. */
  GEMINI_MODEL: z.preprocess((val) => {
    if (val == null) return undefined;
    const s = String(val).trim();
    return s || undefined;
  }, z.string().min(1).optional()),

  SOCKET_SERVER_URL: z.string().min(1).optional(),
  SOCKET_JWT_SECRET: z.string().min(16).optional(),
  /** Next → socket dev server (e.g. http://127.0.0.1:3001) for `publishQueryInvalidate`. */
  SOCKET_SERVER_INTERNAL_URL: z.string().min(1).optional(),
  /** Shared secret for `POST /internal/publish` on the socket server. */
  SOCKET_INTERNAL_SECRET: z.string().min(16).optional(),

  REDIS_URL: z.string().min(1).optional(),

  AI_QUEUE_SECRET: z.string().optional(),
});

export type ServerEnv = z.infer<typeof serverSchema>;

let _env: ServerEnv | null = null;

export function getServerEnv(): ServerEnv {
  if (!_env) {
    const parsed = serverSchema.safeParse(process.env);
    if (!parsed.success) {
      console.error("Invalid server environment", parsed.error.flatten().fieldErrors);
      throw new Error("Invalid server environment variables");
    }
    _env = parsed.data;
  }
  /** Re-read Gemini vars from `process.env` each time — avoids stale cache if the key was added after first access. */
  const geminiRefresh = serverSchema.pick({ GEMINI_API_KEY: true, GEMINI_MODEL: true }).safeParse(process.env);
  if (!geminiRefresh.success) return _env;
  return { ..._env, ...geminiRefresh.data };
}
