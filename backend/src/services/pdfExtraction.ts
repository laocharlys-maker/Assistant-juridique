import pdfParse from "pdf-parse";

/**
 * Extraction du texte d'un PDF - factorise entre le resume PDF
 * (routes/webActions.ts, type_action "resume_pdf") et l'import PDF de la
 * base de jurisprudence (routes/jurisprudenceBase.ts, Lot 18), pour ne pas
 * dupliquer la meme logique pdf-parse + gestion d'erreur a deux endroits.
 *
 * Ne lit QUE le calque de texte selectionnable du PDF (pdf-parse ne fait
 * aucun OCR) - un PDF scanne sans OCR prealable renvoie un texte vide,
 * signale explicitement plutot que silencieusement.
 */
export type ExtractionPdfResultat = { ok: true; texte: string } | { ok: false; error: string };

export async function extraireTextePdf(pdfBuffer: Buffer): Promise<ExtractionPdfResultat> {
  let texte: string;
  try {
    const parsed = await pdfParse(pdfBuffer);
    texte = parsed.text.trim();
  } catch (error) {
    console.error("Erreur extraction texte PDF :", error);
    return { ok: false, error: "Impossible de lire ce PDF (fichier corrompu ou non supporté)" };
  }
  if (texte.length === 0) {
    return { ok: false, error: "Aucun texte détecté dans ce PDF (peut-être un scan sans OCR)" };
  }
  return { ok: true, texte };
}

/** Decode le data URL "data:application/pdf;base64,..." envoye par le
 * frontend (meme convention que les autres uploads en base64 du projet -
 * voir routes/webActions.ts, routes/clients.ts) en Buffer binaire. */
export function pdfBufferDepuisDataUrl(pdfDataUrl: string): Buffer {
  const base64Data = pdfDataUrl.replace(/^data:application\/pdf;base64,/, "");
  return Buffer.from(base64Data, "base64");
}
