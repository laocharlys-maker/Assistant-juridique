/**
 * Identifiants de services externes partages AzoMedIA, embarques dans le
 * binaire desktop (Lot 8) pour que l'app fonctionne offline sans que chaque
 * cabinet ait a saisir ses propres cles - decision commerciale Option A
 * (voir README-LOT8.md). Couvre : LLM (Groq/Gemini) et recherche web
 * (Tavily) - meme decision, meme mecanisme - ainsi que l'envoi d'email
 * (SMTP/Brevo), un seul compte d'envoi pour tous les cabinets.
 *
 * Ce fichier reste un PLACEHOLDER VIDE dans le depot git - jamais de vraie
 * valeur commise ici. Le workflow CI (.github/workflows/build-windows-installer.yml)
 * le REECRIT avec les vraies valeurs (lues depuis les GitHub Secrets
 * correspondants) juste avant `npm run build:sea`, uniquement sur le disque
 * ephemere du runner - jamais commis en retour. Voir index.ts pour comment
 * ces valeurs sont ensuite injectees dans process.env (meme principe que
 * SESSION_SECRET juste au-dessus dans ce fichier : ne s'applique qu'en
 * DATABASE_MODE=portable, et seulement si aucun .env ne fournit deja la
 * variable - le mode VPS/externe garde son propre .env reel, inchange).
 *
 * En developpement local ou pour un build VPS, ce fichier reste tel quel
 * (undefined) : aucun effet, comportement identique a avant l'ajout de ce
 * mecanisme.
 */
export const BUNDLED_GEMINI_API_KEY: string | undefined = undefined;
export const BUNDLED_GROQ_API_KEY: string | undefined = undefined;
// Recherche juridique, recherche/resume de jurisprudence et veille
// juridique : forcent Anthropic (voir services/llm/index.ts,
// getAnthropicProviderForced) - decision AzoMedIA du 2026-08-14.
export const BUNDLED_ANTHROPIC_API_KEY: string | undefined = undefined;
export const BUNDLED_TAVILY_API_KEY: string | undefined = undefined;
export const BUNDLED_SMTP_HOST: string | undefined = undefined;
export const BUNDLED_SMTP_USER: string | undefined = undefined;
export const BUNDLED_SMTP_PASSWORD: string | undefined = undefined;
export const BUNDLED_SMTP_FROM_EMAIL: string | undefined = undefined;
// Lot 19 : cle de l'API REST Brevo (remplace l'envoi SMTP, voir
// services/mailer.ts) - BUNDLED_SMTP_HOST/USER/PASSWORD ci-dessus ne sont
// plus lues par mailer.ts mais restent definies sans effet.
export const BUNDLED_BREVO_API_KEY: string | undefined = undefined;
// Lot 12b : credentials OAuth2 Google de l'application Aurore elle-meme (pas
// un token utilisateur - ceux-la restent individuels, stockes chiffres par
// utilisateur dans ConnexionCalendrierExterne). Meme mecanisme que les cles
// ci-dessus.
export const BUNDLED_GOOGLE_CALENDAR_OAUTH_CLIENT_ID: string | undefined = undefined;
export const BUNDLED_GOOGLE_CALENDAR_OAUTH_CLIENT_SECRET: string | undefined = undefined;
