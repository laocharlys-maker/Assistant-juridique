import { enregistrerFichier, lireFichier, existeFichier, supprimerFichier, FichierEnregistre } from "../stockageDocuments";

/**
 * Passerelle resume PDF -> base de jurisprudence : reutilise EXACTEMENT le
 * meme mecanisme de stockage chiffre (AES-256-GCM) que les pieces de
 * dossier (Lot 15, stockageDocuments.ts), via un "bucket" conventionnel
 * plutot qu'un vrai dossierId - aucun Dossier applicatif n'est cree pour ces
 * PDF, la base de jurisprudence reste globale au cabinet (pas de champ
 * cabinetId sur JurisprudenceChunk, voir README-LOT18.md).
 */
const BUCKET_JURISPRUDENCE_PDF = "jurisprudence-base";

export async function stockerPdfJurisprudence(contenu: Buffer): Promise<FichierEnregistre> {
  return enregistrerFichier(BUCKET_JURISPRUDENCE_PDF, contenu);
}

export async function lirePdfJurisprudence(nomFichier: string): Promise<Buffer> {
  return lireFichier(BUCKET_JURISPRUDENCE_PDF, nomFichier);
}

export async function pdfJurisprudenceExiste(nomFichier: string): Promise<boolean> {
  return existeFichier(BUCKET_JURISPRUDENCE_PDF, nomFichier);
}

export async function supprimerPdfJurisprudence(nomFichier: string): Promise<void> {
  return supprimerFichier(BUCKET_JURISPRUDENCE_PDF, nomFichier);
}

const PREFIXE_LIEN_INTERNE = "/api/jurisprudence-base/";
const SUFFIXE_LIEN_INTERNE = "/document";

/** Construit le lien interne stocke comme champ "lien" du chunk cree - jamais
 * une URL web, uniquement consultable depuis Aurore lui-meme (voir route
 * GET /api/jurisprudence-base/:groupeId/document dans jurisprudenceBase.ts). */
export function construireLienInterneDocument(groupeId: string): string {
  return `${PREFIXE_LIEN_INTERNE}${groupeId}${SUFFIXE_LIEN_INTERNE}`;
}

/** Reconnait le format d'un lien interne genere ci-dessus et en extrait le
 * groupeId - renvoie null pour toute autre valeur (dont les URL web
 * classiques), qui restent verifiees par requete HTTP (voir verifierLien.ts). */
export function extraireGroupeIdDuLienInterne(url: string): string | null {
  if (!url.startsWith(PREFIXE_LIEN_INTERNE) || !url.endsWith(SUFFIXE_LIEN_INTERNE)) return null;
  const groupeId = url.slice(PREFIXE_LIEN_INTERNE.length, url.length - SUFFIXE_LIEN_INTERNE.length);
  return groupeId.length > 0 && !groupeId.includes("/") ? groupeId : null;
}
