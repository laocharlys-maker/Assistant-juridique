import { Router } from "express";
import { z } from "zod";
import { prisma } from "../lib/prisma";
import { requireAuth } from "../middleware/requireAuth";
import { callN8nWebhook } from "../services/n8n";

export const clientsRouter = Router();

clientsRouter.get("/api/clients", requireAuth, async (req, res) => {
  const clients = await prisma.client.findMany({
    where: { cabinetId: req.auth!.cabinetId },
    orderBy: { nom: "asc" },
    include: { _count: { select: { dossiers: true } } },
  });
  return res.json(clients);
});

const createClientSchema = z.object({
  nom: z.string().min(1),
  email: z.string().email().optional().or(z.literal("")),
  telephone: z.string().optional(),
  notes: z.string().optional(),
});

clientsRouter.post("/api/clients", requireAuth, async (req, res) => {
  const parsed = createClientSchema.safeParse(req.body);
  if (!parsed.success) {
    return res.status(400).json({ error: "Formulaire invalide", details: parsed.error.issues });
  }

  const client = await prisma.client.create({
    data: {
      cabinetId: req.auth!.cabinetId,
      nom: parsed.data.nom,
      email: parsed.data.email || null,
      telephone: parsed.data.telephone || null,
      notes: parsed.data.notes || null,
    },
  });

  return res.status(201).json(client);
});

clientsRouter.get("/api/clients/:id", requireAuth, async (req, res) => {
  const client = await prisma.client.findFirst({
    where: { id: req.params.id, cabinetId: req.auth!.cabinetId },
    include: { dossiers: { orderBy: { updatedAt: "desc" } } },
  });
  if (!client) {
    return res.status(404).json({ error: "Client introuvable" });
  }
  return res.json(client);
});

const envoyerEmailSchema = z.object({
  objet: z.string().min(1),
  message: z.string().min(1),
  // Piece jointe optionnelle (data URL base64, tous types courants : PDF,
  // Word, images...). Nom de fichier fourni separement pour l'email.
  pieceJointeDataUrl: z.string().regex(/^data:[^;]+;base64,/).optional(),
  pieceJointeNom: z.string().optional(),
});

// Envoie un email libre (objet + message) a un client depuis sa fiche.
// Ne passe jamais par le serveur de mail directement : delegue a n8n
// (meme principe que le reste de l'app - le backend prepare les donnees,
// n8n s'occupe de l'envoi effectif).
clientsRouter.post("/api/clients/:id/envoyer-email", requireAuth, async (req, res) => {
  const parsed = envoyerEmailSchema.safeParse(req.body);
  if (!parsed.success) {
    return res.status(400).json({ error: "Formulaire invalide", details: parsed.error.issues });
  }

  const client = await prisma.client.findFirst({
    where: { id: req.params.id, cabinetId: req.auth!.cabinetId },
  });
  if (!client) {
    return res.status(404).json({ error: "Client introuvable" });
  }
  if (!client.email) {
    return res.status(400).json({ error: "Ce client n'a pas d'adresse email enregistrée" });
  }

  const auteur = await prisma.user.findUnique({ where: { id: req.auth!.userId } });

  const n8nResult = await callN8nWebhook("envoyer-email-client", {
    destinataireEmail: client.email,
    destinataireNom: client.nom,
    objet: parsed.data.objet,
    message: parsed.data.message,
    pieceJointeDataUrl: parsed.data.pieceJointeDataUrl ?? null,
    pieceJointeNom: parsed.data.pieceJointeNom ?? null,
    envoyeParNom: auteur?.nom ?? null,
    envoyeParEmail: auteur?.email ?? null,
  });

  return res.json({ ok: true, n8nDispatched: n8nResult.ok });
});
