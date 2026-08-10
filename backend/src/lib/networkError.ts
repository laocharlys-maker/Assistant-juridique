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
 * Quota/facturation Gemini epuise (constate en usage reel : "429 Too Many
 * Requests" + "Your prepayment credits are depleted", @google/generative-ai
 * leve alors un GoogleGenerativeAIFetchError avec `status: 429`) - jamais un
 * bug de l'application, mais un compte AI Studio a recharger
 * (https://ai.studio/projects). Verifie `status` (propriete simple, fiable
 * meme dans un bundle SEA obfusque) plutot qu'un `instanceof` sur la classe
 * de la librairie tierce - voir le meme choix documente dans
 * configurationError.ts pour la raison exacte.
 */
export function isGeminiQuotaError(error: unknown): boolean {
  return typeof error === "object" && error !== null && (error as { status?: unknown }).status === 429;
}
