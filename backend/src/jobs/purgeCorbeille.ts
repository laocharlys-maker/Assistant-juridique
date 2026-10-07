import cron from "node-cron";
import type { Prisma } from "@prisma/client";
import { prisma } from "../lib/prisma";

// Corbeille (2026-10-07) : duree de retention avant purge DEFINITIVE - DOIT
// rester identique a routes/corbeille.ts (RETENTION_JOURS), qui affiche le
// "jours restants" calcule a partir de cette meme valeur.
const RETENTION_JOURS = 30;

/**
 * Supprime definitivement (vrai DELETE SQL, plus aucune restauration
 * possible) toutes les lignes dependantes d'une Action avant l'Action
 * elle-meme - ce projet n'utilise jamais onDelete: Cascade (voir
 * schema.prisma), donc l'ordre est important : SaisieTemps.actionId est
 * seulement DETACHE (mis a null) - une saisie de temps garde sa valeur/sa
 * duree meme si le document genere correspondant disparait, jamais
 * supprimee avec lui.
 */
async function purgerAction(tx: Prisma.TransactionClient, actionId: string): Promise<void> {
  await tx.saisieTemps.updateMany({ where: { actionId }, data: { actionId: null } });
  await tx.auditLog.deleteMany({ where: { actionId } });
  await tx.commentaireRevision.deleteMany({ where: { actionId } });
  await tx.actionVersionFichier.deleteMany({ where: { actionId } });
  await tx.actionVersion.deleteMany({ where: { actionId } });
  await tx.action.delete({ where: { id: actionId } });
}

/**
 * Supprime definitivement un Dossier et tout ce qui lui est propre - jamais
 * une Facture (la suppression du dossier est bloquee en amont, voir
 * routes/dossiers.ts, tant qu'une facture existe : ne devrait donc jamais
 * se produire ici, mais on ne delete surtout pas les factures
 * silencieusement si on en trouve une malgre tout - le dossier est alors
 * simplement laisse en l'etat, erreur journalisee, retente au prochain
 * cycle). CourrierEntrant/CourrierSortant ont leur propre valeur
 * independante (historique de correspondance) : seulement DETACHES
 * (dossierId mis a null), jamais supprimes.
 */
async function purgerDossier(dossierId: string): Promise<void> {
  await prisma.$transaction(async (tx) => {
    const facturesRestantes = await tx.facture.count({ where: { dossierId } });
    if (facturesRestantes > 0) {
      throw new Error(`dossier ${dossierId} a encore ${facturesRestantes} facture(s) - purge annulee, a retenter plus tard`);
    }

    const actions = await tx.action.findMany({ where: { dossierId }, select: { id: true } });
    for (const a of actions) {
      await purgerAction(tx, a.id);
    }

    const pieces = await tx.documentDossier.findMany({ where: { dossierId }, select: { id: true } });
    for (const p of pieces) {
      await tx.ocrResultat.deleteMany({ where: { documentId: p.id } });
    }
    await tx.documentDossier.deleteMany({ where: { dossierId } });

    const evenements = await tx.evenement.findMany({ where: { dossierId }, select: { id: true } });
    for (const e of evenements) {
      await tx.evenementAssigne.deleteMany({ where: { evenementId: e.id } });
    }
    await tx.evenement.deleteMany({ where: { dossierId } });

    await tx.saisieTemps.deleteMany({ where: { dossierId } });
    await tx.roleAudience.deleteMany({ where: { dossierId } });
    await tx.delaiCalcul.deleteMany({ where: { dossierId } });
    await tx.courrierEntrant.updateMany({ where: { dossierId }, data: { dossierId: null } });
    await tx.courrierSortant.updateMany({ where: { dossierId }, data: { dossierId: null } });

    await tx.dossier.delete({ where: { id: dossierId } });
  });
}

/**
 * Supprime definitivement un Client - bloque en amont (routes/clients.ts)
 * tant qu'il reste au moins un Dossier non supprime, donc ses dossiers sont
 * normalement deja tous en corbeille ou purges a ce stade. CourrierEntrant/
 * CourrierSortant directement rattaches au client (sans dossier) sont
 * DETACHES, jamais supprimes, meme logique que pour un dossier.
 */
async function purgerClient(clientId: string): Promise<void> {
  await prisma.$transaction(async (tx) => {
    const dossiersRestants = await tx.dossier.count({ where: { clientId } });
    if (dossiersRestants > 0) {
      throw new Error(`client ${clientId} a encore ${dossiersRestants} dossier(s) - purge annulee, a retenter plus tard`);
    }
    await tx.courrierEntrant.updateMany({ where: { clientId }, data: { clientId: null } });
    await tx.courrierSortant.updateMany({ where: { clientId }, data: { clientId: null } });
    await tx.client.delete({ where: { id: clientId } });
  });
}

export async function runPurgeCorbeille(): Promise<{ dossiers: number; clients: number; actions: number }> {
  const seuil = new Date(Date.now() - RETENTION_JOURS * 24 * 60 * 60 * 1000);
  let dossiers = 0;
  let clients = 0;
  let actionsCount = 0;

  // Actions supprimees seules (pas via un dossier entier en corbeille) -
  // purgees en premier, independamment.
  const actionsAPurger = await prisma.action.findMany({
    where: { supprimeLe: { not: null, lt: seuil } },
    select: { id: true },
  });
  for (const a of actionsAPurger) {
    try {
      await prisma.$transaction((tx) => purgerAction(tx, a.id));
      actionsCount++;
      console.log(`[corbeille] document genere purge definitivement : ${a.id}`);
    } catch (error) {
      console.error(`[corbeille] échec de la purge du document ${a.id} (retenté au prochain cycle) :`, error instanceof Error ? error.message : error);
    }
  }

  const dossiersAPurger = await prisma.dossier.findMany({
    where: { supprimeLe: { not: null, lt: seuil } },
    select: { id: true },
  });
  for (const d of dossiersAPurger) {
    try {
      await purgerDossier(d.id);
      dossiers++;
      console.log(`[corbeille] dossier purgé définitivement : ${d.id}`);
    } catch (error) {
      console.error(`[corbeille] échec de la purge du dossier ${d.id} (retenté au prochain cycle) :`, error instanceof Error ? error.message : error);
    }
  }

  const clientsAPurger = await prisma.client.findMany({
    where: { supprimeLe: { not: null, lt: seuil } },
    select: { id: true },
  });
  for (const c of clientsAPurger) {
    try {
      await purgerClient(c.id);
      clients++;
      console.log(`[corbeille] client purgé définitivement : ${c.id}`);
    } catch (error) {
      console.error(`[corbeille] échec de la purge du client ${c.id} (retenté au prochain cycle) :`, error instanceof Error ? error.message : error);
    }
  }

  return { dossiers, clients, actions: actionsCount };
}

/**
 * Meme mecanisme node-cron que les autres jobs planifies (voir
 * jobs/suppressionDelaisExpires.ts) - creneau 2h du matin, libre (delais a
 * 4h, sauvegarde a 3h par defaut).
 */
export function schedulePurgeCorbeille(): void {
  cron.schedule(
    "0 2 * * *",
    () => {
      runPurgeCorbeille().catch((error) => {
        console.error("[corbeille] erreur lors de la purge automatique planifiée :", error);
      });
    },
    { timezone: "Africa/Porto-Novo" }
  );
  console.log(`[corbeille] purge définitive planifiée chaque jour à 2h (éléments en corbeille depuis plus de ${RETENTION_JOURS} jours).`);
}
