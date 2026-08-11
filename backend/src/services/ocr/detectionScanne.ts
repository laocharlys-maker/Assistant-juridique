import pdfParse from "pdf-parse";

/**
 * Lot 17 - decide si une piece a besoin d'un traitement OCR, ou si le texte
 * natif deja extrait par pdf-parse (webActions.ts, resumePdf.ts) suffit.
 * Responsabilite volontairement isolee de moteurTesseract.ts (qui fait
 * l'OCR) et de jobs/traitementOcr.ts (qui orchestre) - une seule question
 * ici : "ce fichier a-t-il besoin d'un OCR ?".
 */

/**
 * Formats couverts par l'OCR en V1 (voir README-LOT17.md). Les autres types
 * autorises a l'upload (Lot 15 : GIF, WEBP, Word, texte brut) ne declenchent
 * jamais d'OCR automatique - un texte brut ou un .docx a deja un contenu
 * textuel exploitable autrement, et GIF/WEBP sont hors perimetre V1 (pas de
 * cas d'usage cabinet identifie - documents scannes arrivent en PDF ou
 * JPEG/PNG en pratique).
 */
export const TYPES_MIME_IMAGE_OCR = new Set(["image/jpeg", "image/png"]);
export const TYPE_MIME_PDF = "application/pdf";

/**
 * Seuil de detection "scanne vs texte natif" : un PDF dont pdf-parse extrait
 * moins de SEUIL_CARACTERES_PAR_PAGE caracteres par page est considere
 * scanne (image sans couche texte exploitable) et route vers l'OCR. Un PDF
 * avec du texte natif reel en contient generalement des centaines par page
 * (une page de conclusions, par exemple) - 40 caracteres/page est largement
 * sous ce niveau, pour ne pas declencher d'OCR inutile sur un PDF natif qui
 * ne contiendrait qu'une page de garde peu chargee en texte parmi d'autres.
 * Valeur ajustable ici uniquement (aucune autre copie de ce seuil ailleurs).
 */
export const SEUIL_CARACTERES_PAR_PAGE = 40;

export interface DetectionOcrResultat {
  /** true si ce fichier doit etre mis en file pour un traitement OCR. */
  necessiteOcr: boolean;
  /** Texte natif deja extrait par pdf-parse, le cas echeant (PDF uniquement, "" sinon). */
  texteNatif: string;
  /** Nombre de pages du PDF (0 pour une image ou un format non applicable). */
  nombrePages: number;
}

/**
 * Determine si `typeMime`/`contenu` necessite un OCR. Ne leve jamais - un
 * PDF illisible par pdf-parse (corrompu, protege par mot de passe) est
 * traite comme "necessite l'OCR" par prudence : tesseract tentera sa propre
 * lecture, et echouera proprement de son cote si le fichier est reellement
 * illisible (voir moteurTesseract.ts, statut "echec").
 */
export async function detecterBesoinOcr(typeMime: string, contenu: Buffer): Promise<DetectionOcrResultat> {
  if (TYPES_MIME_IMAGE_OCR.has(typeMime)) {
    return { necessiteOcr: true, texteNatif: "", nombrePages: 1 };
  }

  if (typeMime !== TYPE_MIME_PDF) {
    // Word, texte brut, GIF, WEBP... : hors perimetre OCR V1 (voir
    // TYPES_MIME_IMAGE_OCR ci-dessus et README-LOT17.md).
    return { necessiteOcr: false, texteNatif: "", nombrePages: 0 };
  }

  let texte = "";
  let nombrePages = 0;
  try {
    const parsed = await pdfParse(contenu);
    texte = parsed.text.trim();
    nombrePages = parsed.numpages || 1;
  } catch (error) {
    console.error(
      "[ocr-detection] pdf-parse a echoue a lire ce PDF (fichier corrompu/protege ?), traitement OCR tente par prudence :",
      error instanceof Error ? error.message : error
    );
    return { necessiteOcr: true, texteNatif: "", nombrePages: 0 };
  }

  const seuil = Math.max(nombrePages, 1) * SEUIL_CARACTERES_PAR_PAGE;
  return { necessiteOcr: texte.length < seuil, texteNatif: texte, nombrePages };
}
