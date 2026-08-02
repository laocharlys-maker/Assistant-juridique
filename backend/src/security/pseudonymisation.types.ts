/**
 * Types partages entre anonymizer.ts et deanonymizer.ts (Lot 5). Voir
 * README-LOT5.md pour la liste exacte des champs identifiants et la
 * convention de nommage des tokens.
 */

/** Token (ex: "PARTIE_A") -> valeur reelle. Generee en memoire pour la
 * duree d'une seule requete de generation - jamais persistee, jamais
 * loguee avec son contenu (voir anonymizer.ts / deanonymizer.ts). */
export type TokenMap = ReadonlyMap<string, string>;

/**
 * Role attribue a un champ identifiant - determine le prefixe du token et
 * la convention de suffixe (lettres pour "PARTIE", numeros pour les
 * autres). Voir anonymizer.ts pour le detail.
 */
export type RoleIdentifiant =
  | "PARTIE"
  | "JUGE"
  | "GREFFIER"
  | "HUISSIER"
  | "ADRESSE"
  | "IDENTIFIANT"
  | "TELEPHONE"
  | "EMAIL";

/** Un champ candidat a la tokenisation : nom logique (pour audit/tests
 * uniquement, n'apparait dans aucun log), role, et valeur reelle
 * eventuellement vide/absente (auquel cas il est simplement ignore). */
export interface ChampIdentifiantInput {
  champ: string;
  role: RoleIdentifiant;
  valeur: string | null | undefined;
}

export interface AnonymizationResult {
  promptAnonymise: string;
  tokenMap: TokenMap;
  /** Nombre d'entites distinctes effectivement tokenisees - sert au log de
   * tracabilite ("Document genere avec pseudonymisation : N entites
   * tokenisees"), jamais le detail des valeurs. */
  entitiesCount: number;
}
