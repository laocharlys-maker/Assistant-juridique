/**
 * Lot 16 - types partages entre les clients de recuperation (gmailClient.ts,
 * imapClient.ts) et le reste du module (detectionDate.ts, suggestionDossier.ts,
 * routes/emailIngestion.ts). Un seul modele independant du fournisseur, pour
 * que tout le code en aval (detection, suggestion, confirmation) ignore
 * completement s'il s'agit de Gmail ou d'IMAP.
 */

/** Metadonnee d'une piece jointe detectee - jamais le contenu binaire a ce
 * stade (voir README-LOT16.md, "aucune automatisation silencieuse" : le
 * contenu n'est recupere qu'a la confirmation explicite d'import). `id` est
 * un identifiant opaque cote fournisseur (attachmentId Gmail, ou identifiant
 * de partie MIME IMAP) permettant de re-recuperer le contenu plus tard. */
export interface PieceJointeDetectee {
  id: string;
  nomFichier: string;
  typeMime: string;
  tailleOctets: number;
}

/** Un email tel que recupere par un client (Gmail ou IMAP) - `corpsTexte` est
 * TRANSITOIRE : utilise uniquement pour la detection de date (voir
 * detectionDate.ts) au moment du polling, jamais persiste en base (voir
 * EmailImporte, qui ne stocke qu'un court extrait de contexte autour de la
 * date detectee, pas le corps complet). */
export interface EmailRecu {
  identifiantExterne: string;
  expediteurEmail: string;
  expediteurNom: string | null;
  objet: string | null;
  dateReception: Date;
  corpsTexte: string;
  piecesJointes: PieceJointeDetectee[];
}
