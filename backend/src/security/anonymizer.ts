import type { AnonymizationResult, ChampIdentifiantInput, RoleIdentifiant, TokenMap } from "./pseudonymisation.types";
import { deanonymize } from "./deanonymizer";

export type { ChampIdentifiantInput, RoleIdentifiant } from "./pseudonymisation.types";

/**
 * Pseudonymisation avant appel LLM (Lot 5). Voir README-LOT5.md pour la
 * liste exacte des champs identifiants tokenises par branche de
 * webActions.ts et la limite de cette protection.
 *
 * PAS de detection heuristique de noms dans du texte libre (contexte,
 * arguments juridiques...) - uniquement les valeurs structurees passees
 * explicitement en entree de anonymize(), qui correspondent aux champs
 * identifiants connus de champsDocument (nom du client, de la partie
 * adverse/destinataire, du juge, du greffier, adresse, numero de piece
 * d'identite/RCCM-IFU). Les dates de procedure, la juridiction, le type
 * d'acte et le texte narratif ne sont jamais tokenises.
 *
 * Convention de nommage des tokens (role -> prefixe/suffixe) :
 * - "PARTIE"      -> PARTIE_A, PARTIE_B, PARTIE_C... (une lettre par
 *                    entite distincte, dans l'ordre de premiere
 *                    apparition) - client/demandeur, partie
 *                    adverse/defendeur/destinataire d'un acte.
 * - "JUGE"        -> JUGE_1, JUGE_2...
 * - "GREFFIER"    -> GREFFIER_1, GREFFIER_2...
 * - "HUISSIER"    -> HUISSIER_1, HUISSIER_2...
 * - "ADRESSE"     -> ADRESSE_1, ADRESSE_2...
 * - "IDENTIFIANT" -> IDENTIFIANT_1, IDENTIFIANT_2... (numero de piece
 *                    d'identite, RCCM/IFU...)
 * - "TELEPHONE"   -> TELEPHONE_1, TELEPHONE_2...
 * - "EMAIL"       -> EMAIL_1, EMAIL_2...
 */

const ROLES_A_SUFFIXE_LETTRE = new Set<RoleIdentifiant>(["PARTIE"]);

/** 0 -> "A", 1 -> "B" ... 25 -> "Z", 26 -> "AA"... - ne plafonne jamais
 * silencieusement, meme si un dossier avait un nombre inhabituel de
 * parties distinctes. */
function suffixeLettre(index: number): string {
  let resultat = "";
  let i = index;
  do {
    resultat = String.fromCharCode(65 + (i % 26)) + resultat;
    i = Math.floor(i / 26) - 1;
  } while (i >= 0);
  return resultat;
}

/**
 * Tokenise les valeurs identifiantes fournies a l'interieur d'un texte de
 * prompt deja construit (le texte destine au LLM, avant envoi). Fonction
 * pure : aucun acces reseau/DB, aucun effet de bord, testable isolement.
 *
 * Stabilite : une meme valeur reelle (comparaison texte exact) recoit
 * toujours le meme token, y compris si elle apparait sous plusieurs champs
 * ou plusieurs fois dans le texte. Champs vides/absents simplement ignores
 * (rien a tokeniser). Les valeurs les plus longues sont remplacees en
 * premier pour qu'une valeur courte (ex: "Jean") ne mutile pas une valeur
 * plus longue qui la contient (ex: "Jean Dupont").
 */
export function anonymize(champsIdentifiants: ChampIdentifiantInput[], promptTexte: string): AnonymizationResult {
  const tokenParValeur = new Map<string, string>();
  const valeurParToken = new Map<string, string>();
  const compteurParRole = new Map<RoleIdentifiant, number>();

  for (const { role, valeur } of champsIdentifiants) {
    const v = valeur?.trim();
    if (!v) continue; // champ vide/absent : rien a tokeniser
    if (tokenParValeur.has(v)) continue; // meme valeur deja vue - reutilise le token existant (stabilite)

    const n = compteurParRole.get(role) ?? 0;
    const suffixe = ROLES_A_SUFFIXE_LETTRE.has(role) ? suffixeLettre(n) : String(n + 1);
    const token = `${role}_${suffixe}`;
    compteurParRole.set(role, n + 1);

    tokenParValeur.set(v, token);
    valeurParToken.set(token, v);
  }

  const valeursTrieesParLongueur = Array.from(tokenParValeur.keys()).sort((a, b) => b.length - a.length);

  let promptAnonymise = promptTexte;
  for (const valeur of valeursTrieesParLongueur) {
    const token = tokenParValeur.get(valeur);
    if (token === undefined) continue;
    promptAnonymise = promptAnonymise.split(valeur).join(token);
  }

  return {
    promptAnonymise,
    tokenMap: valeurParToken as TokenMap,
    entitiesCount: valeurParToken.size,
  };
}

export interface RedactionPseudonymisee {
  texteFinal: string;
  donneesPseudonymisees: boolean;
}

/**
 * Orchestration reutilisee par chaque branche de webActions.ts qui
 * manipule des donnees identifiantes : anonymise -> appelle le LLM UNE
 * SEULE FOIS (aucun retry automatique - voir README-LOT5.md) ->
 * dé-tokenise -> leve OrphanTokenError si un token orphelin subsiste
 * (jamais rattrapee ici, propage jusqu'a l'appelant qui doit traduire
 * l'erreur en reponse HTTP 422 et statut Action "echec_generation", SANS
 * jamais retenter l'appel LLM). C'est le point d'insertion unique
 * "avant/apres l'appel LLM" reutilise par chaque type d'acte concerne.
 *
 * `redact` recoit deja le prompt anonymise et doit retourner la reponse
 * brute du LLM (generalement `(p) => llm.redact(SYSTEM_PROMPT, p)`) - ce
 * module reste ainsi totalement agnostique du provider LLM.
 */
export async function redigerAvecPseudonymisation(params: {
  champsIdentifiants: ChampIdentifiantInput[];
  promptTexte: string;
  redact: (promptAnonymise: string) => Promise<string>;
  /** Identifiant du type d'acte, pour le log de tracabilite uniquement -
   * jamais une donnee sensible. */
  typeActionLog: string;
}): Promise<RedactionPseudonymisee> {
  const { promptAnonymise, tokenMap, entitiesCount } = anonymize(params.champsIdentifiants, params.promptTexte);

  const reponseBrute = await params.redact(promptAnonymise);

  const texteFinal = deanonymize(reponseBrute, tokenMap);

  if (entitiesCount > 0) {
    // Niveau info, jamais de donnee sensible : ni les valeurs reelles, ni
    // les tokens avec leur correspondance.
    console.log(
      `[pseudonymisation] Document genere avec pseudonymisation (${params.typeActionLog}) : ${entitiesCount} entite(s) tokenisee(s).`
    );
  }

  return { texteFinal, donneesPseudonymisees: entitiesCount > 0 };
}
