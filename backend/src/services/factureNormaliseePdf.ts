import { enregistrerFichier, lireFichier, supprimerFichier, FichierEnregistre } from "./stockageDocuments";

/**
 * Passerelle facture normalisee (SYGMEF) -> stockage chiffre : reutilise
 * EXACTEMENT le meme mecanisme (AES-256-GCM) que les pieces de dossier
 * (Lot 15, stockageDocuments.ts) et les PDF de jurisprudence (Lot 18, voir
 * services/jurisprudence/stockagePdf.ts, meme pattern). Le "bucket" utilise
 * ici est directement l'id de la facture (chaque facture a au plus UN PDF
 * normalise, contrairement a jurisprudence-base qui n'a pas d'entite propre
 * et utilise un bucket fixe).
 */

export async function stockerFactureNormalisee(factureId: string, contenu: Buffer): Promise<FichierEnregistre> {
  return enregistrerFichier(factureId, contenu);
}

export async function lireFactureNormalisee(factureId: string, nomFichier: string): Promise<Buffer> {
  return lireFichier(factureId, nomFichier);
}

export async function supprimerFactureNormalisee(factureId: string, nomFichier: string): Promise<void> {
  return supprimerFichier(factureId, nomFichier);
}
