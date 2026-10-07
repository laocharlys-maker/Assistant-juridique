import { Router } from "express";
import { prisma } from "../lib/prisma";
import { requireAuth } from "../middleware/requireAuth";
import { requireAvocat } from "../middleware/roles";

export const corbeilleRouter = Router();

// Duree de retention avant purge definitive - voir jobs/purgeCorbeille.ts
// (DOIT rester identique aux deux endroits, c'est juste la valeur affichee
// ici pour calculer "jours restants" cote frontend).
const RETENTION_JOURS = 30;

function joursRestants(supprimeLe: Date): number {
  const expireLe = new Date(supprimeLe.getTime() + RETENTION_JOURS * 24 * 60 * 60 * 1000);
  return Math.max(0, Math.ceil((expireLe.getTime() - Date.now()) / (24 * 60 * 60 * 1000)));
}

// Liste groupee des 3 types d'elements en corbeille pour CE cabinet - meme
// droits que la suppression elle-meme (avocat/titulaire uniquement, voir
// routes/dossiers.ts et routes/clients.ts).
corbeilleRouter.get("/api/corbeille", requireAuth, requireAvocat, async (req, res) => {
  const { auth } = req;

  const [dossiers, clients, actions] = await Promise.all([
    prisma.dossier.findMany({
      where: { cabinetId: auth!.cabinetId, supprimeLe: { not: null } },
      orderBy: { supprimeLe: "desc" },
      select: { id: true, numeroDossier: true, nomAffaire: true, supprimeLe: true, supprimePar: { select: { nom: true } } },
    }),
    prisma.client.findMany({
      where: { cabinetId: auth!.cabinetId, supprimeLe: { not: null } },
      orderBy: { supprimeLe: "desc" },
      select: { id: true, nom: true, supprimeLe: true, supprimePar: { select: { nom: true } } },
    }),
    prisma.action.findMany({
      where: { dossier: { cabinetId: auth!.cabinetId }, supprimeLe: { not: null } },
      orderBy: { supprimeLe: "desc" },
      select: {
        id: true,
        nomDocument: true,
        typeAction: true,
        supprimeLe: true,
        supprimePar: { select: { nom: true } },
        dossierId: true,
        dossier: { select: { numeroDossier: true } },
      },
    }),
  ]);

  return res.json({
    dossiers: dossiers.map((d) => ({
      id: d.id,
      titre: `${d.numeroDossier} — ${d.nomAffaire}`,
      supprimeLe: d.supprimeLe,
      supprimePar: d.supprimePar?.nom || null,
      joursRestants: joursRestants(d.supprimeLe!),
    })),
    clients: clients.map((c) => ({
      id: c.id,
      titre: c.nom,
      supprimeLe: c.supprimeLe,
      supprimePar: c.supprimePar?.nom || null,
      joursRestants: joursRestants(c.supprimeLe!),
    })),
    actions: actions.map((a) => ({
      id: a.id,
      dossierId: a.dossierId,
      titre: `${a.nomDocument || a.typeAction} (dossier ${a.dossier.numeroDossier})`,
      supprimeLe: a.supprimeLe,
      supprimePar: a.supprimePar?.nom || null,
      joursRestants: joursRestants(a.supprimeLe!),
    })),
  });
});
