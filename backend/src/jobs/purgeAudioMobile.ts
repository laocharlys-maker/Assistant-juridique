import cron from "node-cron";
import { prisma } from "../lib/prisma";
import { supprimerFichierMobile } from "../services/mobileSync/stockageMobile";
import { logMobileAudit } from "../services/mobileSync/mobileAudit";

/**
 * Suppression automatique de l'audio mobile (Prompt 2, objectif F) - un
 * cabinet peut choisir une conservation de 7/30/90 jours APRES passage au
 * statut "traite" ; par defaut (`mobileConservationAudioJours` null),
 * AUCUNE suppression automatique n'a lieu (valeur par defaut explicite du
 * prompt). Ne concerne jamais les scans/notes, ni un audio pas encore
 * traite (on ne supprime jamais un element que l'avocat n'a pas encore
 * exploite).
 */
export async function runPurgeAudioMobile(): Promise<number> {
  const cabinets = await prisma.cabinet.findMany({
    where: { mobileConservationAudioJours: { not: null } },
    select: { id: true, mobileConservationAudioJours: true },
  });

  let total = 0;
  for (const cabinet of cabinets) {
    const seuil = new Date(Date.now() - cabinet.mobileConservationAudioJours! * 24 * 60 * 60 * 1000);
    const audiosExpires = await prisma.mobileItem.findMany({
      where: { cabinetId: cabinet.id, type: "audio", statut: "traite", recuLe: { lt: seuil } },
      select: { id: true, deviceId: true, cheminFichier: true },
    });

    for (const item of audiosExpires) {
      if (item.cheminFichier) {
        await supprimerFichierMobile(item.deviceId, item.cheminFichier).catch((error) => {
          console.error(`[mobile-audio] échec de suppression du fichier pour l'élément ${item.id} (ignoré) :`, error);
        });
      }
      await prisma.mobileItem.delete({ where: { id: item.id } });
      await logMobileAudit(cabinet.id, "audio_purge_automatique", "succes", `item=${item.id}`, item.deviceId);
      total++;
    }
  }
  return total;
}

export function schedulePurgeAudioMobile(): void {
  cron.schedule(
    "0 3 * * *",
    () => {
      runPurgeAudioMobile().catch((error) => {
        console.error("Erreur lors de la purge automatique de l'audio mobile :", error);
      });
    },
    { timezone: "Africa/Porto-Novo" }
  );
  console.log("[mobile-audio] purge automatique planifiée chaque jour à 3h (selon le réglage par cabinet).");
}
