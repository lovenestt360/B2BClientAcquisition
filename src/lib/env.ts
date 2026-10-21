import { z } from "zod";

const bool = z
  .string()
  .optional()
  .transform((v) => v === "true" || v === "1");

const schema = z.object({
  DATABASE_URL: z.string().min(1),
  APP_ENCRYPTION_KEY: z.string().optional(),
  COOKIE_SECURE: bool,
  APP_TIMEZONE: z.string().default("Africa/Johannesburg"),
  SIMULATION_MODE: z
    .string()
    .optional()
    .transform((v) => v !== "false"), // default ON
  ALLOW_AUTOMATED_OUTREACH: bool, // default OFF
  LLM_PROVIDER: z.enum(["mock", "ollama"]).default("mock"),
  OLLAMA_URL: z.string().default("http://localhost:11434"),
  OLLAMA_MODEL: z.string().default("llama3.1:8b"),
  STT_PROVIDER: z.enum(["mock", "http"]).default("mock"),
  STT_URL: z.string().default("http://localhost:8001"),
  TTS_PROVIDER: z.enum(["mock", "http"]).default("mock"),
  TTS_URL: z.string().default("http://localhost:8002"),
  ASTERISK_ARI_URL: z.string().optional(),
});

export type Env = z.infer<typeof schema>;

/** Parsed on every call so tests can override process.env. */
export function env(): Env {
  return schema.parse(process.env);
}
