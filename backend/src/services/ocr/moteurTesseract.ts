import path from "node:path";
import fsPromises from "node:fs/promises";
import { createWorker, type Worker } from "tesseract.js";
import { pdfToPng } from "pdf-to-png-converter";
import { userDataDir } from "../../database/portablePaths";
import { TYPES_MIME_IMAGE_OCR, TYPE_MIME_PDF } from "./detectionScanne";

/**
 * Lot 17 - moteur OCR local (Tesseract, via tesseract.js). Aucune API cloud
 * (Google Vision, AWS Textract...) : une image ou un PDF potentiellement
 * sensible (contrat, piece d'identite client) ne quitte jamais cette
 * machine pour etre reconnu - voir README-LOT17.md pour la justification
 * confidentialite complete. Ce module ne fait AUCUN appel a services/llm/
 * ni a aucun service tiers autre que le moteur OCR lui-meme.
 *
 * Choix tesseract.js (vs binaire `tesseract` en sous-processus) :
 * l'application est distribuee en executable portable (voir
 * scripts/build-sea.js) - une dependance a un binaire systeme externe
 * casserait ce mode de distribution (chemin non garanti, installation
 * separee requise sur le poste de l'utilisateur). tesseract.js embarque un
 * moteur WASM autonome, sans installation externe - au prix d'une vitesse
 * de traitement inferieure au binaire natif, assume pour cette V1.
 *
 * PDF scannes : tesseract.js reconnait des images, pas des PDF directement.
 * Chaque page est rasterisee en PNG via pdf-to-png-converter (binaires
 * natifs prets a l'emploi pour @napi-rs/canvas, aucune compilation requise -
 * voir README-LOT17.md pour le risque d'empaquetage associe en mode SEA).
 */

const LANGUE = "fra";

/**
 * Pack de langue Tesseract mis en cache localement apres son premier
 * telechargement (voir README-LOT17.md, section "confidentialite") : ceci
 * n'est PAS un envoi de donnees du cabinet vers un tiers, seul un modele de
 * langue generique (~4 Mo) est recupere une fois puis reutilise hors-ligne
 * pour tous les traitements suivants.
 */
function cacheLangueDir(): string {
  return path.join(userDataDir(), "ocr-data");
}

export class OcrEngineError extends Error {
  constructor(message: string, options?: { cause?: unknown }) {
    super(message, options);
    this.name = "OcrEngineError";
  }
}

export interface OcrTraitementResultat {
  texte: string;
  /** 0-100. */
  scoreConfiance: number;
}

async function creerWorker(): Promise<Worker> {
  await fsPromises.mkdir(cacheLangueDir(), { recursive: true });
  return createWorker(LANGUE, undefined, { cachePath: cacheLangueDir() });
}

async function reconnaitreImage(worker: Worker, image: Buffer): Promise<{ texte: string; confiance: number }> {
  const { data } = await worker.recognize(image);
  return { texte: data.text.trim(), confiance: data.confidence };
}

/**
 * Rasterise chaque page d'un PDF en PNG (une image par page, resolution
 * standard - viewportScale par defaut) pour un passage a l'OCR page par
 * page. N'est jamais appele sur un PDF a texte natif exploitable (voir
 * detectionScanne.ts, appele en amont par jobs/traitementOcr.ts).
 */
async function rasteriserPdf(contenu: Buffer): Promise<Buffer[]> {
  const pages = await pdfToPng(contenu, { viewportScale: 2, disableFontFace: true });
  return pages
    .map((p) => p.content)
    .filter((c): c is Buffer => Buffer.isBuffer(c) && c.length > 0);
}

/**
 * Traite un document (image ou PDF scanne) et renvoie le texte extrait avec
 * un score de confiance global (0-100, moyenne simple des pages pour un
 * PDF multi-pages). Leve une OcrEngineError avec un message clair en cas
 * d'echec (fichier corrompu, format inattendu) - jamais un texte partiel
 * silencieusement tronque.
 */
export async function traiterDocumentOcr(typeMime: string, contenu: Buffer): Promise<OcrTraitementResultat> {
  let images: Buffer[];
  if (TYPES_MIME_IMAGE_OCR.has(typeMime)) {
    images = [contenu];
  } else if (typeMime === TYPE_MIME_PDF) {
    try {
      images = await rasteriserPdf(contenu);
    } catch (error) {
      throw new OcrEngineError("Impossible de convertir ce PDF en image pour la reconnaissance de texte (fichier corrompu ou protégé).", {
        cause: error,
      });
    }
    if (images.length === 0) {
      throw new OcrEngineError("Ce PDF ne contient aucune page exploitable pour la reconnaissance de texte.");
    }
  } else {
    throw new OcrEngineError(
      `Type de fichier non pris en charge par la reconnaissance de texte (${typeMime}). Formats acceptés : JPEG, PNG, PDF.`
    );
  }

  let worker: Worker;
  try {
    worker = await creerWorker();
  } catch (error) {
    throw new OcrEngineError("Impossible d'initialiser le moteur de reconnaissance de texte.", { cause: error });
  }

  try {
    const resultatsPages: { texte: string; confiance: number }[] = [];
    for (const image of images) {
      try {
        resultatsPages.push(await reconnaitreImage(worker, image));
      } catch (error) {
        throw new OcrEngineError("La reconnaissance de texte a échoué sur ce document.", { cause: error });
      }
    }

    const texte = resultatsPages
      .map((p) => p.texte)
      .filter((t) => t.length > 0)
      .join("\n\n");
    const scoreConfiance =
      resultatsPages.reduce((somme, p) => somme + p.confiance, 0) / resultatsPages.length;

    return { texte, scoreConfiance };
  } finally {
    // Toujours libere le worker (processus/threads WASM internes), meme en
    // cas d'echec - jamais de fuite de ressource sur un document en erreur.
    await worker.terminate();
  }
}
