import { prisma } from "../lib/prisma";
import { formatDateLongue } from "../utils/dateFormat";
import { enqueuerSyncEvenement, enqueuerSuppressionEvenement } from "./calendrierSync/syncQueue";

/**
 * Lot 12a - synchronisation douce RoleAudience/DelaiCalcul -> Evenement
 * (calendrier unifie). Principe : hooks ADDITIFS, appeles APRES le point de
 * creation/modification/suppression existant, jamais a l'interieur de sa
 * logique. Chaque fonction avale ses propres erreurs (log, jamais de rejet
 * propage) - un echec de synchronisation ne doit JAMAIS faire echouer
 * l'operation metier d'origine (creation d'un role d'audience, calcul d'un
 * delai). Voir README-LOT12A.md.
 *
 * Ne recalcule jamais rien : lit uniquement le resultat deja calcule
 * (RoleAudience.dateAudience, DelaiCalcul.dateLimite) - aucune logique de
 * calcul de delai dupliquee ici.
 */

export async function syncEvenementDepuisRoleAudience(roleAudienceId: string): Promise<void> {
  try {
    const roleAudience = await prisma.roleAudience.findUnique({ where: { id: roleAudienceId } });
    if (!roleAudience) return;

    const lieu = [roleAudience.juridiction, roleAudience.chambre].filter(Boolean).join(" — ") || null;
    const description =
      [
        roleAudience.objetProcedure && `Objet : ${roleAudience.objetProcedure}`,
        roleAudience.dernierMotif && `Dernier motif : ${roleAudience.dernierMotif}`,
      ]
        .filter(Boolean)
        .join("\n") || null;

    const data = {
      cabinetId: roleAudience.cabinetId,
      dossierId: roleAudience.dossierId,
      type: "audience" as const,
      source: "role_audience" as const,
      titre: `Audience — ${roleAudience.parties}`,
      description,
      dateDebut: roleAudience.dateAudience,
      lieu,
      createdById: roleAudience.createdBy,
      roleAudienceId: roleAudience.id,
    };

    const evenement = await prisma.evenement.upsert({
      where: { roleAudienceId: roleAudience.id },
      create: data,
      update: data,
    });

    // Lot 12b : met en file la synchro externe (jamais bloquant, voir
    // syncQueue.ts) - meme point d'ancrage que la creation manuelle.
    await enqueuerSyncEvenement(evenement.id);
  } catch (error) {
    console.error(
      `[evenement-sync] echec de synchronisation depuis RoleAudience ${roleAudienceId} :`,
      error instanceof Error ? error.message : error
    );
  }
}

export async function supprimerEvenementDepuisRoleAudience(roleAudienceId: string): Promise<void> {
  try {
    const evenement = await prisma.evenement.findUnique({ where: { roleAudienceId }, select: { id: true } });
    if (evenement) {
      // Lot 12b : met en file la suppression externe avant de supprimer
      // l'Evenement Aurore (voir syncQueue.ts).
      await enqueuerSuppressionEvenement(evenement.id);
    }
    await prisma.evenement.deleteMany({ where: { roleAudienceId } });
  } catch (error) {
    console.error(
      `[evenement-sync] echec de suppression de l'evenement lie a RoleAudience ${roleAudienceId} :`,
      error instanceof Error ? error.message : error
    );
  }
}

export async function syncEvenementDepuisDelaiCalcul(delaiCalculId: string): Promise<void> {
  try {
    const delaiCalcul = await prisma.delaiCalcul.findUnique({
      where: { id: delaiCalculId },
      include: { delaiType: true, createdBy: { select: { cabinetId: true } } },
    });
    if (!delaiCalcul) return;

    const data = {
      cabinetId: delaiCalcul.createdBy.cabinetId,
      dossierId: delaiCalcul.dossierId,
      type: "echeance_procedure" as const,
      source: "delai_calcule" as const,
      titre: `Échéance — ${delaiCalcul.delaiType.nom}`,
      description: `${delaiCalcul.delaiType.texteReference} — départ le ${formatDateLongue(delaiCalcul.dateDepart)}`,
      dateDebut: delaiCalcul.dateLimite,
      touteLaJournee: true,
      createdById: delaiCalcul.createdById,
      delaiCalculId: delaiCalcul.id,
    };

    const evenement = await prisma.evenement.upsert({
      where: { delaiCalculId: delaiCalcul.id },
      create: data,
      update: data,
    });

    // Lot 12b : met en file la synchro externe (jamais bloquant, voir
    // syncQueue.ts) - meme point d'ancrage que la creation manuelle.
    await enqueuerSyncEvenement(evenement.id);
  } catch (error) {
    console.error(
      `[evenement-sync] echec de synchronisation depuis DelaiCalcul ${delaiCalculId} :`,
      error instanceof Error ? error.message : error
    );
  }
}

export async function supprimerEvenementDepuisDelaiCalcul(delaiCalculId: string): Promise<void> {
  try {
    const evenement = await prisma.evenement.findUnique({ where: { delaiCalculId }, select: { id: true } });
    if (evenement) {
      // Lot 12b : met en file la suppression externe avant de supprimer
      // l'Evenement Aurore (voir syncQueue.ts).
      await enqueuerSuppressionEvenement(evenement.id);
    }
    await prisma.evenement.deleteMany({ where: { delaiCalculId } });
  } catch (error) {
    console.error(
      `[evenement-sync] echec de suppression de l'evenement lie a DelaiCalcul ${delaiCalculId} :`,
      error instanceof Error ? error.message : error
    );
  }
}
