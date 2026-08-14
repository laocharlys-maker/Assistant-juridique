/**
 * Detecte un echec reseau bas niveau (undici/fetch n'a pas pu joindre le
 * serveur distant - DNS, pare-feu, proxy, connexion internet coupee...),
 * distinct d'une erreur applicative (cle API invalide, quota depasse...).
 * Node/undici leve systematiquement un TypeError au message fixe "fetch
 * failed" dans ce cas, quelle que soit la cause reelle (dispo dans
 * error.cause, jamais affichee a l'utilisateur - non sensible mais pas
 * actionnable pour lui). Constate en usage reel (voir services/embeddings.ts,
 * appel Gemini pour le RAG jurisprudence) : sans ce message specifique,
 * l'utilisateur voit un message generique ("echec de l'indexation"/"erreur
 * interne") qui laisse a tort penser a un bug de l'application plutot qu'a
 * un probleme de connexion ponctuel.
 */
export function isNetworkFetchError(error: unknown): boolean {
  return error instanceof TypeError && error.message === "fetch failed";
}

/**
 * Quota/limite de debit epuise cote fournisseur IA (constate en usage reel
 * sous deux formes : "429 Too Many Requests" + "Your prepayment credits are
 * depleted" via @google/generative-ai - GoogleGenerativeAIFetchError avec
 * `status: 429` -, et "429 rate_limit_exceeded" via Groq - plafond de
 * tokens/minute de l'offre gratuite "on_demand", pas un manque de credit -
 * meme forme d'erreur `status: 429`). Jamais un bug de l'application.
 * Verifie `status` (propriete simple, fiable meme dans un bundle SEA
 * obfusque) plutot qu'un `instanceof` sur la classe de la librairie tierce -
 * voir le meme choix documente dans configurationError.ts pour la raison
 * exacte.
 *
 * IMPORTANT : cette fonction ne dit PAS quel fournisseur a repondu 429 (le
 * fournisseur actif differe selon le type d'action, voir
 * routes/webActions.ts, ACTIONS_FORCANT_ANTHROPIC) - un appelant qui
 * connait le fournisseur precis pour son propre contexte (ex:
 * routes/jurisprudenceBase.ts, ou seul Gemini est jamais appele pour les
 * embeddings) peut le nommer explicitement dans son message ; un appelant
 * generique (ex: le catch-all de POST /api/actions/web, qui couvre tous les
 * types d'action et donc potentiellement Groq, Anthropic ou Gemini) ne doit
 * JAMAIS nommer un fournisseur specifique au risque d'induire l'utilisateur
 * en erreur sur lequel recharger.
 */
export function isProviderQuotaError(error: unknown): boolean {
  return typeof error === "object" && error !== null && (error as { status?: unknown }).status === 429;
}
