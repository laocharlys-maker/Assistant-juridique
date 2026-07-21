import "dotenv/config";
import { z } from "zod";

const envSchema = z
  .object({
    DATABASE_URL: z.string().min(1, "DATABASE_URL est requis (voir .env.example)"),
    PORT: z.coerce.number().default(3000),
    NODE_ENV: z.enum(["development", "production", "test"]).default("development"),

    LLM_PROVIDER: z.enum(["gemini", "anthropic", "groq"]).default("gemini"),
    GEMINI_API_KEY: z.string().optional(),
    ANTHROPIC_API_KEY: z.string().optional(),
    GROQ_API_KEY: z.string().optional(),
    TAVILY_API_KEY: z.string().optional(),

    N8N_WEBHOOK_BASE_URL: z.string().optional(),
    N8N_WEBHOOK_SECRET: z.string().optional(),
  })
  .superRefine((values, ctx) => {
    if (values.LLM_PROVIDER === "gemini" && !values.GEMINI_API_KEY) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["GEMINI_API_KEY"],
        message: "GEMINI_API_KEY est requis quand LLM_PROVIDER=gemini",
      });
    }
    if (values.LLM_PROVIDER === "anthropic" && !values.ANTHROPIC_API_KEY) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["ANTHROPIC_API_KEY"],
        message: "ANTHROPIC_API_KEY est requis quand LLM_PROVIDER=anthropic",
      });
    }
    if (values.LLM_PROVIDER === "groq" && !values.GROQ_API_KEY) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["GROQ_API_KEY"],
        message: "GROQ_API_KEY est requis quand LLM_PROVIDER=groq",
      });
    }
  });

export const env = envSchema.parse(process.env);
