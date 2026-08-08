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

/**
 * A utiliser PARTOUT a la place d'un `instanceof MissingConfigurationError`
 * nu. Constat en production (voir README-LOT7.md, section 4.4) : un
 * `MissingConfigurationError` reellement leve par
 * services/llm/gemini.ts a echappe a TOUS les `instanceof
 * MissingConfigurationError` locaux (routes/webActions.ts) ET global
 * (index.ts, handleFatalError), provoquant l'arret complet du process pour
 * une simple cle API manquante - exactement le cas que ces garde-fous
 * doivent empecher. `instanceof` compare l'identite du prototype ; dans un
 * bundle Node SEA obfusque fichier par fichier puis assemble par esbuild,
 * rien ne garantit qu'une seule instance de la classe circule partout (pas
 * reproduit isolement mais observe de facon repetee en production). `name`
 * est en revanche une propriete simple posee sur l'instance elle-meme dans
 * le constructeur : elle survit a n'importe quelle divergence de prototype
 * entre modules/bundles.
 */
export function isMissingConfigurationError(error: unknown): error is MissingConfigurationError {
  return error instanceof MissingConfigurationError || (error instanceof Error && error.name === "MissingConfigurationError");
}
