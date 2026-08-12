import { Router } from "express";
import { prisma } from "../lib/prisma";
import { requireAuth } from "../middleware/requireAuth";
import { decryptField } from "../security/encryptionAtRest";
import { relancerOcr } from "../jobs/traitementOcr";
import { buildOcrTextePdf, buildOcrTexteWord } from "../services/ocr/ocrTexteExport";

export const ocrRouter = Router();

// Meme regle d'acces que les pieces elles-memes (routes/documentsDossier.ts,
// Lot 15) : tout membre du cabinet peut consulter/relancer l'OCR d'une piece
// de son cabinet - pas de nouveau systeme de droits, le texte OCR d'une
// piece est protege exactement comme la piece elle-meme (contrainte du
// prompt : "aucune route ne doit exposer un texte OCR sans revalider
// l'accès au dossier").
async function chargerDossierAccessible(dossierId: string, cabinetId: string) {
  return prisma.dossier.findFirst({ where: { id: dossierId, cabinetId } });
}

async function chargerDocumentAccessible(id: string, cabinetId: string) {
  return prisma.documentDossier.findFirst({ where: { id, cabinetId } });
}

/**
 * Resultat OCR d'une piece - "statut: aucun" si aucun traitement n'a
 * jamais ete declenche (piece d'un format non couvert par l'OCR, ou PDF a
 * texte natif deja exploitable - voir services/ocr/detectionScanne.ts).
 * texteExtrait n'est renvoye QUE si statut = termine (jamais un texte
 * partiel/obsolete pendant un traitement en cours ou apres un echec).
 */
ocrRouter.get("/api/documents/:id/ocr", requireAuth, async (req, res) => {
  const document = await chargerDocumentAccessible(req.params.id, req.auth!.cabinetId);
  if (!document) {
    return res.status(404).json({ error: "Document introuvable" });
  }

  const ocrResultat = await prisma.ocrResultat.findUnique({ where: { documentId: document.id } });
  if (!ocrResultat) {
    return res.json({ statut: "aucun" });
  }

  return res.json({
    statut: ocrResultat.statut,
    scoreConfiance: ocrResultat.scoreConfiance,
    messageErreur: ocrResultat.messageErreur,
    texteExtrait: ocrResultat.statut === "termine" ? decryptField(ocrResultat.texteExtrait) : null,
    updatedAt: ocrResultat.updatedAt,
  });
});

async function chargerResultatOcrTermine(documentId: string, cabinetId: string) {
  const document = await chargerDocumentAccessible(documentId, cabinetId);
  if (!document) {
    return { ok: false as const, status: 404, error: "Document introuvable" };
  }

  const ocrResultat = await prisma.ocrResultat.findUnique({ where: { documentId: document.id } });
  if (!ocrResultat || ocrResultat.statut !== "termine") {
    return { ok: false as const, status: 404, error: "Aucun texte reconnu disponible pour cette pièce." };
  }

  return { ok: true as const, document, ocrResultat, texteExtrait: decryptField(ocrResultat.texteExtrait) || "" };
}

function nomFichierExportOcr(nomOriginal: string, extension: string): string {
  const sansExtension = nomOriginal.replace(/\.[^./]+$/, "").trim();
  return `${sansExtension || "piece"}-texte-reconnu.${extension}`;
}

// Export du texte reconnu en PDF/Word (Lot 17 suite) - jamais le formalisme
// juridique de services/documentExport.ts (voir services/ocr/ocrTexteExport.ts),
// un texte OCR n'etant pas un acte redige par le cabinet. Meme regle d'acces
// que la consultation du texte (chargerDocumentAccessible ci-dessus).
ocrRouter.get("/api/documents/:id/ocr/pdf", requireAuth, async (req, res) => {
  const resultat = await chargerResultatOcrTermine(req.params.id, req.auth!.cabinetId);
  if (!resultat.ok) {
    return res.status(resultat.status).json({ error: resultat.error });
  }

  const cabinet = await prisma.cabinet.findUnique({ where: { id: req.auth!.cabinetId } });
  const buffer = await buildOcrTextePdf({
    cabinetNom: cabinet?.nom ?? "",
    nomOriginal: resultat.document.nomOriginal,
    scoreConfiance: resultat.ocrResultat.scoreConfiance,
    texteExtrait: resultat.texteExtrait,
  });

  res.setHeader("Content-Type", "application/pdf");
  res.setHeader(
    "Content-Disposition",
    `attachment; filename="${encodeURIComponent(nomFichierExportOcr(resultat.document.nomOriginal, "pdf"))}"`
  );
  return res.send(buffer);
});

ocrRouter.get("/api/documents/:id/ocr/word", requireAuth, async (req, res) => {
  const resultat = await chargerResultatOcrTermine(req.params.id, req.auth!.cabinetId);
  if (!resultat.ok) {
    return res.status(resultat.status).json({ error: resultat.error });
  }

  const cabinet = await prisma.cabinet.findUnique({ where: { id: req.auth!.cabinetId } });
  const buffer = await buildOcrTexteWord({
    cabinetNom: cabinet?.nom ?? "",
    nomOriginal: resultat.document.nomOriginal,
    scoreConfiance: resultat.ocrResultat.scoreConfiance,
    texteExtrait: resultat.texteExtrait,
  });

  res.setHeader("Content-Type", "application/vnd.openxmlformats-officedocument.wordprocessingml.document");
  res.setHeader(
    "Content-Disposition",
    `attachment; filename="${encodeURIComponent(nomFichierExportOcr(resultat.document.nomOriginal, "docx"))}"`
  );
  return res.send(buffer);
});

// Relance manuelle - jamais bloquante (voir relancerOcr(), traitement en
// tache de fond) : repond des que le statut est repasse a "en_attente",
// sans attendre la fin du (nouveau) traitement.
ocrRouter.post("/api/documents/:id/ocr/relancer", requireAuth, async (req, res) => {
  const document = await chargerDocumentAccessible(req.params.id, req.auth!.cabinetId);
  if (!document) {
    return res.status(404).json({ error: "Document introuvable" });
  }

  const resultat = await relancerOcr(document.id);
  if (!resultat.ok) {
    return res.status(400).json({ error: resultat.error });
  }

  console.log(`[ocr] relance manuelle : ${req.auth!.userId} -> document ${document.id}`);
  return res.status(202).json({ ok: true });
});

/**
 * Recherche plein texte dans les pieces OCR-isees d'un dossier. Le texte
 * OCR est chiffre au repos (OcrResultat.texteExtrait) : une recherche ne
 * peut pas etre un simple LIKE SQL sur la colonne chiffree. Le volume de
 * pieces par dossier reste faible (quelques dizaines au plus, jamais un
 * corpus documentaire massif) - dechiffrement a la volee sur ce
 * sous-ensemble uniquement (jamais sur l'ensemble de la table
 * ocr_resultats), sans indexation chiffree dediee : sur-ingenierie non
 * justifiee a ce volume (voir README-LOT17.md).
 */
ocrRouter.get("/api/dossiers/:dossierId/documents/recherche-ocr", requireAuth, async (req, res) => {
  const dossier = await chargerDossierAccessible(req.params.dossierId, req.auth!.cabinetId);
  if (!dossier) {
    return res.status(404).json({ error: "Dossier introuvable" });
  }

  const terme = typeof req.query.q === "string" ? req.query.q.trim() : "";
  if (terme.length < 2) {
    return res.status(400).json({ error: "Terme de recherche trop court (2 caractères minimum)." });
  }

  const resultatsTermines = await prisma.ocrResultat.findMany({
    where: { dossierId: dossier.id, statut: "termine" },
    include: { document: { select: { id: true, nomOriginal: true, typeMime: true } } },
  });

  const termeMinuscule = terme.toLowerCase();
  const correspondances = resultatsTermines
    .map((resultat) => {
      const texte = decryptField(resultat.texteExtrait);
      if (!texte) return null;
      const index = texte.toLowerCase().indexOf(termeMinuscule);
      if (index === -1) return null;
      const debut = Math.max(0, index - 60);
      const fin = Math.min(texte.length, index + termeMinuscule.length + 60);
      const extrait = `${debut > 0 ? "…" : ""}${texte.slice(debut, fin).trim()}${fin < texte.length ? "…" : ""}`;
      return {
        documentId: resultat.document.id,
        nomOriginal: resultat.document.nomOriginal,
        typeMime: resultat.document.typeMime,
        extrait,
      };
    })
    .filter((r): r is NonNullable<typeof r> => r !== null);

  return res.json(correspondances);
});
