import { prisma } from "../lib/prisma";
import { AuthTokenPayload } from "./auth";

/**
 * Renvoie la liste des identifiants d'avocats dont les dossiers sont
 * visibles par cet utilisateur (scope "mine") :
 * - un titulaire (admin) ou un avocat voit ses propres dossiers, ainsi que
 *   ceux crees par les collaborateurs dont il est le responsable direct
 *   (User.responsableId) - un evenement/dossier/document cree par son
 *   collaborateur doit rester visible pour lui, symetrique de l'acces dont
 *   beneficie deja ce collaborateur sur les dossiers de son responsable
 *   ci-dessous.
 * - un collaborateur voit les dossiers de l'avocat dont il depend
 *   directement (responsable), plus ceux des avocats lui ayant accorde
 *   un acces supplementaire, plus les siens propres le cas echeant ;
 *   ou, si l'admin lui a accorde l'acces "tous les dossiers", ceux de
 *   tous les avocats du cabinet.
 */
export async function getAccessibleAvocatIds(auth: AuthTokenPayload): Promise<string[]> {
  if (auth.role === "titulaire" || auth.role === "avocat") {
    const collaborateurs = await prisma.user.findMany({
      where: { cabinetId: auth.cabinetId, responsableId: auth.userId },
      select: { id: true },
    });
    return [auth.userId, ...collaborateurs.map((c) => c.id)];
  }

  const user = await prisma.user.findUnique({
    where: { id: auth.userId },
    select: { responsableId: true, accesTousDossiers: true },
  });

  if (user?.accesTousDossiers) {
    const avocats = await prisma.user.findMany({
      where: { cabinetId: auth.cabinetId, role: { in: ["titulaire", "avocat"] } },
      select: { id: true },
    });
    return avocats.map((a) => a.id);
  }

  const grants = await prisma.accesSupplementaire.findMany({
    where: { collaborateurId: auth.userId },
    select: { avocatId: true },
  });

  const ids = new Set<string>([auth.userId]);
  if (user?.responsableId) ids.add(user.responsableId);
  grants.forEach((g) => ids.add(g.avocatId));

  return Array.from(ids);
}
