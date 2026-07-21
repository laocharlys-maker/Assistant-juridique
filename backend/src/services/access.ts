import { prisma } from "../lib/prisma";
import { AuthTokenPayload } from "./auth";

/**
 * Renvoie la liste des identifiants d'avocats dont les dossiers sont
 * visibles par cet utilisateur :
 * - un titulaire ne voit (en scope "mine") que ses propres dossiers
 * - un collaborateur voit les dossiers de l'avocat dont il depend
 *   directement (responsable), plus ceux des avocats lui ayant accorde
 *   un acces supplementaire, plus les siens propres le cas echeant.
 */
export async function getAccessibleAvocatIds(auth: AuthTokenPayload): Promise<string[]> {
  if (auth.role === "titulaire") {
    return [auth.userId];
  }

  const user = await prisma.user.findUnique({
    where: { id: auth.userId },
    select: { responsableId: true },
  });

  const grants = await prisma.accesSupplementaire.findMany({
    where: { collaborateurId: auth.userId },
    select: { avocatId: true },
  });

  const ids = new Set<string>([auth.userId]);
  if (user?.responsableId) ids.add(user.responsableId);
  grants.forEach((g) => ids.add(g.avocatId));

  return Array.from(ids);
}
