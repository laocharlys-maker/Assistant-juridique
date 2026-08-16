import cron from "node-cron";
import { prisma } from "../lib/prisma";
import { supprimerEvenementDepuisDelaiCalcul } from "../services/evenementSync";

const DELAI_RETENTION_JOURS = 3;

/**
 * Supprime automatiquement tout DelaiCalcul dont la dateLimite est depassee
 * de plus de DELAI_RETENTION_JOURS (3 jours) - demande explicite du prompt
 * ("Délais"), pour ne pas laisser s'accumuler des echeances perimees dans
 * l'ecran "Échéances". Meme mecanisme de suppression que la route manuelle
 * DELETE /api/delais/:id (routes/delais.ts) : suppression du DelaiCalcul
 * PUIS nettoyage de l'Evenement calendrier lie (jamais l'inverse, pour ne
 * jamais laisser un evenement orphelin si la suppression du delai echoue).
 * Un delai encore non depasse, ou depasse depuis moins de 3 jours, n'est
 * JAMAIS touche ici (voir aussi le bouton "Supprimer" manuel cote frontend,
 * echeances.html, qui lui apparait des que le delai est depasse - pas
 * besoin d'attendre les 3 jours pour une suppression volontaire).
 */
export async function runSuppressionDelaisExpires(): Promise<number> {
  const seuil = new Date(Date.now() - DELAI_RETENTION_JOURS * 24 * 60 * 60 * 1000);
  const expires = await prisma.delaiCalcul.findMany({
    where: { dateLimite: { lt: seuil } },
    select: { id: true, dateLimite: true },
  });
  if (expires.length === 0) return 0;

  await prisma.delaiCalcul.deleteMany({ where: { id: { in: expires.map((d) => d.id) } } });

  for (const d of expires) {
    console.log(
      `[delais] delai expire depuis plus de ${DELAI_RETENTION_JOURS} jours supprime automatiquement : ${d.id} (date limite ${d.dateLimite.toISOString()})`
    );
    // Best-effort, comme la route manuelle - n'interrompt jamais le
    // traitement des autres delais expires de ce cycle si un seul echoue.
    await supprimerEvenementDepuisDelaiCalcul(d.id).catch((error) => {
      console.error(
        `[delais] échec de nettoyage de l'événement calendrier lié au délai ${d.id} (ignoré) :`,
        error instanceof Error ? error.message : error
      );
    });
  }
  return expires.length;
}

/**
 * Integre la suppression automatique des delais expires au meme mecanisme
 * node-cron que les autres jobs planifies du projet (voir src/index.ts).
 * Quotidien (4h du matin) : une retention de 3 jours a une granularite
 * journaliere, pas besoin d'une frequence plus fine que jobs/
 * liberationVerrousExpires.ts (30 min, seuil en heures).
 */
export function scheduleSuppressionDelaisExpires(): void {
  cron.schedule(
    "0 4 * * *",
    () => {
      runSuppressionDelaisExpires().catch((error) => {
        console.error("Erreur lors de la suppression automatique des délais expirés :", error);
      });
    },
    { timezone: "Africa/Porto-Novo" }
  );
  console.log(
    `[delais] suppression automatique planifiée chaque jour à 4h (délais dépassés depuis plus de ${DELAI_RETENTION_JOURS} jours).`
  );
}
