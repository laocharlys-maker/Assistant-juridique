import { Router } from "express";
import { z } from "zod";
import { prisma } from "../lib/prisma";
import { requireAuth } from "../middleware/requireAuth";
import { env } from "../config/env";
import { enregistrerFichier, lireFichier, supprimerFichier } from "../services/stockageDocuments";
import { enqueuerTraitementOcr } from "../jobs/traitementOcr";

export const documentsDossierRouter = Router();

/**
 * Lot 15 - types raisonnables pour un usage documentaire de cabinet (PDF,
 * images, Word, texte) - rejette explicitement tout le reste (executables,
 * archives, etc.), contrainte du prompt. Verification faite sur le type
 * MIME annonce par le navigateur (extrait du Data URL) - pas un
 * sniffing de contenu approfondi (limite assumee, voir README-LOT15.md).
 */
const TYPES_AUTORISES = new Set([
  "application/pdf",
  "image/png",
  "image/jpeg",
  "image/gif",
  "image/webp",
  "application/msword",
  "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
  "text/plain",
]);

const DATA_URL_PATTERN = /^data:([a-zA-Z0-9.+-]+\/[a-zA-Z0-9.+-]+);base64,(.+)$/;

function tailleMaxOctets(): number {
  return env.DOCUMENTS_TAILLE_MAX_MO * 1024 * 1024;
}

// Meme regle d'acces que la fiche dossier elle-meme (GET /api/dossiers/:id,
// dossiers.ts) : tout membre du cabinet peut consulter/gerer les pieces
// d'un dossier de son cabinet - pas de nouveau systeme de droits, contrainte
// explicite du prompt.
async function chargerDossierAccessible(dossierId: string, cabinetId: string) {
  return prisma.dossier.findFirst({ where: { id: dossierId, cabinetId } });
}

const INCLUDE_STANDARD = {
  uploadePar: { select: { id: true, nom: true } },
  // Lot 17 - statut/score uniquement (jamais texteExtrait, meme chiffre :
  // pas besoin de le transporter tant que l'utilisateur n'ouvre pas la
  // modale de detail, voir GET /api/documents/:id/ocr dans routes/ocr.ts)
  // pour afficher un badge OCR sans requete supplementaire par piece.
  ocrResultat: { select: { statut: true, scoreConfiance: true } },
} as const;

documentsDossierRouter.get("/api/dossiers/:dossierId/documents", requireAuth, async (req, res) => {
  const dossier = await chargerDossierAccessible(req.params.dossierId, req.auth!.cabinetId);
  if (!dossier) {
    return res.status(404).json({ error: "Dossier introuvable" });
  }

  const documents = await prisma.documentDossier.findMany({
    where: { dossierId: dossier.id },
    include: INCLUDE_STANDARD,
    orderBy: { createdAt: "desc" },
  });
  return res.json(documents);
});

const uploadSchema = z.object({
  nom: z.string().min(1),
  fichierDataUrl: z.string().min(1),
});

documentsDossierRouter.post("/api/dossiers/:dossierId/documents", requireAuth, async (req, res) => {
  const dossier = await chargerDossierAccessible(req.params.dossierId, req.auth!.cabinetId);
  if (!dossier) {
    return res.status(404).json({ error: "Dossier introuvable" });
  }

  const parsed = uploadSchema.safeParse(req.body);
  if (!parsed.success) {
    return res.status(400).json({ error: "Formulaire invalide", details: parsed.error.issues });
  }

  const match = parsed.data.fichierDataUrl.match(DATA_URL_PATTERN);
  if (!match) {
    return res.status(400).json({ error: "Fichier invalide (format inattendu)." });
  }
  const [, typeMime, base64Data] = match;

  if (!TYPES_AUTORISES.has(typeMime)) {
    return res.status(415).json({
      error: `Type de fichier non autorisé (${typeMime}). Types acceptés : PDF, images (PNG/JPEG/GIF/WEBP), Word, texte brut.`,
    });
  }

  const contenu = Buffer.from(base64Data, "base64");
  if (contenu.length === 0) {
    return res.status(400).json({ error: "Fichier vide." });
  }
  if (contenu.length > tailleMaxOctets()) {
    return res.status(413).json({
      error: `Fichier trop volumineux (${(contenu.length / (1024 * 1024)).toFixed(1)} Mo) — la taille maximale autorisée est de ${env.DOCUMENTS_TAILLE_MAX_MO} Mo.`,
    });
  }

  const { nomFichier, tailleOctets } = await enregistrerFichier(dossier.id, contenu);

  const document = await prisma.documentDossier.create({
    data: {
      cabinetId: req.auth!.cabinetId,
      dossierId: dossier.id,
      nomOriginal: parsed.data.nom,
      typeMime,
      tailleOctets,
      nomFichier,
      source: "upload",
      uploadeParId: req.auth!.userId,
    },
    include: INCLUDE_STANDARD,
  });

  console.log(
    `[documents-dossier] upload : ${req.auth!.userId} -> document ${document.id} (${document.nomOriginal}, ${tailleOctets} octets) sur le dossier ${dossier.id}`
  );

  // Lot 17 - hook additif, jamais attendu (`await`) ici : la reponse
  // d'upload part immediatement, le traitement OCR (s'il est necessaire -
  // voir enqueuerTraitementOcr()) se poursuit en tache de fond. `contenu`
  // est deja dechiffre en memoire (issu de enregistrerFichier ci-dessus),
  // reutilise tel quel pour eviter une relecture disque. Un echec ici ne
  // doit jamais faire echouer l'upload lui-meme (voir catch interne de
  // enqueuerTraitementOcr, jobs/traitementOcr.ts).
  enqueuerTraitementOcr(document, contenu).catch((error) => {
    console.error(`[documents-dossier] échec du déclenchement OCR pour le document ${document.id} :`, error instanceof Error ? error.message : error);
  });

  return res.status(201).json(document);
});

async function chargerDocumentAccessible(id: string, cabinetId: string) {
  return prisma.documentDossier.findFirst({ where: { id, cabinetId } });
}

// Telechargement (Content-Disposition: attachment) ou apercu inline
// (?inline=1, pour un <img>/<iframe> - PDF et images uniquement, voir
// frontend) - meme route, seule la disposition change : le contenu
// dechiffre est strictement identique dans les deux cas.
documentsDossierRouter.get("/api/documents/:id", requireAuth, async (req, res) => {
  const document = await chargerDocumentAccessible(req.params.id, req.auth!.cabinetId);
  if (!document) {
    return res.status(404).json({ error: "Document introuvable" });
  }

  let contenu: Buffer;
  try {
    contenu = await lireFichier(document.dossierId, document.nomFichier);
  } catch (error) {
    console.error(`[documents-dossier] échec de lecture du fichier pour le document ${document.id} :`, error instanceof Error ? error.message : error);
    return res.status(500).json({ error: "Impossible de lire ce document (fichier illisible ou manquant sur disque)." });
  }

  const inline = req.query.inline === "1" && (document.typeMime === "application/pdf" || document.typeMime.startsWith("image/"));

  console.log(`[documents-dossier] ${inline ? "aperçu" : "téléchargement"} : ${req.auth!.userId} -> document ${document.id}`);

  res.setHeader("Content-Type", document.typeMime);
  res.setHeader(
    "Content-Disposition",
    `${inline ? "inline" : "attachment"}; filename="${encodeURIComponent(document.nomOriginal)}"`
  );
  return res.send(contenu);
});

// Suppression : reservee a l'auteur de l'upload ou a un avocat/titulaire du
// cabinet (oversight) - un collaborateur ne peut pas supprimer une piece
// uploadee par quelqu'un d'autre.
documentsDossierRouter.delete("/api/documents/:id", requireAuth, async (req, res) => {
  const document = await chargerDocumentAccessible(req.params.id, req.auth!.cabinetId);
  if (!document) {
    return res.status(404).json({ error: "Document introuvable" });
  }
  const estAuteur = document.uploadeParId === req.auth!.userId;
  const estAvocat = req.auth!.role === "titulaire" || req.auth!.role === "avocat";
  if (!estAuteur && !estAvocat) {
    return res.status(403).json({ error: "Seul l'auteur de l'upload ou un avocat du cabinet peut supprimer cette pièce." });
  }

  await prisma.documentDossier.delete({ where: { id: document.id } });
  // Supprime le fichier physique APRES la suppression en base reussie -
  // si la suppression du fichier echoue (disque inaccessible...), l'entree
  // en base est deja retiree ; un fichier orphelin resterait alors sur
  // disque, log explicite pour permettre un nettoyage manuel plutot qu'une
  // incoherence silencieuse.
  try {
    await supprimerFichier(document.dossierId, document.nomFichier);
  } catch (error) {
    console.error(
      `[documents-dossier] échec de suppression du fichier physique pour le document ${document.id} (entrée déjà retirée en base) :`,
      error instanceof Error ? error.message : error
    );
  }

  console.log(`[documents-dossier] suppression : ${req.auth!.userId} -> document ${document.id} (${document.nomOriginal})`);

  return res.json({ ok: true });
});
