import { Router } from "express";
import { z } from "zod";
import { prisma } from "../lib/prisma";
import { requireAuth } from "../middleware/requireAuth";
import { requireModule } from "../middleware/roles";
import { logAuditPersonnel } from "../services/audit";
import { buildEtatPaiementCsv, buildEtatPaiementPdf, type LigneEtatInput } from "../services/etatPaiementExport";

export const etatPaiementRouter = Router();

etatPaiementRouter.use(["/api/periodes-paie", "/api/lignes-paiement", "/api/etats-paiement"], requireAuth, requireModule("rh_paie"));

const SELECT_ETAT = {
  id: true,
  periodePaieId: true,
  statut: true,
  totalBrut: true,
  totalRetenues: true,
  totalNet: true,
  genereLe: true,
  lignes: {
    select: {
      id: true,
      fichePaieId: true,
      modePaiement: true,
      statutPaiement: true,
      datePaiement: true,
      reference: true,
      fichePaie: { select: { brut: true, totalRetenues: true, net: true, fichePersonnel: { select: { id: true, nom: true, prenoms: true } } } },
    },
  },
} as const;

async function construireLignes(periodePaieId: string) {
  const fichesValidees = await prisma.fichePaie.findMany({
    where: { periodePaieId, statut: "validee" },
    select: { id: true, fichePersonnel: { select: { modePaiement: true } } },
  });
  return fichesValidees;
}

// Generation/regeneration - uniquement a partir des fiches VALIDEES de la
// periode (spec section 5.5). Regenerable tant qu'en brouillon : une
// fiche validee apres coup est alors incluse a son tour, et les lignes
// deja marquees "payees" conservent leur statut (upsert par fichePaieId,
// jamais de reset).
etatPaiementRouter.post("/api/periodes-paie/:mois/etat-paiement", async (req, res) => {
  if (req.auth!.role !== "titulaire") return res.status(403).json({ error: "Seul le titulaire peut générer l'état de paiement." });

  const periode = await prisma.periodePaie.findUnique({ where: { cabinetId_mois: { cabinetId: req.auth!.cabinetId, mois: req.params.mois } } });
  if (!periode) return res.status(404).json({ error: "Aucune période ouverte pour ce mois." });

  let etat = await prisma.etatPaiement.findUnique({ where: { periodePaieId: periode.id } });
  if (etat && etat.statut !== "brouillon") {
    return res.status(409).json({ error: "Cet état de paiement est déjà validé - régénération impossible." });
  }

  const fichesValidees = await construireLignes(periode.id);
  if (fichesValidees.length === 0) {
    return res.status(400).json({ error: "Aucune fiche de paie validée pour cette période." });
  }

  if (!etat) {
    etat = await prisma.etatPaiement.create({ data: { cabinetId: req.auth!.cabinetId, periodePaieId: periode.id, genereParId: req.auth!.userId } });
  }

  for (const f of fichesValidees) {
    await prisma.lignePaiement.upsert({
      where: { fichePaieId: f.id },
      update: {},
      create: { etatPaiementId: etat.id, fichePaieId: f.id, modePaiement: f.fichePersonnel.modePaiement },
    });
  }
  // Retire les lignes dont la fiche n'est plus validee (annulee depuis).
  await prisma.lignePaiement.deleteMany({ where: { etatPaiementId: etat.id, fichePaieId: { notIn: fichesValidees.map((f) => f.id) } } });

  const toutesLesLignes = await prisma.lignePaiement.findMany({ where: { etatPaiementId: etat.id }, include: { fichePaie: true } });
  const totalBrut = toutesLesLignes.reduce((s, l) => s + l.fichePaie.brut, 0);
  const totalRetenues = toutesLesLignes.reduce((s, l) => s + l.fichePaie.totalRetenues, 0);
  const totalNet = toutesLesLignes.reduce((s, l) => s + l.fichePaie.net, 0);

  const misAJour = await prisma.etatPaiement.update({
    where: { id: etat.id },
    data: { totalBrut, totalRetenues, totalNet, genereLe: new Date() },
    select: SELECT_ETAT,
  });
  return res.status(201).json(misAJour);
});

etatPaiementRouter.get("/api/periodes-paie/:mois/etat-paiement", async (req, res) => {
  if (req.auth!.role !== "titulaire") return res.status(403).json({ error: "Seul le titulaire peut consulter l'état de paiement." });
  const periode = await prisma.periodePaie.findUnique({ where: { cabinetId_mois: { cabinetId: req.auth!.cabinetId, mois: req.params.mois } } });
  if (!periode) return res.status(404).json({ error: "Aucune période ouverte pour ce mois." });

  const etat = await prisma.etatPaiement.findUnique({ where: { periodePaieId: periode.id }, select: SELECT_ETAT });
  if (!etat) return res.status(404).json({ error: "Aucun état de paiement généré pour cette période." });
  return res.json(etat);
});

const marquerPayeSchema = z.object({
  statutPaiement: z.enum(["a_payer", "paye"]),
  datePaiement: z.string().optional().nullable(),
  reference: z.string().trim().optional(),
});

etatPaiementRouter.patch("/api/lignes-paiement/:id", async (req, res) => {
  if (req.auth!.role !== "titulaire") return res.status(403).json({ error: "Seul le titulaire peut marquer un paiement." });
  const parsed = marquerPayeSchema.safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: "Formulaire invalide", details: parsed.error.issues });

  const ligne = await prisma.lignePaiement.findFirst({
    where: { id: req.params.id, etatPaiement: { cabinetId: req.auth!.cabinetId } },
    include: { etatPaiement: true, fichePaie: { select: { fichePersonnelId: true } } },
  });
  if (!ligne) return res.status(404).json({ error: "Ligne introuvable" });
  if (ligne.etatPaiement.statut !== "brouillon") {
    return res.status(409).json({ error: "Cet état de paiement est déjà validé - plus aucune modification possible." });
  }

  const misAJour = await prisma.lignePaiement.update({
    where: { id: ligne.id },
    data: {
      statutPaiement: parsed.data.statutPaiement,
      datePaiement: parsed.data.statutPaiement === "paye" ? (parsed.data.datePaiement ? new Date(parsed.data.datePaiement) : new Date()) : null,
      reference: parsed.data.statutPaiement === "paye" ? parsed.data.reference || null : null,
    },
  });

  await logAuditPersonnel(
    ligne.fichePaie.fichePersonnelId,
    "paiement_statut_modifie",
    "succes",
    `${parsed.data.statutPaiement} par ${req.auth!.userId} (jamais de montant dans ce journal)`
  );
  return res.json(misAJour);
});

// Validation : verrouille l'etat (plus aucune regeneration ni marquage de
// paiement), et CLOTURE la periode de paie (spec section 5.5 : "verrouille
// a la validation, comme la fiche" - PeriodePaie.statut passe a "cloturee").
etatPaiementRouter.post("/api/etats-paiement/:id/valider", async (req, res) => {
  if (req.auth!.role !== "titulaire") return res.status(403).json({ error: "Seul le titulaire peut valider l'état de paiement." });

  const etat = await prisma.etatPaiement.findFirst({ where: { id: req.params.id, cabinetId: req.auth!.cabinetId } });
  if (!etat) return res.status(404).json({ error: "État de paiement introuvable" });
  if (etat.statut !== "brouillon") return res.status(409).json({ error: "Cet état est déjà validé." });

  await prisma.$transaction([
    prisma.etatPaiement.update({ where: { id: etat.id }, data: { statut: "valide" } }),
    prisma.periodePaie.update({ where: { id: etat.periodePaieId }, data: { statut: "cloturee" } }),
  ]);

  const complet = await prisma.etatPaiement.findUniqueOrThrow({ where: { id: etat.id }, select: SELECT_ETAT });
  return res.json(complet);
});

async function chargerPourExport(etatId: string, cabinetId: string) {
  const etat = await prisma.etatPaiement.findFirst({
    where: { id: etatId, cabinetId },
    include: {
      periodePaie: true,
      lignes: { include: { fichePaie: { include: { fichePersonnel: { select: { nom: true, prenoms: true } } } } } },
    },
  });
  if (!etat) return null;
  const cabinet = await prisma.cabinet.findUniqueOrThrow({ where: { id: cabinetId }, select: { nom: true } });
  const lignes: LigneEtatInput[] = etat.lignes.map((l) => ({
    nomEmploye: `${l.fichePaie.fichePersonnel.nom}${l.fichePaie.fichePersonnel.prenoms ? " " + l.fichePaie.fichePersonnel.prenoms : ""}`,
    brut: l.fichePaie.brut,
    totalRetenues: l.fichePaie.totalRetenues,
    net: l.fichePaie.net,
    modePaiement: l.modePaiement,
    statutPaiement: l.statutPaiement as "a_payer" | "paye",
  }));
  return { cabinetNom: cabinet.nom, mois: etat.periodePaie.mois, lignes, totalBrut: etat.totalBrut, totalRetenues: etat.totalRetenues, totalNet: etat.totalNet };
}

etatPaiementRouter.get("/api/etats-paiement/:id/export.pdf", async (req, res) => {
  if (req.auth!.role !== "titulaire") return res.status(403).json({ error: "Seul le titulaire peut exporter l'état de paiement." });
  const input = await chargerPourExport(req.params.id, req.auth!.cabinetId);
  if (!input) return res.status(404).json({ error: "État de paiement introuvable" });

  const pdf = await buildEtatPaiementPdf(input);
  res.setHeader("Content-Type", "application/pdf");
  res.setHeader("Content-Disposition", `attachment; filename="etat-paiement-${input.mois}.pdf"`);
  return res.send(pdf);
});

etatPaiementRouter.get("/api/etats-paiement/:id/export.csv", async (req, res) => {
  if (req.auth!.role !== "titulaire") return res.status(403).json({ error: "Seul le titulaire peut exporter l'état de paiement." });
  const input = await chargerPourExport(req.params.id, req.auth!.cabinetId);
  if (!input) return res.status(404).json({ error: "État de paiement introuvable" });

  const csv = buildEtatPaiementCsv(input);
  res.setHeader("Content-Type", "text/csv; charset=utf-8");
  res.setHeader("Content-Disposition", `attachment; filename="etat-paiement-${input.mois}.csv"`);
  return res.send(csv);
});
