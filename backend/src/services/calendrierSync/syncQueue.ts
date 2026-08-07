import cron from "node-cron";
import { prisma } from "../../lib/prisma";
import { googleCalendarAdapter } from "./googleCalendar";
import { caldavAdapter } from "./caldav";
import { CalendrierExterneAdapter, EvenementExterneInput } from "./adapter";
import type { Evenement, ProviderCalendrierExterne } from "@prisma/client";

/**
 * Lot 12b - file d'attente de synchronisation vers les agendas externes.
 *
 * Choix retenu (a documenter, demande explicite du prompt) : une TABLE
 * (EvenementSyncExterne, statut "en_attente"/"erreur"/"a_supprimer" = travail
 * a faire) plutot qu'une queue en memoire. Justification : le volume attendu
 * pour un cabinet d'avocats est faible (quelques evenements par jour, jamais
 * des milliers), donc aucun besoin de debit eleve ; en contrepartie, une
 * queue en memoire perdrait tout son contenu a chaque redemarrage du
 * serveur (deploiement, mise a jour, coupure electrique cote poste desktop)
 * - une table Postgres survit nativement a un redemarrage, sans code
 * supplementaire de persistance. Le "worker" est un simple cycle planifie
 * par node-cron (meme mecanisme que les autres jobs du projet - voir
 * jobs/liberationVerrousExpires.ts, Lot 11).
 *
 * Strictement asynchrone : les fonctions enqueuerXxx() ci-dessous ne font
 * QUE des ecritures DB (jamais d'appel reseau vers Google/CalDAV) - elles
 * sont appelees en bout de route (POST/PATCH/DELETE /api/evenements,
 * evenementSync.ts) sans jamais ralentir la reponse HTTP. Le veritable
 * travail reseau n'a lieu que dans runSyncCycle(), execute en tache de fond.
 */

const MAX_TENTATIVES = 5;
const CRON_EXPRESSION = "*/2 * * * *"; // toutes les 2 minutes

function adapterPour(provider: ProviderCalendrierExterne): CalendrierExterneAdapter {
  return provider === "google" ? googleCalendarAdapter : caldavAdapter;
}

function versEvenementExterne(evenement: Evenement): EvenementExterneInput {
  return {
    titre: evenement.titre,
    description: evenement.description,
    lieu: evenement.lieu,
    dateDebut: evenement.dateDebut,
    dateFin: evenement.dateFin,
    touteLaJournee: evenement.touteLaJournee,
  };
}

/**
 * Met en file la creation/mise a jour d'un Evenement vers CHAQUE connexion
 * active appartenant au createur ou a un assigne (voir README-LOT12B.md
 * pour la justification de ce perimetre). Hook additif : jamais appele a
 * l'interieur d'une transaction metier, jamais capable de faire echouer
 * l'appelant (try/catch interne, meme contrat que evenementSync.ts, Lot 12a).
 */
export async function enqueuerSyncEvenement(evenementId: string): Promise<void> {
  try {
    const evenement = await prisma.evenement.findUnique({
      where: { id: evenementId },
      include: { assignes: { select: { userId: true } } },
    });
    if (!evenement) return;

    const userIds = new Set<string>([evenement.createdById, ...evenement.assignes.map((a) => a.userId)]);
    if (userIds.size === 0) return;

    const connexions = await prisma.connexionCalendrierExterne.findMany({
      where: { userId: { in: [...userIds] }, actif: true },
      select: { id: true },
    });
    if (connexions.length === 0) return;

    for (const connexion of connexions) {
      await prisma.evenementSyncExterne.upsert({
        where: { evenementId_connexionId: { evenementId, connexionId: connexion.id } },
        create: { evenementId, connexionId: connexion.id, statut: "en_attente" },
        update: { statut: "en_attente", tentatives: 0, derniereErreur: null },
      });
    }
  } catch (error) {
    console.error(
      `[sync-queue] échec de mise en file (création/modification) pour l'événement ${evenementId} :`,
      error instanceof Error ? error.message : error
    );
  }
}

/**
 * Marque les syncs existantes d'un Evenement pour suppression externe -
 * appelee AVANT la suppression effective de l'Evenement cote Aurore (voir
 * routes/evenements.ts), pendant que les lignes EvenementSyncExterne sont
 * encore rattachees (evenementId non nul).
 */
export async function enqueuerSuppressionEvenement(evenementId: string): Promise<void> {
  try {
    await prisma.evenementSyncExterne.updateMany({
      where: { evenementId },
      data: { statut: "a_supprimer", tentatives: 0, derniereErreur: null },
    });
  } catch (error) {
    console.error(
      `[sync-queue] échec de mise en file (suppression) pour l'événement ${evenementId} :`,
      error instanceof Error ? error.message : error
    );
  }
}

async function traiterSuppressions(): Promise<void> {
  const aSupprimer = await prisma.evenementSyncExterne.findMany({
    where: { statut: "a_supprimer" },
    include: { connexion: true },
  });

  for (const sync of aSupprimer) {
    try {
      if (sync.externalEventId) {
        await adapterPour(sync.connexion.provider).supprimerEvenement(sync.connexion, sync.externalEventId);
      }
      await prisma.evenementSyncExterne.delete({ where: { id: sync.id } });
    } catch (error) {
      const tentatives = sync.tentatives + 1;
      const message = error instanceof Error ? error.message : String(error);
      // Jamais les tokens/identifiants dans les logs - uniquement le
      // provider, l'id de connexion (opaque) et le message d'erreur.
      console.error(
        `[sync-queue] échec de suppression externe (provider=${sync.connexion.provider}, connexion=${sync.connexionId}, tentative ${tentatives}/${MAX_TENTATIVES}) :`,
        message
      );
      if (tentatives >= MAX_TENTATIVES) {
        // Abandon apres plusieurs echecs : l'evenement restera cote externe
        // (l'utilisateur le supprime lui-meme si besoin - voir contrainte
        // "deconnexion" du prompt, meme logique appliquee ici a l'echec
        // permanent). Jamais un blocage indefini de la file.
        await prisma.evenementSyncExterne.delete({ where: { id: sync.id } }).catch(() => null);
      } else {
        await prisma.evenementSyncExterne
          .update({ where: { id: sync.id }, data: { tentatives, derniereErreur: message.slice(0, 500) } })
          .catch(() => null);
      }
    }
  }
}

async function traiterCreationsEtModifications(): Promise<void> {
  const enAttente = await prisma.evenementSyncExterne.findMany({
    where: { statut: { in: ["en_attente", "erreur"] }, tentatives: { lt: MAX_TENTATIVES }, evenementId: { not: null } },
    include: { connexion: true, evenement: true },
  });

  for (const sync of enAttente) {
    if (!sync.evenement) continue; // filet de securite, ne devrait pas arriver (evenementId non nul ci-dessus)
    try {
      const adapter = adapterPour(sync.connexion.provider);
      const payload = versEvenementExterne(sync.evenement);
      if (sync.externalEventId) {
        await adapter.modifierEvenement(sync.connexion, sync.externalEventId, payload);
        await prisma.evenementSyncExterne.update({
          where: { id: sync.id },
          data: { statut: "synchronise", tentatives: 0, derniereErreur: null },
        });
      } else {
        const externalEventId = await adapter.creerEvenement(sync.connexion, payload);
        await prisma.evenementSyncExterne.update({
          where: { id: sync.id },
          data: { statut: "synchronise", externalEventId, tentatives: 0, derniereErreur: null },
        });
      }
    } catch (error) {
      const tentatives = sync.tentatives + 1;
      const message = error instanceof Error ? error.message : String(error);
      console.error(
        `[sync-queue] échec de synchronisation (provider=${sync.connexion.provider}, événement=${sync.evenementId}, tentative ${tentatives}/${MAX_TENTATIVES}) :`,
        message
      );
      await prisma.evenementSyncExterne
        .update({ where: { id: sync.id }, data: { statut: "erreur", tentatives, derniereErreur: message.slice(0, 500) } })
        .catch(() => null);
    }
  }
}

/** Un cycle complet - exporte separement pour permettre un declenchement
 * manuel (tests, futur bouton "Synchroniser maintenant"). */
export async function runSyncCycle(): Promise<void> {
  await traiterSuppressions();
  await traiterCreationsEtModifications();
}

export function scheduleSyncQueue(): void {
  cron.schedule(
    CRON_EXPRESSION,
    () => {
      runSyncCycle().catch((error) => {
        console.error(
          "[sync-queue] erreur lors du cycle de synchronisation calendrier externe :",
          error instanceof Error ? error.message : error
        );
      });
    },
    { timezone: "Africa/Porto-Novo" }
  );
  console.log(`[sync-queue] synchronisation calendrier externe planifiée (${CRON_EXPRESSION}).`);
}
