import { prisma } from "../lib/prisma";

// Identite d'expedition a joindre a tout email envoye au nom d'un cabinet :
// le nom du cabinet (affiche comme expediteur) et l'adresse de reponse
// (Reply-To) - repli automatique sur l'email du titulaire si le cabinet n'a
// pas defini d'adresse de contact dediee.
export async function resolveCabinetEmailIdentite(
  cabinetId: string
): Promise<{ cabinetNom: string; replyToEmail: string | null }> {
  const cabinet = await prisma.cabinet.findUnique({
    where: { id: cabinetId },
    select: { nom: true, emailContact: true },
  });
  if (!cabinet) {
    return { cabinetNom: "", replyToEmail: null };
  }
  if (cabinet.emailContact) {
    return { cabinetNom: cabinet.nom, replyToEmail: cabinet.emailContact };
  }
  const titulaire = await prisma.user.findFirst({
    where: { cabinetId, role: "titulaire" },
    select: { email: true },
  });
  return { cabinetNom: cabinet.nom, replyToEmail: titulaire?.email ?? null };
}
