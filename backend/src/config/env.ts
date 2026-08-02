import "dotenv/config";
import { z } from "zod";

const envSchema = z
  .object({
    DATABASE_URL: z.string().min(1, "DATABASE_URL est requis (voir .env.example)"),
    PORT: z.coerce.number().default(3000),
    // "0.0.0.0" par defaut pour ne pas casser le deploiement VPS existant
    // (reverse proxy Traefik). Le sidecar Tauri (packaging desktop) force
    // explicitement HOST=127.0.0.1 pour n'exposer le backend qu'en local.
    HOST: z.string().default("0.0.0.0"),
    NODE_ENV: z.enum(["development", "production", "test"]).default("development"),

    LLM_PROVIDER: z.enum(["gemini", "anthropic", "groq"]).default("gemini"),
    GEMINI_API_KEY: z.string().optional(),
    ANTHROPIC_API_KEY: z.string().optional(),
    GROQ_API_KEY: z.string().optional(),
    TAVILY_API_KEY: z.string().optional(),

    N8N_WEBHOOK_BASE_URL: z.string().optional(),
    N8N_WEBHOOK_SECRET: z.string().optional(),

    // SMTP (Brevo) - envoi direct des documents par email, sans passer par
    // n8n/Google Docs. Adresse d'expedition unique pour tous les cabinets
    // (domaine Aurore verifie via SPF/DKIM chez Brevo) ; le nom affiche et le
    // Reply-To varient par cabinet (voir cabinetContact.ts).
    SMTP_HOST: z.string().optional(),
    SMTP_PORT: z.coerce.number().optional(),
    SMTP_USER: z.string().optional(),
    SMTP_PASSWORD: z.string().optional(),
    SMTP_FROM_EMAIL: z.string().optional(),

    // URL publique de ce backend (utilisee pour construire des liens absolus,
    // ex: l'image de signature transmise a n8n). Vide en local si non expose.
    PUBLIC_BASE_URL: z.string().optional(),

    SESSION_SECRET: z
      .string()
      .min(16, "SESSION_SECRET doit faire au moins 16 caracteres (voir .env.example)"),
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
