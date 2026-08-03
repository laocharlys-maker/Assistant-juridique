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
  });
// Pas de superRefine imposant la cle du LLM_PROVIDER actif : ce serait
// redondant avec la garde deja presente dans chaque fabrique de provider
// (createGeminiProvider/createGroqProvider/createAnthropicProvider dans
// services/llm/*.ts, qui levent "XXX_API_KEY manquant" au moment ou une
// fonctionnalite IA est reellement utilisee) - et surtout, une validation
// ici ferait planter TOUT le demarrage de l'app pour une cle manquante,
// ce qui est disproportionne (Lot 8 : l'installeur ne peut livrer aucune
// cle API, jamais commise/partagee entre cabinets - voir README-LOT8.md).
// Un cabinet sans cle configuree peut donc ouvrir l'app et utiliser tout
// ce qui ne depend pas de l'IA ; seules les actions IA echouent, avec un
// message clair.

export const env = envSchema.parse(process.env);
