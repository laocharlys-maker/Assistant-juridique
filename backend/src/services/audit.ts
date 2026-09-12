import { prisma } from "../lib/prisma";
import { StatutExecution } from "@prisma/client";

export async function logAuditStep(
  actionId: string,
  etape: string,
  statut: StatutExecution,
  detail?: string
): Promise<void> {
  await prisma.auditLog.create({
    data: { actionId, etape, statut, detail },
  });
}

/**
 * Lot 20 - meme mecanisme de journalisation (meme table audit_logs), pour
 * les evenements du registre courrier (transition de statut, affectation,
 * delai cree, reponse generee, classement - voir services/courriers/
 * courrierService.ts) : jamais un journal parallele specifique au courrier.
 * Exactement un des deux liens est renseigne (jamais les deux, jamais
 * aucun) - reflete la contrainte du schema (AuditLog.actionId est desormais
 * facultatif pour permettre cette extension additive, voir la migration
 * Lot 20).
 */
export async function logAuditCourrier(
  lien: { courrierEntrantId: string } | { courrierSortantId: string },
  etape: string,
  statut: StatutExecution,
  detail?: string
): Promise<void> {
  await prisma.auditLog.create({
    data: { ...lien, etape, statut, detail },
  });
}
