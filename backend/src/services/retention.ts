import { prisma } from "../lib/prisma";

const DUREE_INACTIVITE_RECHERCHES_MOIS = 12;
const DUREE_RETENTION_AUDIT_LOGS_MOIS = 24;

function moisAvant(mois: number): Date {
  const date = new Date();
  date.setMonth(date.getMonth() - mois);
  return date;
}

// Les logs d'audit (traces techniques d'envoi/generation) n'ont pas besoin
// d'etre conserves indefiniment - contrairement au contenu des documents
// eux-memes (Action.contenuGenere), qui n'est jamais touche ici.
export async function purgerLogsAudit(): Promise<number> {
  const seuil = moisAvant(DUREE_RETENTION_AUDIT_LOGS_MOIS);
  const result = await prisma.auditLog.deleteMany({ where: { timestamp: { lt: seuil } } });
  return result.count;
}

// Fiches de recherche (jurisprudence, recherche juridique, resume PDF,
// veille, traduction) : ce ne sont pas de vrais dossiers clients, pas
// d'obligation de conservation - suppression si inactives depuis longtemps.
export async function purgerFichesRecherchesInactives(): Promise<number> {
  const seuil = moisAvant(DUREE_INACTIVITE_RECHERCHES_MOIS);
  const dossiers = await prisma.dossier.findMany({
    where: { estRecherche: true, updatedAt: { lt: seuil } },
    select: { id: true },
  });
  const ids = dossiers.map((d) => d.id);
  if (ids.length === 0) return 0;

  const actions = await prisma.action.findMany({
    where: { dossierId: { in: ids } },
    select: { id: true },
  });
  const actionIds = actions.map((a) => a.id);

  await prisma.auditLog.deleteMany({ where: { actionId: { in: actionIds } } });
  await prisma.action.deleteMany({ where: { dossierId: { in: ids } } });
  await prisma.delaiCalcul.updateMany({ where: { dossierId: { in: ids } }, data: { dossierId: null } });
  await prisma.dossier.deleteMany({ where: { id: { in: ids } } });
  return ids.length;
}

// Dossiers clients reels : jamais de suppression automatique (obligation
// professionnelle). On se contente de les archiver (masquer de la liste par
// defaut) un certain temps apres leur cloture, delai reglable par cabinet.
export async function archiverDossiersClotures(): Promise<number> {
  const cabinets = await prisma.cabinet.findMany({ select: { id: true, archivageDelaiMois: true } });
  let total = 0;
  for (const cabinet of cabinets) {
    const seuil = moisAvant(cabinet.archivageDelaiMois);
    const result = await prisma.dossier.updateMany({
      where: {
        cabinetId: cabinet.id,
        estRecherche: false,
        statut: "cloture",
        archivedAt: null,
        dateCloture: { lt: seuil },
      },
      data: { archivedAt: new Date() },
    });
    total += result.count;
  }
  return total;
}

export async function runRetentionJobs(): Promise<void> {
  const [logsSupprimes, fichesSupprimees, dossiersArchives] = await Promise.all([
    purgerLogsAudit(),
    purgerFichesRecherchesInactives(),
    archiverDossiersClotures(),
  ]);
  console.log(
    `Retention : ${logsSupprimes} log(s) d'audit purgé(s), ${fichesSupprimees} fiche(s) recherche supprimée(s), ${dossiersArchives} dossier(s) archivé(s).`
  );
}
