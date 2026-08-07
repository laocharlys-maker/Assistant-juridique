import cron from "node-cron";
import { prisma } from "../lib/prisma";

const DEFAULT_TIMEOUT_HEURES = 4;

// Delai configurable (VERROU_TIMEOUT_HEURES, en heures) au-dela duquel un
// verrou d'edition (Action.verrouillePar/verrouilleLe - Lot 11 Partie A) est
// considere abandonne. Exporte pour etre partage entre ce job et les routes
// (verifierVerrou.ts) : les deux doivent utiliser exactement le meme seuil.
export function verrouTimeoutMs(): number {
  const heures = Number(process.env.VERROU_TIMEOUT_HEURES) || DEFAULT_TIMEOUT_HEURES;
  return heures * 60 * 60 * 1000;
}

/**
 * Libere tout verrou d'edition non relache depuis plus de
 * VERROU_TIMEOUT_HEURES (4h par defaut) - filet de securite pour le cas ou
 * quelqu'un ferme son poste sans cliquer "Terminer l'édition". N'affecte que
 * le verrou (verrouillePar/verrouilleLe) : ne touche jamais au contenu, au
 * statut, ni a l'historique des versions.
 */
export async function runLiberationVerrousExpires(): Promise<number> {
  const seuil = new Date(Date.now() - verrouTimeoutMs());
  const expires = await prisma.action.findMany({
    where: { verrouillePar: { not: null }, verrouilleLe: { lt: seuil } },
    select: { id: true, verrouillePar: true, verrouilleLe: true },
  });
  if (expires.length === 0) return 0;

  await prisma.action.updateMany({
    where: { id: { in: expires.map((a) => a.id) } },
    data: { verrouillePar: null, verrouilleLe: null },
  });

  for (const a of expires) {
    console.log(
      `[verrous] verrou expire libere automatiquement : action ${a.id} (detenu par ${a.verrouillePar} depuis ${a.verrouilleLe?.toISOString()})`
    );
  }
  return expires.length;
}

/**
 * Integre la liberation des verrous expires au meme mecanisme node-cron que
 * les autres jobs planifies du projet (phone-home licence, veille juridique,
 * retention - voir src/index.ts). Toutes les 30 minutes : un verrou
 * configure a 4h par defaut n'a pas besoin d'une frequence plus fine.
 */
export function scheduleLiberationVerrousExpires(): void {
  cron.schedule(
    "*/30 * * * *",
    () => {
      runLiberationVerrousExpires().catch((error) => {
        console.error("Erreur lors de la liberation des verrous expires :", error);
      });
    },
    { timezone: "Africa/Porto-Novo" }
  );
  console.log(
    `[verrous] liberation automatique planifiee toutes les 30 minutes (timeout=${verrouTimeoutMs() / 3600000}h).`
  );
}
