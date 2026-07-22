import { Router, Request, Response, NextFunction } from "express";
import fs from "node:fs/promises";
import path from "node:path";
import { z } from "zod";
import { prisma } from "../lib/prisma";
import { requireAuth } from "../middleware/requireAuth";

export const cabinetRouter = Router();

function requireTitulaire(req: Request, res: Response, next: NextFunction): void {
  if (req.auth?.role !== "titulaire") {
    res.status(403).json({ error: "Réservé au titulaire du cabinet" });
    return;
  }
  next();
}

cabinetRouter.get("/api/cabinet", requireAuth, async (req, res) => {
  const cabinet = await prisma.cabinet.findUnique({
    where: { id: req.auth!.cabinetId },
    select: { id: true, nom: true, enteteUrl: true },
  });
  if (!cabinet) {
    return res.status(404).json({ error: "Cabinet introuvable" });
  }
  return res.json(cabinet);
});

const updateCabinetSchema = z.object({
  nom: z.string().min(1),
});

cabinetRouter.patch("/api/cabinet", requireAuth, requireTitulaire, async (req, res) => {
  const parsed = updateCabinetSchema.safeParse(req.body);
  if (!parsed.success) {
    return res.status(400).json({ error: "Nom invalide" });
  }

  const cabinet = await prisma.cabinet.update({
    where: { id: req.auth!.cabinetId },
    data: { nom: parsed.data.nom },
  });
  return res.json({ id: cabinet.id, nom: cabinet.nom });
});

const ENTETE_UPLOAD_DIR = path.join(__dirname, "..", "..", "public", "uploads", "entetes");

const uploadEnteteSchema = z.object({
  imageDataUrl: z.string().regex(/^data:image\/(png|jpeg);base64,/),
});

cabinetRouter.post("/api/cabinet/entete", requireAuth, requireTitulaire, async (req, res) => {
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
  const filename = `${req.auth!.cabinetId}.${ext === "jpeg" ? "jpg" : "png"}`;
  await fs.writeFile(path.join(ENTETE_UPLOAD_DIR, filename), buffer);

  const enteteUrl = `/uploads/entetes/${filename}`;
  await prisma.cabinet.update({ where: { id: req.auth!.cabinetId }, data: { enteteUrl } });

  return res.json({ enteteUrl });
});

cabinetRouter.delete("/api/cabinet/entete", requireAuth, requireTitulaire, async (req, res) => {
  await prisma.cabinet.update({ where: { id: req.auth!.cabinetId }, data: { enteteUrl: null } });
  return res.json({ ok: true });
});
