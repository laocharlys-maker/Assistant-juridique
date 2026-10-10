import { prisma } from "../../lib/prisma";

/**
 * Journal d'audit DEDIE aux evenements mobiles (Lot 10) - decision
 * explicite du 2026-10-09 (voir docs/lot10/01-protocole.md) : le modele
 * AuditLog existant n'a ni cabinetId propre ni notion d'evenement hors
 * Action/CourrierEntrant/CourrierSortant, donc jamais etendu pour ce cas.
 * Jamais de contenu metier dans `detail` (conforme a la contrainte de
 * confidentialite du plan) - uniquement des identifiants et des messages
 * techniques courts.
 */
export async function logMobileAudit(
  cabinetId: string,
  etape: string,
  statut: "succes" | "erreur",
  detail?: string,
  deviceId?: string
): Promise<void> {
  try {
    await prisma.mobileAuditLog.create({
      data: { cabinetId, deviceId, etape, statut, detail },
    });
  } catch (error) {
    // Un journal d'audit qui echoue ne doit jamais faire echouer l'operation
    // qu'il journalise (meme principe que logAuditStep existant, voir
    // services/audit.ts).
    console.error(`[mobile-audit] echec d'ecriture (etape=${etape}) :`, error);
  }
}
