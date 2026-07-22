import { Router } from "express";
import fs from "node:fs/promises";
import path from "node:path";
import { z } from "zod";
import { prisma } from "../lib/prisma";
import { requireAuth } from "../middleware/requireAuth";

export const signatureRouter = Router();

const UPLOAD_DIR = path.join(__dirname, "..", "..", "public", "uploads", "signatures");

const uploadSchema = z.object({
  // Data URL type "data:image/png;base64,...."
  imageDataUrl: z.string().regex(/^data:image\/(png|jpeg);base64,/),
});

signatureRouter.post("/api/users/me/signature", requireAuth, async (req, res) => {
  const parsed = uploadSchema.safeParse(req.body);
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

  await fs.mkdir(UPLOAD_DIR, { recursive: true });
  const filename = `${req.auth!.userId}.${ext === "jpeg" ? "jpg" : "png"}`;
  await fs.writeFile(path.join(UPLOAD_DIR, filename), buffer);

  const signatureUrl = `/uploads/signatures/${filename}`;
  await prisma.user.update({ where: { id: req.auth!.userId }, data: { signatureUrl } });

  return res.json({ signatureUrl });
});

signatureRouter.delete("/api/users/me/signature", requireAuth, async (req, res) => {
  await prisma.user.update({ where: { id: req.auth!.userId }, data: { signatureUrl: null } });
  return res.json({ ok: true });
});
