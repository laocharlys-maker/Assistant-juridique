import { Router } from "express";
import { z } from "zod";
import { prisma } from "../lib/prisma";
import { requireAuth } from "../middleware/requireAuth";
import { sendEmail } from "../services/mailer";
import { resolveCabinetEmailIdentite } from "../services/cabinetContact";

export const clientsRouter = Router();

clientsRouter.get("/api/clients", requireAuth, async (req, res) => {
  const clients = await prisma.client.findMany({
    where: { cabinetId: req.auth!.cabinetId },
    orderBy: { nom: "asc" },
    include: { _count: { select: { dossiers: true } } },
  });
  return res.json(clients);
});

// Fiche d'identite : seul le nom est obligatoire, tout le reste est saisi
// au fil de l'eau selon ce que le cabinet sait deja du client.
const clientFieldsSchema = {
  nom: z.string().min(1),
  email: z.string().email().optional().or(z.literal("")),
  telephone: z.string().optional(),
  notes: z.string().optional(),
  typePersonne: z.enum(["physique", "morale"]).optional(),
  civilite: z.enum(["M.", "Mme", "Mlle"]).optional(),
  dateNaissance: z.string().optional(),
  lieuNaissance: z.string().optional(),
  numeroPieceIdentite: z.string().optional(),
  quartierResidence: z.string().optional(),
  rue: z.string().optional(),
  autrePrecision: z.string().optional(),
  maison: z.string().optional(),
  situationMatrimoniale: z.string().optional(),
  fonction: z.string().optional(),
  entreprise: z.string().optional(),
  adresseEntreprise: z.string().optional(),
};

const createClientSchema = z.object(clientFieldsSchema);

function clientDataFromParsed(parsed: z.infer<typeof createClientSchema>) {
  return {
    nom: parsed.nom,
    email: parsed.email || null,
    telephone: parsed.telephone || null,
    notes: parsed.notes || null,
    typePersonne: parsed.typePersonne || "physique",
    civilite: parsed.civilite || null,
    dateNaissance: parsed.dateNaissance ? new Date(parsed.dateNaissance) : null,
    lieuNaissance: parsed.lieuNaissance || null,
    numeroPieceIdentite: parsed.numeroPieceIdentite || null,
    quartierResidence: parsed.quartierResidence || null,
    rue: parsed.rue || null,
    autrePrecision: parsed.autrePrecision || null,
    maison: parsed.maison || null,
    situationMatrimoniale: parsed.situationMatrimoniale || null,
    fonction: parsed.fonction || null,
    entreprise: parsed.entreprise || null,
    adresseEntreprise: parsed.adresseEntreprise || null,
  };
}

clientsRouter.post("/api/clients", requireAuth, async (req, res) => {
  const parsed = createClientSchema.safeParse(req.body);
  if (!parsed.success) {
    return res.status(400).json({ error: "Formulaire invalide", details: parsed.error.issues });
  }

  const client = await prisma.client.create({
    data: {
      cabinetId: req.auth!.cabinetId,
      ...clientDataFromParsed(parsed.data),
    },
  });

  return res.status(201).json(client);
});

const updateClientSchema = z.object(clientFieldsSchema);

clientsRouter.patch("/api/clients/:id", requireAuth, async (req, res) => {
  const parsed = updateClientSchema.safeParse(req.body);
  if (!parsed.success) {
    return res.status(400).json({ error: "Formulaire invalide", details: parsed.error.issues });
  }

  const existing = await prisma.client.findFirst({
    where: { id: req.params.id, cabinetId: req.auth!.cabinetId },
  });
  if (!existing) {
    return res.status(404).json({ error: "Client introuvable" });
  }

  const client = await prisma.client.update({
    where: { id: existing.id },
    data: clientDataFromParsed(parsed.data),
  });

  return res.json(client);
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

// Envoie un email libre (objet + message) a un client depuis sa fiche,
// directement via Brevo/Nodemailer (meme transporteur que le reste de
// l'app - voir services/mailer.ts). Auparavant delegue a n8n ; retire avec
// le reste de la dependance n8n (voir README-LOT8TER.md).
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

  const { cabinetNom, replyToEmail } = await resolveCabinetEmailIdentite(req.auth!.cabinetId);

  let attachments: { filename: string; content: Buffer; contentType: string }[] | undefined;
  if (parsed.data.pieceJointeDataUrl) {
    const match = parsed.data.pieceJointeDataUrl.match(/^data:([^;]+);base64,(.+)$/);
    if (match) {
      attachments = [
        {
          filename: parsed.data.pieceJointeNom || "piece-jointe",
          content: Buffer.from(match[2], "base64"),
          contentType: match[1],
        },
      ];
    }
  }

  const mailResult = await sendEmail({
    destinataireEmail: client.email,
    cabinetNom,
    replyToEmail,
    subject: parsed.data.objet,
    text: parsed.data.message,
    attachments,
  });

  if (!mailResult.ok) {
    return res.status(502).json({ error: "Échec de l'envoi de l'email", detail: mailResult.error });
  }
  return res.json({ ok: true });
});
