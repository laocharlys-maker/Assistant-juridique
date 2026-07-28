import { Router } from "express";
import { z } from "zod";
import { prisma } from "../lib/prisma";
import { requireAuth } from "../middleware/requireAuth";
import { requireAvocat, requireModule } from "../middleware/roles";
import { buildFacturePdf } from "../services/facturePdf";
import { resolveEntete } from "./documentExport";
import { callN8nWebhook } from "../services/n8n";
import { resolveCabinetEmailIdentite } from "../services/cabinetContact";

export const facturesRouter = Router();

// Module payant : peut etre desactive par la plateforme pour un cabinet
// dont la formule ne l'inclut pas. Chemin explicite obligatoire : sans lui,
// ce middleware s'appliquerait a TOUTES les requetes de l'app (ce routeur
// est monte sans prefixe sur app), pas seulement a /api/factures*.
facturesRouter.use("/api/factures", requireAuth, requireModule("facturation"));

// Prefixe distinct pour les proforma - series de numerotation independantes,
// pour qu'une proforma ne "consomme" jamais un numero de facture definitive.
async function genererNumero(cabinetId: string, estProforma: boolean): Promise<string> {
  const prefixe = estProforma ? "PROF" : "FACT";
  const annee = new Date().getFullYear();
  const count = await prisma.facture.count({
    where: { cabinetId, numero: { startsWith: `${prefixe}-${annee}-` } },
  });
  return `${prefixe}-${annee}-${String(count + 1).padStart(4, "0")}`;
}

const createFactureSchema = z.object({
  clientNom: z.string().min(1),
  dossierId: z.string().uuid().optional(),
  description: z.string().min(1),
  montant: z.number().int().positive(),
  appliquerTva: z.boolean().optional().default(false),
  estProforma: z.boolean().optional().default(false),
  dateEcheance: z.string().optional(),
});

facturesRouter.post("/api/factures", requireAuth, requireAvocat, async (req, res) => {
  const parsed = createFactureSchema.safeParse(req.body);
  if (!parsed.success) {
    return res.status(400).json({ error: "Formulaire invalide", details: parsed.error.issues });
  }

  let dossier = null;
  if (parsed.data.dossierId) {
    dossier = await prisma.dossier.findFirst({
      where: { id: parsed.data.dossierId, cabinetId: req.auth!.cabinetId },
    });
    if (!dossier) {
      return res.status(404).json({ error: "Dossier introuvable" });
    }
  }

  const numero = await genererNumero(req.auth!.cabinetId, parsed.data.estProforma);

  const facture = await prisma.facture.create({
    data: {
      cabinetId: req.auth!.cabinetId,
      dossierId: dossier?.id,
      clientNom: parsed.data.clientNom,
      numero,
      description: parsed.data.description,
      montant: parsed.data.montant,
      appliquerTva: parsed.data.appliquerTva,
      estProforma: parsed.data.estProforma,
      dateEcheance: parsed.data.dateEcheance ? new Date(parsed.data.dateEcheance) : undefined,
      createdBy: req.auth!.userId,
    },
    include: {
      dossier: { select: { numeroDossier: true, nomAffaire: true, nomClient: true } },
      creePar: { select: { nom: true } },
    },
  });

  return res.status(201).json(facture);
});

facturesRouter.get("/api/factures", requireAuth, requireAvocat, async (req, res) => {
  const dossierId = typeof req.query.dossierId === "string" ? req.query.dossierId : undefined;

  const factures = await prisma.facture.findMany({
    where: {
      cabinetId: req.auth!.cabinetId,
      ...(dossierId ? { dossierId } : {}),
    },
    include: {
      dossier: { select: { numeroDossier: true, nomAffaire: true, nomClient: true, client: true } },
      creePar: { select: { nom: true } },
    },
    orderBy: { createdAt: "desc" },
  });

  return res.json(factures);
});

async function loadFacture(id: string, cabinetId: string) {
  return prisma.facture.findFirst({
    where: { id, cabinetId },
    include: {
      dossier: { select: { numeroDossier: true, nomAffaire: true, nomClient: true, client: true } },
      creePar: { select: { nom: true } },
    },
  });
}

const updateFactureSchema = z.object({
  statut: z.enum(["brouillon", "envoyee", "payee"]),
});

facturesRouter.patch("/api/factures/:id", requireAuth, requireAvocat, async (req, res) => {
  const parsed = updateFactureSchema.safeParse(req.body);
  if (!parsed.success) {
    return res.status(400).json({ error: "Statut invalide" });
  }

  const facture = await loadFacture(req.params.id, req.auth!.cabinetId);
  if (!facture) {
    return res.status(404).json({ error: "Facture introuvable" });
  }

  const updated = await prisma.facture.update({
    where: { id: facture.id },
    data: {
      statut: parsed.data.statut,
      payeeAt: parsed.data.statut === "payee" ? new Date() : facture.payeeAt,
    },
  });

  return res.json(updated);
});

facturesRouter.get("/api/factures/:id/pdf", requireAuth, requireAvocat, async (req, res) => {
  const facture = await loadFacture(req.params.id, req.auth!.cabinetId);
  if (!facture) {
    return res.status(404).json({ error: "Facture introuvable" });
  }

  const cabinet = await prisma.cabinet.findUnique({ where: { id: req.auth!.cabinetId } });
  const entete = await resolveEntete(req.auth!.cabinetId, true);

  const buffer = await buildFacturePdf({
    cabinetNom: cabinet?.nom ?? "",
    numero: facture.numero,
    dateEmission: facture.dateEmission,
    dateEcheance: facture.dateEcheance,
    nomClient: facture.clientNom ?? facture.dossier?.nomClient ?? "-",
    numeroDossier: facture.dossier?.numeroDossier ?? null,
    nomAffaire: facture.dossier?.nomAffaire ?? null,
    description: facture.description,
    montant: facture.montant,
    appliquerTva: facture.appliquerTva,
    estProforma: facture.estProforma,
    entete,
  });

  res.setHeader("Content-Type", "application/pdf");
  res.setHeader("Content-Disposition", `attachment; filename="${facture.numero}.pdf"`);
  return res.send(buffer);
});

const envoyerSchema = z.object({
  email: z.string().email(),
});

facturesRouter.post("/api/factures/:id/envoyer", requireAuth, requireAvocat, async (req, res) => {
  const parsed = envoyerSchema.safeParse(req.body);
  if (!parsed.success) {
    return res.status(400).json({ error: "Email invalide" });
  }

  const facture = await loadFacture(req.params.id, req.auth!.cabinetId);
  if (!facture) {
    return res.status(404).json({ error: "Facture introuvable" });
  }

  const cabinet = await prisma.cabinet.findUnique({ where: { id: req.auth!.cabinetId } });
  const entete = await resolveEntete(req.auth!.cabinetId, true);

  const buffer = await buildFacturePdf({
    cabinetNom: cabinet?.nom ?? "",
    numero: facture.numero,
    dateEmission: facture.dateEmission,
    dateEcheance: facture.dateEcheance,
    nomClient: facture.clientNom ?? facture.dossier?.nomClient ?? "-",
    numeroDossier: facture.dossier?.numeroDossier ?? null,
    nomAffaire: facture.dossier?.nomAffaire ?? null,
    description: facture.description,
    montant: facture.montant,
    appliquerTva: facture.appliquerTva,
    estProforma: facture.estProforma,
    entete,
  });

  const { replyToEmail } = await resolveCabinetEmailIdentite(req.auth!.cabinetId);

  const n8nResult = await callN8nWebhook("envoyer-facture", {
    factureId: facture.id,
    cabinetNom: cabinet?.nom ?? "",
    numero: facture.numero,
    montant: facture.montant,
    description: facture.description,
    destinataireEmail: parsed.data.email,
    pdfBase64: buffer.toString("base64"),
    replyToEmail,
  });

  if (!n8nResult.ok) {
    return res.status(502).json({ error: "Échec de l'envoi de la facture", detail: n8nResult.error });
  }

  const updated = await prisma.facture.update({
    where: { id: facture.id },
    data: { statut: "envoyee", destinataireEmail: parsed.data.email, envoyeAt: new Date() },
  });

  return res.json(updated);
});
