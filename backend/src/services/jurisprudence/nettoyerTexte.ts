/**
 * Nettoyage du texte saisi manuellement (ou importe depuis un PDF, voir
 * pdfExtraction.ts) avant chunking/embedding dans la base de jurisprudence
 * (routes/jurisprudenceBase.ts). Le contenu brut (surtout issu d'un copier-
 * coller PDF) contient typiquement trois defauts qui degradent la qualite
 * de l'embedding : des espaces multiples, des mots coupes par un retour a
 * la ligne au milieu d'une phrase (habitude de mise en page PDF), et des
 * en-tetes/pieds de page qui se repetent identiquement sur chaque page.
 *
 * Volontairement des heuristiques SIMPLES (pas un parseur PDF structurel) :
 * ce module ne connait rien de la mise en page d'origine, uniquement le
 * texte deja extrait - une heuristique trop agressive risquerait de
 * deformer un texte juridique deja propre (saisie manuelle soignee), pire
 * que de laisser passer un artefact occasionnel.
 */

// Une ligne de cette longueur ou moins, si elle se repete plusieurs fois
// dans le texte, est traitee comme un en-tete/pied de page (numero de
// page, nom du greffe repete sur chaque page...) plutot que du contenu.
const LONGUEUR_MAX_LIGNE_ENTETE = 80;
// Nombre minimum d'occurrences identiques pour etre considere comme repete
// "a intervalle regulier" - un texte juridique reel peut legitimement
// repeter une courte formule une ou deux fois (ex: un intertitre), jamais
// 3 fois ou plus a l'identique sans qu'il s'agisse d'un artefact de mise
// en page.
const OCCURRENCES_MIN_ENTETE_REPETE = 3;

// Ponctuation de fin de phrase/clause apres laquelle un retour a la ligne
// est presume intentionnel (fin de phrase, pas un mot coupe).
const FIN_DE_PHRASE = /[.;:!?…"'»)\]]$/;
const DEBUT_MINUSCULE = /^[a-zàâäéèêëïîôöùûüçñ]/;

function detecterLignesEnteteRepetees(lignes: string[]): Set<string> {
  const compteur = new Map<string, number>();
  for (const ligne of lignes) {
    const t = ligne.trim();
    if (t.length === 0 || t.length > LONGUEUR_MAX_LIGNE_ENTETE) continue;
    compteur.set(t, (compteur.get(t) ?? 0) + 1);
  }
  const repetees = new Set<string>();
  for (const [ligne, occurrences] of compteur) {
    if (occurrences >= OCCURRENCES_MIN_ENTETE_REPETE) repetees.add(ligne);
  }
  return repetees;
}

/** Recolle en un seul paragraphe les lignes d'un meme bloc (deja separe
 * des autres paragraphes par une ligne vide) quand une ligne ne se termine
 * pas par une ponctuation de fin et que la suivante commence par une
 * minuscule - signe quasi certain d'un mot/phrase coupe par la mise en
 * page plutot que d'une vraie fin de ligne voulue. */
function recollerLignesCoupees(lignes: string[]): string {
  let resultat = lignes[0] ?? "";
  for (let i = 1; i < lignes.length; i++) {
    const suivante = lignes[i];
    const coupureProbable = resultat.length > 0 && !FIN_DE_PHRASE.test(resultat) && DEBUT_MINUSCULE.test(suivante);
    resultat = coupureProbable ? `${resultat} ${suivante}` : `${resultat}\n${suivante}`;
  }
  return resultat;
}

export function nettoyerTexte(texteBrut: string): string {
  const lignesBrutes = texteBrut.split(/\r\n|\r|\n/).map((l) => l.trim());
  const lignesEnteteRepetees = detecterLignesEnteteRepetees(lignesBrutes);

  // Regroupe en paragraphes (separes par une ou plusieurs lignes vides
  // apres retrait des en-tetes/pieds de page repetes), pour ne recoller
  // les mots coupes QU'A L'INTERIEUR d'un meme paragraphe - jamais a
  // travers un vrai saut de paragraphe.
  const paragraphes: string[][] = [];
  let courant: string[] = [];
  for (const ligne of lignesBrutes) {
    if (lignesEnteteRepetees.has(ligne)) continue;
    if (ligne.length === 0) {
      if (courant.length > 0) {
        paragraphes.push(courant);
        courant = [];
      }
      continue;
    }
    courant.push(ligne);
  }
  if (courant.length > 0) paragraphes.push(courant);

  return paragraphes
    .map((lignes) => recollerLignesCoupees(lignes).replace(/[ \t]{2,}/g, " ").trim())
    .filter((p) => p.length > 0)
    .join("\n\n");
}
