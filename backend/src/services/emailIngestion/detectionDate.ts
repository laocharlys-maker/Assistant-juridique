/**
 * Lot 16 - detection LOCALE (regex/patterns, aucun appel LLM) d'une date/
 * heure de rendez-vous dans le corps d'un email. Decision de scope V1
 * documentee dans README-LOT16.md : contrairement a `champsDocument`
 * (Lot 5, qui beneficie d'une pseudonymisation avant tout envoi a un LLM),
 * le corps d'un email peut contenir des informations sensibles sans aucune
 * garantie de ce type - on evite donc tout envoi a un tiers pour cette
 * fonctionnalite, au prix d'une detection plus limitee qu'une extraction
 * par IA. Une evolution V2 (LLM + pseudonymisation du corps avant envoi)
 * reste possible plus tard si le besoin de couverture s'averait insuffisant
 * en pratique.
 *
 * Module PUR (aucun acces DB/reseau) - independamment testable, voir
 * __tests__/detectionDate.test.ts.
 *
 * ============================================================================
 * FORMATS RECONNUS (par ordre de priorite - le premier format qui matche
 * gagne, meme si un format moins prioritaire apparaissait plus tot dans le
 * texte : priorite donnee a la fiabilite, pas a la position) :
 *
 * 1. Date numerique complete, avec heure optionnelle :
 *    "12/08/2026", "12-08-2026", "12/08/2026 à 10h", "12/08/2026 à 10h30"
 *
 * 2. Date litterale (jour + mois en toutes lettres), annee et heure
 *    optionnelles, nom du jour de la semaine optionnel :
 *    "12 août", "mardi 12 août", "12 août 2026 à 10h", "le 12 août à 10h30"
 *
 * 3. Date relative au jour de reception de l'email, heure optionnelle
 *    (defaut 9h00 si absente) :
 *    "aujourd'hui", "demain", "demain à 14h30", "après-demain à 9h"
 *
 * 4. Jour du mois seul, UNIQUEMENT si introduit par "le" ET accompagne d'une
 *    heure explicite (sinon beaucoup trop ambigu pour etre fiable - ex. "le
 *    12" pourrait etre une reference a un numero de dossier) :
 *    "le 12 à 10h" -> le prochain jour 12 du calendrier (mois courant si pas
 *    encore passe, sinon mois suivant), a 10h00.
 *
 * ============================================================================
 * LIMITES ASSUMEES (volontairement non couvertes en V1 - voir
 * README-LOT16.md pour le detail) :
 * - Expressions vagues : "la semaine prochaine", "dans 15 jours", "courant
 *   septembre", "en fin de mois".
 * - Plages horaires : "entre 10h et midi".
 * - Fuseaux horaires explicites.
 * - Plusieurs dates dans un meme email (seule la premiere trouvee, par
 *   ordre de priorite des formats ci-dessus, est proposee).
 * - Dates ecrites entierement en toutes lettres ("le douze août").
 * ============================================================================
 */

export interface DateDetectee {
  date: Date;
  /** Court extrait de contexte (~60-80 caracteres) autour du texte
   * reconnu - JAMAIS le corps complet de l'email (voir EmailImporte,
   * schema.prisma). */
  contexte: string;
}

const JOURS_SEMAINE = ["lundi", "mardi", "mercredi", "jeudi", "vendredi", "samedi", "dimanche"];

const VARIANTES_MOIS: string[][] = [
  ["janvier"],
  ["février", "fevrier"],
  ["mars"],
  ["avril"],
  ["mai"],
  ["juin"],
  ["juillet"],
  ["août", "aout"],
  ["septembre"],
  ["octobre"],
  ["novembre"],
  ["décembre", "decembre"],
];

function indexMois(nom: string): number {
  const n = nom.toLowerCase();
  return VARIANTES_MOIS.findIndex((variantes) => variantes.includes(n));
}

function extraireContexte(texte: string, index: number, longueur: number): string {
  const marge = 25;
  const debut = Math.max(0, index - marge);
  const fin = Math.min(texte.length, index + longueur + marge);
  const extrait = texte.slice(debut, fin).replace(/\s+/g, " ").trim();
  return `${debut > 0 ? "…" : ""}${extrait}${fin < texte.length ? "…" : ""}`;
}

interface Heure {
  heures: number;
  minutes: number;
}

function parseHeure(heureStr: string | undefined, minuteStr: string | undefined): Heure | null {
  if (!heureStr) return null;
  const heures = Number(heureStr);
  const minutes = minuteStr ? Number(minuteStr) : 0;
  if (!Number.isInteger(heures) || heures < 0 || heures > 23) return null;
  if (!Number.isInteger(minutes) || minutes < 0 || minutes > 59) return null;
  return { heures, minutes };
}

/** Aucune heure detectee -> 9h00 par defaut (proposition raisonnable pour un
 * cabinet, TOUJOURS corrigible avant confirmation - voir routes/emailIngestion.ts). */
const HEURE_PAR_DEFAUT: Heure = { heures: 9, minutes: 0 };

function combinerDateHeure(date: Date, heure: Heure | null): Date {
  const resultat = new Date(date);
  const h = heure ?? HEURE_PAR_DEFAUT;
  resultat.setHours(h.heures, h.minutes, 0, 0);
  return resultat;
}

function dateValide(candidate: Date, annee: number, moisIndex: number, jour: number): boolean {
  return candidate.getFullYear() === annee && candidate.getMonth() === moisIndex && candidate.getDate() === jour;
}

// Format 1 : date numerique complete (JJ/MM/AAAA ou JJ-MM-AAAA), heure optionnelle.
const REGEX_NUMERIQUE =
  /\b(\d{1,2})[/-](\d{1,2})[/-](\d{2,4})\b(?:[^\S\r\n]*(?:à|a|,)?[^\S\r\n]*(\d{1,2})[^\S\r\n]*[h:][^\S\r\n]*(\d{2})?)?/i;

function tenterFormatNumerique(texte: string): DateDetectee | null {
  const match = REGEX_NUMERIQUE.exec(texte);
  if (!match) return null;
  const jour = Number(match[1]);
  const moisIndex = Number(match[2]) - 1;
  let annee = Number(match[3]);
  if (annee < 100) annee += 2000;
  if (moisIndex < 0 || moisIndex > 11 || jour < 1 || jour > 31) return null;
  const brut = new Date(annee, moisIndex, jour);
  if (!dateValide(brut, annee, moisIndex, jour)) return null;
  const date = combinerDateHeure(brut, parseHeure(match[4], match[5]));
  return { date, contexte: extraireContexte(texte, match.index, match[0].length) };
}

// Format 2 : date litterale (jour de semaine optionnel + jour + mois en
// lettres + annee optionnelle), heure optionnelle.
function construireRegexLitterale(): RegExp {
  const jours = JOURS_SEMAINE.join("|");
  const mois = VARIANTES_MOIS.flat().join("|");
  return new RegExp(
    `\\b(?:(?:${jours})\\s+)?(\\d{1,2})\\s+(${mois})(?:\\s+(\\d{4}))?\\b(?:[^\\S\\r\\n]*(?:à|a)?[^\\S\\r\\n]*(\\d{1,2})[^\\S\\r\\n]*[h:][^\\S\\r\\n]*(\\d{2})?)?`,
    "i"
  );
}
const REGEX_LITTERALE = construireRegexLitterale();

/** Aucune annee precisee dans le texte : suppose l'annee de reference, sauf
 * si la date obtenue tombe deja plus d'un jour dans le passe (l'email fait
 * alors probablement reference a l'annee suivante - ex. email de decembre
 * evoquant "le 5 janvier"). */
function inferAnnee(dateReference: Date, moisIndex: number, jour: number): number {
  const anneeRef = dateReference.getFullYear();
  const candidate = new Date(anneeRef, moisIndex, jour);
  return candidate.getTime() < dateReference.getTime() - 24 * 60 * 60 * 1000 ? anneeRef + 1 : anneeRef;
}

function tenterFormatLitteral(texte: string, dateReference: Date): DateDetectee | null {
  const match = REGEX_LITTERALE.exec(texte);
  if (!match) return null;
  const jour = Number(match[1]);
  const moisIndex = indexMois(match[2]);
  if (moisIndex === -1 || jour < 1 || jour > 31) return null;
  const annee = match[3] ? Number(match[3]) : inferAnnee(dateReference, moisIndex, jour);
  const brut = new Date(annee, moisIndex, jour);
  if (!dateValide(brut, annee, moisIndex, jour)) return null;
  const date = combinerDateHeure(brut, parseHeure(match[4], match[5]));
  return { date, contexte: extraireContexte(texte, match.index, match[0].length) };
}

// Format 3 : date relative au jour de reception (aujourd'hui/demain/après-demain).
const REGEX_RELATIF =
  /\b(après[\s-]?demain|apres[\s-]?demain|demain|aujourd'?hui)\b(?:[^\S\r\n]*(?:à|a)?[^\S\r\n]*(\d{1,2})[^\S\r\n]*[h:][^\S\r\n]*(\d{2})?)?/i;

function tenterFormatRelatif(texte: string, dateReference: Date): DateDetectee | null {
  const match = REGEX_RELATIF.exec(texte);
  if (!match) return null;
  const mot = match[1].toLowerCase();
  const decalageJours = mot.startsWith("après") || mot.startsWith("apres") ? 2 : mot.startsWith("demain") ? 1 : 0;
  const base = new Date(dateReference);
  base.setDate(base.getDate() + decalageJours);
  const date = combinerDateHeure(base, parseHeure(match[2], match[3]));
  return { date, contexte: extraireContexte(texte, match.index, match[0].length) };
}

// Format 4 : jour du mois seul, UNIQUEMENT introduit par "le" et accompagne
// d'une heure explicite (sinon rejete - trop ambigu, voir limites ci-dessus).
const REGEX_JOUR_SEUL = /\ble\s+(\d{1,2})\b(?:[^\S\r\n]*(?:à|a)[^\S\r\n]*(\d{1,2})[^\S\r\n]*[h:][^\S\r\n]*(\d{2})?)/i;

function tenterFormatJourSeul(texte: string, dateReference: Date): DateDetectee | null {
  const match = REGEX_JOUR_SEUL.exec(texte);
  if (!match) return null;
  const jour = Number(match[1]);
  if (jour < 1 || jour > 31) return null;
  const heure = parseHeure(match[2], match[3]);
  if (!heure) return null;

  let moisIndex = dateReference.getMonth();
  let annee = dateReference.getFullYear();
  if (jour < dateReference.getDate()) {
    moisIndex += 1;
    if (moisIndex > 11) {
      moisIndex = 0;
      annee += 1;
    }
  }
  const brut = new Date(annee, moisIndex, jour);
  if (!dateValide(brut, annee, moisIndex, jour)) return null; // ex: "le 31" en fevrier
  const date = combinerDateHeure(brut, heure);
  return { date, contexte: extraireContexte(texte, match.index, match[0].length) };
}

/**
 * Detecte la premiere date/heure de RDV dans `texte`, ou `null` si aucun des
 * formats reconnus (voir liste en tete de fichier) n'y figure. `dateReference`
 * (par defaut : maintenant) sert de point de depart pour les formats
 * relatifs/incomplets (formats 3 et 4) - a appeler avec la date de reception
 * REELLE de l'email (jamais `new Date()` au moment du polling), sans quoi
 * "demain" serait mal calcule pour un email traite en differe.
 */
export function detecterDate(texte: string, dateReference: Date = new Date()): DateDetectee | null {
  if (!texte) return null;
  return (
    tenterFormatNumerique(texte) ||
    tenterFormatLitteral(texte, dateReference) ||
    tenterFormatRelatif(texte, dateReference) ||
    tenterFormatJourSeul(texte, dateReference)
  );
}
