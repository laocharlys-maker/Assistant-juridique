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

/**
 * Module RH Cabinet (RH-1) - meme mecanisme que logAuditCourrier ci-dessus,
 * pour tracer l'acces/la creation/la modification d'une fiche personnel.
 * "detail" ne doit JAMAIS contenir de montant, de motif d'absence ni de
 * coordonnee de paiement (contrainte de la spec RH, section 8) - convention
 * manuelle a respecter par chaque appelant, comme partout ailleurs dans ce
 * fichier (aucun garde-fou automatique au niveau du service).
 */
export async function logAuditPersonnel(
  fichePersonnelId: string,
  etape: string,
  statut: StatutExecution,
  detail?: string
): Promise<void> {
  await prisma.auditLog.create({
    data: { fichePersonnelId, etape, statut, detail },
  });
}
