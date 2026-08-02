import type { TokenMap } from "./pseudonymisation.types";

/**
 * Levee quand un ou plusieurs tokens de pseudonymisation subsistent dans la
 * reponse du LLM apres remplacement par les vraies valeurs - soit parce que
 * le LLM a hallucine un token non fourni dans le prompt, soit a la suite
 * d'une erreur de remplacement. Fail-safe explicite (voir README-LOT5.md) :
 * mieux vaut bloquer la generation que livrer un acte avec un "PARTIE_A"
 * visible dedans. Ne contient jamais la valeur reelle correspondante -
 * uniquement les tokens orphelins eux-memes (deja neutres par nature).
 */
export class OrphanTokenError extends Error {
  constructor(public readonly tokensOrphelins: string[]) {
    super(
      `Token(s) de pseudonymisation non resolu(s) apres dechiffrement de la reponse du LLM : ${tokensOrphelins.length} token(s) orphelin(s).`
    );
    this.name = "OrphanTokenError";
  }
}

// Doit couvrir exactement les prefixes de role utilises par anonymizer.ts
// (RoleIdentifiant dans pseudonymisation.types.ts) - a tenir synchronise si
// un role est ajoute. Insensible a la casse (voir commentaire plus bas).
const TOKEN_PATTERN = /\b(?:PARTIE|JUGE|GREFFIER|HUISSIER|ADRESSE|IDENTIFIANT|TELEPHONE|EMAIL)_[A-Z0-9]+\b/gi;

/**
 * Remplace chaque token present dans la reponse du LLM par sa vraie valeur,
 * puis verifie qu'aucun token (connu ou non) ne subsiste dans le resultat -
 * voir OrphanTokenError. Fonction pure (aucun acces reseau/DB, aucun
 * effet de bord), testable isolement.
 */
export function deanonymize(reponseLLM: string, tokenMap: TokenMap): string {
  let texteFinal = reponseLLM;

  // Remplace les tokens les plus longs en premier : evite qu'un token comme
  // "JUGE_1" ne matche par erreur a l'interieur d'un token plus long qui le
  // contient comme sous-chaine (ex: "JUGE_10").
  const tokensTriesParLongueur = Array.from(tokenMap.keys()).sort((a, b) => b.length - a.length);
  for (const token of tokensTriesParLongueur) {
    const valeur = tokenMap.get(token);
    if (valeur === undefined) continue;
    texteFinal = texteFinal.split(token).join(valeur);
  }

  // Detection insensible a la casse (contrairement au remplacement
  // ci-dessus, qui reste exact) : si le LLM a rendu un token dans une casse
  // differente de celle fournie (ex: "partie_a" au lieu de "PARTIE_A"), le
  // remplacement exact ci-dessus l'aurait manque - on prefere le detecter
  // ici et echouer plutot que de le laisser passer inapercu dans le
  // document final.
  const orphelins = texteFinal.match(TOKEN_PATTERN);
  if (orphelins && orphelins.length > 0) {
    throw new OrphanTokenError(Array.from(new Set(orphelins)));
  }

  return texteFinal;
}
