import { prisma } from "../../lib/prisma";

/**
 * Lot 20 - numerotation sequentielle stricte des courriers, ARR-AAAA-NNNN
 * (entrants) / DEP-AAAA-NNNN (sortants), reinitialisee chaque annee civile,
 * deux sequences totalement independantes (un courrier sortant ne "consomme"
 * jamais un numero d'entrant, et inversement).
 *
 * Concurrence : generee par un SEUL `INSERT ... ON CONFLICT DO UPDATE ...
 * RETURNING`, jamais par un "lire le max puis ecrire max+1" (c'est
 * exactement le bug reel corrige sur la numerotation des factures - voir
 * routes/factures.ts, genererNumero - un SELECT suivi d'un INSERT laisse
 * une fenetre ou deux requetes concurrentes lisent la meme valeur avant que
 * l'une ou l'autre n'ecrive). Postgres verrouille implicitement la ligne
 * cible de l'UPSERT le temps de la transaction : deux appels simultanes
 * pour le meme (cabinet, annee, sens) sont serialises par la base
 * elle-meme, jamais par une logique applicative - aucun advisory lock ni
 * transaction SERIALIZABLE necessaire ici.
 */

export type SensCourrier = "entrant" | "sortant";

const PREFIXES: Record<SensCourrier, string> = {
  entrant: "ARR",
  sortant: "DEP",
};

export async function genererNumeroCourrier(cabinetId: string, sens: SensCourrier): Promise<string> {
  const annee = new Date().getFullYear();

  const rows = await prisma.$queryRaw<{ dernier_numero: number }[]>`
    INSERT INTO "sequences_courrier" ("id", "cabinet_id", "annee", "sens", "dernier_numero")
    VALUES (gen_random_uuid()::text, ${cabinetId}, ${annee}, ${sens}, 1)
    ON CONFLICT ("cabinet_id", "annee", "sens")
    DO UPDATE SET "dernier_numero" = "sequences_courrier"."dernier_numero" + 1
    RETURNING "dernier_numero"
  `;

  const dernierNumero = rows[0]?.dernier_numero;
  if (typeof dernierNumero !== "number") {
    throw new Error("Échec de la génération du numéro de courrier (séquence introuvable).");
  }

  return `${PREFIXES[sens]}-${annee}-${String(dernierNumero).padStart(4, "0")}`;
}
