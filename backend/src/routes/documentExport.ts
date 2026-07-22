import { Router } from "express";
import fs from "node:fs/promises";
import path from "node:path";
import { prisma } from "../lib/prisma";
import { requireAuth } from "../middleware/requireAuth";
import {
  buildDocx,
  buildPdf,
  SignatureAlignment,
  SignatureInput,
  EnteteInput,
} from "../services/documentExport";

export const documentExportRouter = Router();

const TYPE_LABELS: Record<string, string> = {
  notes: "Compte-rendu d'audience",
  redac: "Plaidoirie",
  conclusions: "Conclusions",
  assignation: "Assignation",
  mise_en_demeure: "Mise en demeure",
  jurisprudence: "Recherche de jurisprudence",
  recherche_juridique: "Recherche juridique",
  resume_pdf: "Résumé de jurisprudence",
};

const COMBINING_DIACRITICS = new RegExp("[\\u0300-\\u036f]", "g");

function slugify(text: string): string {
  return text
    .normalize("NFD")
    .replace(COMBINING_DIACRITICS, "")
    .replace(/[^a-zA-Z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .toLowerCase();
}

async function loadExportInput(actionId: string, cabinetId: string) {
  const action = await prisma.action.findFirst({
    where: { id: actionId, dossier: { cabinetId } },
    include: { dossier: { include: { cabinet: true } }, creePar: { select: { nom: true } } },
  });
  if (!action || !action.contenuGenere) return null;

  return {
    action,
    input: {
      cabinetNom: action.dossier.cabinet.nom,
      numeroDossier: action.dossier.numeroDossier,
      nomAffaire: action.dossier.nomAffaire,
      typeLabel: TYPE_LABELS[action.typeAction] || action.typeAction,
      contenu: action.contenuGenere,
      auteurNom: action.creePar.nom,
      date: action.createdAt,
    },
  };
}

const PUBLIC_DIR = path.join(__dirname, "..", "..", "public");

async function readImageFile(imageUrl: string): Promise<{ buffer: Buffer; type: "png" | "jpg" }> {
  const filePath = path.join(PUBLIC_DIR, imageUrl);
  const buffer = await fs.readFile(filePath);
  const type = imageUrl.toLowerCase().endsWith(".jpg") || imageUrl.toLowerCase().endsWith(".jpeg")
    ? "jpg"
    : "png";
  return { buffer, type };
}

type SignatureResolution =
  | { ok: true; signature: SignatureInput | undefined }
  | { ok: false; error: string };

async function resolveSignature(
  userId: string,
  avecSignature: boolean,
  alignment: SignatureAlignment
): Promise<SignatureResolution> {
  if (!avecSignature) {
    return { ok: true, signature: undefined };
  }

  const currentUser = await prisma.user.findUnique({
    where: { id: userId },
    include: { responsable: true },
  });

  let signatureUrl: string | null = null;
  if (currentUser?.role === "collaborateur") {
    if (currentUser.partageSignatureActif && currentUser.responsable?.signatureUrl) {
      signatureUrl = currentUser.responsable.signatureUrl;
    } else {
      return { ok: false, error: "Ton avocat responsable ne t'a pas autorisé à insérer sa signature" };
    }
  } else {
    signatureUrl = currentUser?.signatureUrl ?? null;
  }

  if (!signatureUrl) {
    return { ok: false, error: "Aucune signature disponible" };
  }

  try {
    const { buffer, type } = await readImageFile(signatureUrl);
    return { ok: true, signature: { buffer, alignment, type } };
  } catch {
    return { ok: false, error: "Signature introuvable sur le serveur" };
  }
}

function parseSignatureQuery(req: import("express").Request): {
  avecSignature: boolean;
  alignment: SignatureAlignment;
} {
  const avecSignature = req.query.avecSignature === "1";
  const rawAlignment = typeof req.query.positionSignature === "string" ? req.query.positionSignature : "END";
  const alignment: SignatureAlignment = ["START", "CENTER", "END"].includes(rawAlignment)
    ? (rawAlignment as SignatureAlignment)
    : "END";
  return { avecSignature, alignment };
}

async function resolveEntete(cabinetId: string, avecEntete: boolean): Promise<EnteteInput | undefined> {
  if (!avecEntete) return undefined;

  const cabinet = await prisma.cabinet.findUnique({ where: { id: cabinetId } });
  if (!cabinet?.enteteUrl) return undefined;

  try {
    return await readImageFile(cabinet.enteteUrl);
  } catch {
    return undefined;
  }
}

documentExportRouter.get("/api/actions/:id/word", requireAuth, async (req, res) => {
  const loaded = await loadExportInput(req.params.id, req.auth!.cabinetId);
  if (!loaded) {
    return res.status(404).json({ error: "Document introuvable" });
  }

  const { avecSignature, alignment } = parseSignatureQuery(req);
  const signatureResolution = await resolveSignature(req.auth!.userId, avecSignature, alignment);
  if (!signatureResolution.ok) {
    return res.status(403).json({ error: signatureResolution.error });
  }
  const entete = await resolveEntete(req.auth!.cabinetId, req.query.avecEntete === "1");

  const buffer = await buildDocx({ ...loaded.input, signature: signatureResolution.signature, entete });
  const filename = `${slugify(loaded.input.typeLabel)}-${slugify(loaded.input.numeroDossier)}.docx`;
  res.setHeader(
    "Content-Type",
    "application/vnd.openxmlformats-officedocument.wordprocessingml.document"
  );
  res.setHeader("Content-Disposition", `attachment; filename="${filename}"`);
  return res.send(buffer);
});

documentExportRouter.get("/api/actions/:id/pdf", requireAuth, async (req, res) => {
  const loaded = await loadExportInput(req.params.id, req.auth!.cabinetId);
  if (!loaded) {
    return res.status(404).json({ error: "Document introuvable" });
  }

  const { avecSignature, alignment } = parseSignatureQuery(req);
  const signatureResolution = await resolveSignature(req.auth!.userId, avecSignature, alignment);
  if (!signatureResolution.ok) {
    return res.status(403).json({ error: signatureResolution.error });
  }
  const entete = await resolveEntete(req.auth!.cabinetId, req.query.avecEntete === "1");

  const buffer = await buildPdf({ ...loaded.input, signature: signatureResolution.signature, entete });
  const filename = `${slugify(loaded.input.typeLabel)}-${slugify(loaded.input.numeroDossier)}.pdf`;
  res.setHeader("Content-Type", "application/pdf");
  res.setHeader("Content-Disposition", `attachment; filename="${filename}"`);
  return res.send(buffer);
});
