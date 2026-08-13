import "dotenv/config";
import { z } from "zod";
import { isSea } from "../lib/seaPaths";

// Le binaire empaquete (Node SEA, voir scripts/build-sea.js) est TOUJOURS un
// build de production, quel que soit l'environnement de la machine qui l'a
// compile - contrairement a `npm run dev`/`npm start`, "mode developpement"
// n'a aucun sens pour un .exe installe chez un cabinet. Sans ce forçage,
// NODE_ENV retombe sur le defaut Zod ci-dessous ("development") des que rien
// ne le positionne explicitement dans l'environnement du sidecar Tauri (voir
// src-tauri/src/main.rs, qui ne le fait pas) - ou pire, reprend par erreur la
// valeur d'un .env de developpement local copie a cote de l'executable lors
// d'un build fait a la main (voir copyCompanionFiles dans build-sea.js).
// Applique APRES `dotenv/config` ci-dessus (qui a deja charge un eventuel
// .env dans process.env) pour ecraser inconditionnellement toute valeur
// venue de cette source, jamais avant.
if (isSea()) {
  process.env.NODE_ENV = "production";
}

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

    // Lot 12b : identifiants OAuth2 de l'application Aurore aupres de Google
    // (Google Cloud Console - un seul jeu de credentials pour toutes les
    // installations, chaque UTILISATEUR effectuant ensuite sa propre
    // connexion individuelle - voir README-LOT12B.md). Distinct de l'ancien
    // GOOGLE_CLIENT_ID/GOOGLE_CLIENT_SECRET (lien Google Docs via n8n,
    // retire au Lot 8ter) - jamais reutilise, portee differente.
    GOOGLE_CALENDAR_OAUTH_CLIENT_ID: z.string().optional(),
    GOOGLE_CALENDAR_OAUTH_CLIENT_SECRET: z.string().optional(),
    // Doit correspondre EXACTEMENT a l'URI de redirection autorisee dans
    // Google Cloud Console (ex: http://127.0.0.1:3000/api/calendrier-externe/google/callback).
    GOOGLE_CALENDAR_OAUTH_REDIRECT_URI: z.string().optional(),

    // Lot 16 : redirect_uri du flux OAuth Gmail (ingestion email) - route
    // DISTINCTE de celle du calendrier ci-dessus (scope gmail.readonly, pas
    // calendar.events), meme si le MEME client OAuth Google Cloud
    // (GOOGLE_CALENDAR_OAUTH_CLIENT_ID/SECRET ci-dessus) est reutilise -
    // voir README-LOT16.md. Doit correspondre EXACTEMENT a l'URI de
    // redirection autorisee dans Google Cloud Console.
    GMAIL_INGESTION_OAUTH_REDIRECT_URI: z.string().optional(),

    // Email (Brevo) - envoi direct des documents et emails, canal externe
    // unique (voir README-LOT8TER.md - l'ancien circuit n8n est retire).
    // Adresse d'expedition unique pour tous les cabinets (domaine Aurore
    // verifie via SPF/DKIM chez Brevo) ; le nom affiche et le Reply-To
    // varient par cabinet (voir cabinetContact.ts).
    //
    // Lot 19 : l'envoi passe desormais par l'API REST Brevo (BREVO_API_KEY,
    // voir services/mailer.ts) plutot que par SMTP (Nodemailer) - le relais
    // SMTP de Brevo reecrivait le Message-ID cote serveur, rendant tout
    // matching fiable impossible. SMTP_HOST/PORT/USER/PASSWORD ne sont plus
    // lus par mailer.ts mais restent definis ici (secrets deja en place,
    // aucune raison de les purger) ; SMTP_FROM_EMAIL reste utilisee comme
    // adresse d'expedition ("sender") de l'API REST.
    SMTP_HOST: z.string().optional(),
    SMTP_PORT: z.coerce.number().optional(),
    SMTP_USER: z.string().optional(),
    SMTP_PASSWORD: z.string().optional(),
    SMTP_FROM_EMAIL: z.string().optional(),
    BREVO_API_KEY: z.string().optional(),

    SESSION_SECRET: z
      .string()
      .min(16, "SESSION_SECRET doit faire au moins 16 caracteres (voir .env.example)"),

    // Lot 15 : taille maximale (en Mo) d'une piece uploadee sur un dossier
    // (services/stockageDocuments.ts, routes/documentsDossier.ts) - defaut
    // raisonnable pour un usage documentaire cabinet (scans, correspondances).
    DOCUMENTS_TAILLE_MAX_MO: z.coerce.number().positive().default(20),
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
