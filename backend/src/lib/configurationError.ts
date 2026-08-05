/**
 * Erreur de configuration connue et documentee (cle API absente...) - jamais
 * une panne inattendue. Distincte d'une Error generique pour que le filet de
 * securite global (process.on("uncaughtException"/"unhandledRejection"),
 * voir index.ts) puisse la reconnaitre de facon fiable (instanceof, pas du
 * pattern-matching fragile sur un message texte) si jamais elle echappe a
 * tout catch local : dans ce cas precis, JAMAIS arreter le process pour une
 * simple fonctionnalite non configuree, contrairement a une erreur vraiment
 * inattendue.
 *
 * Utilisee par services/embeddings.ts (embeddings Gemini pour le RAG
 * jurisprudence) et services/llm/*.ts (cle API du fournisseur LLM actif) -
 * chaque appelant DOIT neanmoins la catcher localement et renvoyer une
 * reponse HTTP claire (503) plutot que de compter sur le filet global, qui
 * reste un dernier recours, pas la strategie de gestion d'erreur normale.
 */
export class MissingConfigurationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "MissingConfigurationError";
  }
}
