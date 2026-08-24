import cron from "node-cron";
import type { DocumentDossier } from "@prisma/client";
import { prisma } from "../lib/prisma";
import { encryptField } from "../security/encryptionAtRest";
import { lireFichier } from "../services/stockageDocuments";
import { detecterBesoinOcr, TYPES_MIME_IMAGE_OCR, TYPE_MIME_PDF } from "../services/ocr/detectionScanne";
import { traiterDocumentOcr, OcrEngineError } from "../services/ocr/moteurTesseract";

/**
 * Lot 17 - orchestration du traitement OCR des pieces de dossier.
 *
 * Choix retenu (a documenter, meme demande explicite qu'au Lot 12b) :
 * traitement DECLENCHE IMMEDIATEMENT en tache de fond (jamais attendu par la
 * requete d'upload - voir enqueuerTraitementOcr(), appelee sans `await`
 * depuis routes/documentsDossier.ts), plutot qu'une file consommee
 * uniquement par un cycle cron periodique comme au Lot 12b. Justification :
 * contrairement a la synchro calendrier (appels reseau vers un service
 * tiers, soumis a devoir gerer la disponibilite de ce tiers), l'OCR est un
 * traitement 100% local (aucun reseau, aucune limite de debit externe) - le
 * declenchement immediat offre un badge de statut a jour en quelques
 * secondes plutot qu'une attente potentielle de plusieurs minutes, sans
 * aucun risque de surcharger un service externe. La table OcrResultat reste
 * neanmoins la source de verite durable (comme EvenementSyncExterne au Lot
 * 12b) : un cycle cron de RATTRAPAGE (runOcrCycleDeSecours, toutes les 5
 * minutes) reprend tout traitement reste bloque en "en_attente"/"en_cours"
 * au-dela de DELAI_BLOCAGE_MS - cas d'un redemarrage serveur survenu entre
 * la creation de la ligne et la fin du traitement immediat.
 *
 * Un echec de traitement OCR (fichier corrompu, moteur indisponible) ne
 * relance jamais automatiquement (contrairement au Lot 12b) : statut
 * "echec" immediat, avec messageErreur clair - la relance est une action
 * explicite de l'utilisateur (voir relancerOcr(), routes/ocr.ts), jamais
 * automatique en boucle.
 */

const DELAI_BLOCAGE_MS = 10 * 60 * 1000; // 10 minutes
const CRON_EXPRESSION = "*/5 * * * *"; // toutes les 5 minutes

function estFormatOcrEligible(typeMime: string): boolean {
  return TYPES_MIME_IMAGE_OCR.has(typeMime) || typeMime === TYPE_MIME_PDF;
}

/**
 * Execute le traitement OCR pour un OcrResultat deja cree (statut
 * en_attente/en_cours) et enregistre le resultat. Ne leve jamais - toute
 * erreur est capturee et traduite en statut "echec" + message utilisateur
 * clair. Ne logue jamais le texte extrait lui-meme (voir README-LOT17.md).
 */
async function executerEtEnregistrer(ocrResultatId: string, typeMime: string, contenu: Buffer): Promise<void> {
  const debut = Date.now();
  await prisma.ocrResultat.update({ where: { id: ocrResultatId }, data: { statut: "en_cours" } });

  try {
    const { texte, scoreConfiance } = await traiterDocumentOcr(typeMime, contenu);
    await prisma.ocrResultat.update({
      where: { id: ocrResultatId },
      data: { statut: "termine", texteExtrait: encryptField(texte), scoreConfiance, messageErreur: null },
    });
    console.log(
      `[ocr] traitement termine : resultat=${ocrResultatId} statut=termine score=${scoreConfiance.toFixed(1)} duree=${Date.now() - debut}ms`
    );
  } catch (error) {
    const message =
      error instanceof OcrEngineError
        ? error.message
        : "La reconnaissance de texte a échoué sur ce document. Vous pouvez réessayer.";
    await prisma.ocrResultat
      .update({
        where: { id: ocrResultatId },
        data: { statut: "echec", messageErreur: message, texteExtrait: null, scoreConfiance: null },
      })
      .catch(() => null);
    console.error(
      `[ocr] traitement echoue : resultat=${ocrResultatId} statut=echec duree=${Date.now() - debut}ms -`,
      error instanceof Error ? error.message : error
    );
  }
}

/**
 * Point d'entree appele juste apres la creation reussie d'un DocumentDossier
 * (voir routes/documentsDossier.ts) - jamais capable de faire echouer
 * l'appelant (try/catch interne, meme contrat que enqueuerSyncEvenement()
 * au Lot 12b) et jamais `await`-ee par la route : l'upload repond
 * immediatement, ce traitement se poursuit independamment.
 *
 * `contenu` est le buffer DEJA dechiffre en memoire par la route (issu de
 * enregistrerFichier) - reutilise tel quel, aucune relecture disque requise
 * pour ce premier passage.
 */
export async function enqueuerTraitementOcr(document: DocumentDossier, contenu: Buffer): Promise<void> {
  try {
    if (!estFormatOcrEligible(document.typeMime)) return;

    const detection = await detecterBesoinOcr(document.typeMime, contenu);
    if (!detection.necessiteOcr) {
      // PDF a texte natif deja exploitable (voir detectionScanne.ts) : pas
      // besoin de tesseract, mais ce texte doit neanmoins etre enregistre
      // comme un OcrResultat "termine" - sinon ce document reste invisible
      // dans "Documents transcrits" (routes/dossiers.ts, vue=transcriptions,
      // filtre strictement sur ocrResultat.statut="termine") et absent de la
      // recherche plein texte (routes/ocr.ts, recherche-ocr), alors que son
      // texte est parfaitement disponible - constate en usage reel : un
      // avocat transcrivant un PDF deja numerique (redige sur ordinateur)
      // ne le retrouvait nulle part. texteNatif est toujours vide pour un
      // format hors PDF (Word...), jamais concerne ici (voir
      // detecterBesoinOcr).
      if (detection.texteNatif) {
        await prisma.ocrResultat.upsert({
          where: { documentId: document.id },
          create: {
            documentId: document.id,
            cabinetId: document.cabinetId,
            dossierId: document.dossierId,
            statut: "termine",
            tentatives: 1,
            texteExtrait: encryptField(detection.texteNatif),
            scoreConfiance: 100,
          },
          update: {
            statut: "termine",
            tentatives: { increment: 1 },
            texteExtrait: encryptField(detection.texteNatif),
            scoreConfiance: 100,
            messageErreur: null,
          },
        });
        console.log(`[ocr] texte natif reutilise (PDF non scanne, aucun passage tesseract) : document=${document.id}`);
      }
      return;
    }

    const ocrResultat = await prisma.ocrResultat.upsert({
      where: { documentId: document.id },
      create: {
        documentId: document.id,
        cabinetId: document.cabinetId,
        dossierId: document.dossierId,
        statut: "en_attente",
        tentatives: 1,
      },
      update: { statut: "en_attente", tentatives: { increment: 1 }, messageErreur: null },
    });

    await executerEtEnregistrer(ocrResultat.id, document.typeMime, contenu);
  } catch (error) {
    console.error(
      `[ocr] echec de mise en file pour le document ${document.id} :`,
      error instanceof Error ? error.message : error
    );
  }
}

/**
 * Relance manuelle (voir routes/ocr.ts, POST /api/documents/:id/ocr/relancer) -
 * contrairement a enqueuerTraitementOcr(), ne reapplique jamais
 * detecterBesoinOcr() : l'utilisateur demande explicitement un (nouveau)
 * passage OCR (echec initial a corriger, ou mauvaise qualite de scan a
 * retraiter), meme si le texte natif avait ete juge suffisant a l'upload.
 * Retourne immediatement (traitement en tache de fond, jamais attendu par
 * la route).
 */
export async function relancerOcr(documentId: string): Promise<{ ok: true } | { ok: false; error: string }> {
  const document = await prisma.documentDossier.findUnique({ where: { id: documentId } });
  if (!document) return { ok: false, error: "Document introuvable." };
  if (!estFormatOcrEligible(document.typeMime)) {
    return {
      ok: false,
      error: "Ce type de fichier n'est pas pris en charge par la reconnaissance de texte (formats acceptés : JPEG, PNG, PDF).",
    };
  }

  const ocrResultat = await prisma.ocrResultat.upsert({
    where: { documentId: document.id },
    create: {
      documentId: document.id,
      cabinetId: document.cabinetId,
      dossierId: document.dossierId,
      statut: "en_attente",
      tentatives: 1,
    },
    update: { statut: "en_attente", tentatives: { increment: 1 }, messageErreur: null },
  });

  let contenu: Buffer;
  try {
    contenu = await lireFichier(document.dossierId, document.nomFichier);
  } catch (error) {
    const message = "Impossible de lire le fichier original de cette pièce.";
    await prisma.ocrResultat.update({ where: { id: ocrResultat.id }, data: { statut: "echec", messageErreur: message } });
    console.error(`[ocr] échec de lecture du fichier pour la relance du document ${documentId} :`, error instanceof Error ? error.message : error);
    return { ok: false, error: message };
  }

  executerEtEnregistrer(ocrResultat.id, document.typeMime, contenu).catch((error) => {
    console.error(`[ocr] échec inattendu lors de la relance pour le document ${documentId} :`, error instanceof Error ? error.message : error);
  });

  return { ok: true };
}

/**
 * Filet de securite : reprend tout traitement reste bloque en
 * "en_attente"/"en_cours" depuis plus de DELAI_BLOCAGE_MS (redemarrage
 * serveur survenu pendant un traitement, par exemple). Exportee separement
 * pour un declenchement manuel (tests).
 */
export async function runOcrCycleDeSecours(): Promise<void> {
  const seuil = new Date(Date.now() - DELAI_BLOCAGE_MS);
  const bloques = await prisma.ocrResultat.findMany({
    where: { statut: { in: ["en_attente", "en_cours"] }, updatedAt: { lt: seuil } },
    include: { document: true },
  });

  for (const ocrResultat of bloques) {
    try {
      const contenu = await lireFichier(ocrResultat.document.dossierId, ocrResultat.document.nomFichier);
      await executerEtEnregistrer(ocrResultat.id, ocrResultat.document.typeMime, contenu);
    } catch (error) {
      await prisma.ocrResultat
        .update({
          where: { id: ocrResultat.id },
          data: {
            statut: "echec",
            messageErreur: "Le traitement a été interrompu de façon inattendue. Vous pouvez relancer la reconnaissance de texte.",
          },
        })
        .catch(() => null);
      console.error(`[ocr] échec du rattrapage pour le résultat ${ocrResultat.id} :`, error instanceof Error ? error.message : error);
    }
  }
}

export function scheduleOcrQueue(): void {
  cron.schedule(
    CRON_EXPRESSION,
    () => {
      runOcrCycleDeSecours().catch((error) => {
        console.error("[ocr] erreur lors du cycle de rattrapage OCR :", error instanceof Error ? error.message : error);
      });
    },
    { timezone: "Africa/Porto-Novo" }
  );
  console.log(
    `[ocr] rattrapage des traitements OCR bloqués planifié (${CRON_EXPRESSION}, seuil=${DELAI_BLOCAGE_MS / 60000}min).`
  );
}
