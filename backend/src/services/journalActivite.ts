import { prisma } from "../lib/prisma";

/**
 * Journal d'activite (2026-10-13) : trace les actions metier du cabinet
 * (dossiers, clients, factures, comptes) - distinct du journal technique
 * AuditLog (pipeline de generation de documents) et du journal mobile
 * (MobileAuditLog) deja existants. Voir schema.prisma, JournalActivite,
 * pour la liste des valeurs de `type` en usage.
 *
 * Comme les autres journaux du projet (logAuditPersonnel, logMobileAudit) :
 * n'echoue jamais l'action qu'il journalise, et ne recoit jamais de contenu
 * chiffre au repos (coordonnees, montants) dans `cible`/`detail`.
 */
export async function enregistrerActivite(params: {
  cabinetId: string;
  userId?: string | null;
  type: string;
  cible?: string | null;
  detail?: string | null;
}): Promise<void> {
  try {
    await prisma.journalActivite.create({
      data: {
        cabinetId: params.cabinetId,
        userId: params.userId || null,
        type: params.type,
        cible: params.cible || null,
        detail: params.detail || null,
      },
    });
  } catch (error) {
    console.error(`[journal-activite] échec d'écriture (type=${params.type}) :`, error);
  }
}
