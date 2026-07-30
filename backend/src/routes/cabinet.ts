import { Router } from "express";
import fs from "node:fs/promises";
import path from "node:path";
import { z } from "zod";
import { prisma } from "../lib/prisma";
import { requireAuth } from "../middleware/requireAuth";
import { requireAdmin } from "../middleware/roles";
import { callN8nWebhook } from "../services/n8n";

export const cabinetRouter = Router();

cabinetRouter.get("/api/cabinet", requireAuth, async (req, res) => {
  const cabinet = await prisma.cabinet.findUnique({
    where: { id: req.auth!.cabinetId },
    select: {
      id: true,
      nom: true,
      adresse: true,
      emailContact: true,
      policeDocuments: true,
      tailleDocuments: true,
      enteteUrl: true,
      veilleSujets: true,
      veilleActive: true,
      archivageDelaiMois: true,
      limiteDocumentsCollaborateurParMois: true,
    },
  });
  if (!cabinet) {
    return res.status(404).json({ error: "Cabinet introuvable" });
  }
  return res.json(cabinet);
});

const updateCabinetSchema = z.object({
  nom: z.string().min(1),
  adresse: z.string().optional(),
});

cabinetRouter.patch("/api/cabinet", requireAuth, requireAdmin, async (req, res) => {
  const parsed = updateCabinetSchema.safeParse(req.body);
  if (!parsed.success) {
    return res.status(400).json({ error: "Nom invalide" });
  }

  const cabinet = await prisma.cabinet.update({
    where: { id: req.auth!.cabinetId },
    data: { nom: parsed.data.nom, adresse: parsed.data.adresse || null },
  });
  return res.json({ id: cabinet.id, nom: cabinet.nom, adresse: cabinet.adresse });
});

const updateVeilleSchema = z.object({
  veilleSujets: z.string().optional(),
  veilleActive: z.boolean().optional(),
});

cabinetRouter.patch("/api/cabinet/veille", requireAuth, requireAdmin, async (req, res) => {
  const parsed = updateVeilleSchema.safeParse(req.body);
  if (!parsed.success) {
    return res.status(400).json({ error: "Requête invalide" });
  }

  const cabinet = await prisma.cabinet.update({
    where: { id: req.auth!.cabinetId },
    data: parsed.data,
  });
  return res.json({ veilleSujets: cabinet.veilleSujets, veilleActive: cabinet.veilleActive });
});

const updateRetentionSchema = z.object({
  archivageDelaiMois: z.number().int().min(1).max(60),
});

cabinetRouter.patch("/api/cabinet/retention", requireAuth, requireAdmin, async (req, res) => {
  const parsed = updateRetentionSchema.safeParse(req.body);
  if (!parsed.success) {
    return res.status(400).json({ error: "Délai invalide (entre 1 et 60 mois)" });
  }

  const cabinet = await prisma.cabinet.update({
    where: { id: req.auth!.cabinetId },
    data: { archivageDelaiMois: parsed.data.archivageDelaiMois },
  });
  return res.json({ archivageDelaiMois: cabinet.archivageDelaiMois });
});

const updateLimiteDocumentsSchema = z.object({
  // Null/absent = pas de limite.
  limiteDocumentsCollaborateurParMois: z.number().int().positive().max(1000).nullable(),
});

cabinetRouter.patch("/api/cabinet/limite-documents", requireAuth, requireAdmin, async (req, res) => {
  const parsed = updateLimiteDocumentsSchema.safeParse(req.body);
  if (!parsed.success) {
    return res.status(400).json({ error: "Limite invalide (nombre entier positif, ou vide pour aucune limite)" });
  }

  const cabinet = await prisma.cabinet.update({
    where: { id: req.auth!.cabinetId },
    data: { limiteDocumentsCollaborateurParMois: parsed.data.limiteDocumentsCollaborateurParMois },
  });
  return res.json({ limiteDocumentsCollaborateurParMois: cabinet.limiteDocumentsCollaborateurParMois });
});

const updateEmailContactSchema = z.object({
  // Vide/absent = retire l'adresse dediee, repli automatique sur l'email
  // du titulaire pour le Reply-To des emails envoyes au nom du cabinet.
  emailContact: z.union([z.string().email(), z.literal("")]).nullable().optional(),
});

cabinetRouter.patch("/api/cabinet/email-contact", requireAuth, requireAdmin, async (req, res) => {
  const parsed = updateEmailContactSchema.safeParse(req.body);
  if (!parsed.success) {
    return res.status(400).json({ error: "Adresse email invalide" });
  }

  const cabinet = await prisma.cabinet.update({
    where: { id: req.auth!.cabinetId },
    data: { emailContact: parsed.data.emailContact || null },
  });
  return res.json({ emailContact: cabinet.emailContact });
});

const testEmailContactSchema = z.object({
  email: z.string().email(),
});

// Permet au titulaire de verifier lui-meme qu'une adresse de contact est
// valide et consultee, avant meme de l'enregistrer (le champ envoye peut
// differer de celui deja sauvegarde en base).
cabinetRouter.post("/api/cabinet/email-contact/test", requireAuth, requireAdmin, async (req, res) => {
  const parsed = testEmailContactSchema.safeParse(req.body);
  if (!parsed.success) {
    return res.status(400).json({ error: "Adresse email invalide" });
  }

  const cabinet = await prisma.cabinet.findUnique({ where: { id: req.auth!.cabinetId } });
  const n8nResult = await callN8nWebhook("email-test", {
    cabinetNom: cabinet?.nom ?? "",
    destinataireEmail: parsed.data.email,
  });

  if (!n8nResult.ok) {
    return res.status(502).json({ error: "Échec de l'envoi du test", detail: n8nResult.error });
  }
  return res.json({ ok: true });
});

// Police limitee a ce choix ferme : doit rester synchronisee avec
// PDF_FONT_FAMILIES (src/services/documentExport.ts), qui ne sait mapper
// que ces trois noms vers des polices PDF standard (aucune police a
// embarquer). Cote Word, n'importe quel nom fonctionnerait, mais on garde
// le meme choix reduit pour un rendu identique entre Word et PDF.
const POLICES_DISPONIBLES = ["Times New Roman", "Arial", "Courier New"] as const;

const updateStyleDocumentsSchema = z.object({
  policeDocuments: z.enum(POLICES_DISPONIBLES),
  tailleDocuments: z.number().int().min(8).max(20),
});

cabinetRouter.patch("/api/cabinet/style", requireAuth, requireAdmin, async (req, res) => {
  const parsed = updateStyleDocumentsSchema.safeParse(req.body);
  if (!parsed.success) {
    return res.status(400).json({ error: "Réglages invalides", details: parsed.error.issues });
  }

  const cabinet = await prisma.cabinet.update({
    where: { id: req.auth!.cabinetId },
    data: parsed.data,
  });
  return res.json({ policeDocuments: cabinet.policeDocuments, tailleDocuments: cabinet.tailleDocuments });
});

const ENTETE_UPLOAD_DIR = path.join(__dirname, "..", "..", "public", "uploads", "entetes");

const uploadEnteteSchema = z.object({
  imageDataUrl: z.string().regex(/^data:image\/(png|jpeg);base64,/),
});

cabinetRouter.post("/api/cabinet/entete", requireAuth, requireAdmin, async (req, res) => {
  const parsed = uploadEnteteSchema.safeParse(req.body);
  if (!parsed.success) {
    return res.status(400).json({ error: "Image invalide (PNG ou JPEG attendu)" });
  }

  const matches = parsed.data.imageDataUrl.match(/^data:image\/(png|jpeg);base64,(.+)$/);
  if (!matches) {
    return res.status(400).json({ error: "Format d'image invalide" });
  }
  const [, ext, base64Data] = matches;
  const buffer = Buffer.from(base64Data, "base64");

  if (buffer.length > 2 * 1024 * 1024) {
    return res.status(413).json({ error: "Image trop volumineuse (2 Mo max)" });
  }

  await fs.mkdir(ENTETE_UPLOAD_DIR, { recursive: true });
  // Nom de fichier unique par upload (pas juste par cabinet) : sinon l'URL
  // ne change jamais d'un remplacement a l'autre, et le cache navigateur
  // (Cache-Control: max-age=300 sur /uploads, voir app.ts) continue
  // d'afficher l'ancienne image malgre le remplacement du fichier sur disque.
  const filename = `${req.auth!.cabinetId}-${Date.now()}.${ext === "jpeg" ? "jpg" : "png"}`;
  await fs.writeFile(path.join(ENTETE_UPLOAD_DIR, filename), buffer);

  const ancienCabinet = await prisma.cabinet.findUnique({
    where: { id: req.auth!.cabinetId },
    select: { enteteUrl: true },
  });

  const enteteUrl = `/uploads/entetes/${filename}`;
  await prisma.cabinet.update({ where: { id: req.auth!.cabinetId }, data: { enteteUrl } });

  if (ancienCabinet?.enteteUrl) {
    const ancienChemin = path.join(ENTETE_UPLOAD_DIR, path.basename(ancienCabinet.enteteUrl));
    await fs.unlink(ancienChemin).catch(() => {});
  }

  return res.json({ enteteUrl });
});

cabinetRouter.delete("/api/cabinet/entete", requireAuth, requireAdmin, async (req, res) => {
  const ancienCabinet = await prisma.cabinet.findUnique({
    where: { id: req.auth!.cabinetId },
    select: { enteteUrl: true },
  });
  await prisma.cabinet.update({ where: { id: req.auth!.cabinetId }, data: { enteteUrl: null } });
  if (ancienCabinet?.enteteUrl) {
    const chemin = path.join(ENTETE_UPLOAD_DIR, path.basename(ancienCabinet.enteteUrl));
    await fs.unlink(chemin).catch(() => {});
  }
  return res.json({ ok: true });
});
