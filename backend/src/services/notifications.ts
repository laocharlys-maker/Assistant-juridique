import { prisma } from "../lib/prisma";

interface NotificationBase {
  cabinetId: string;
  type: string;
  titre: string;
  message?: string | null;
  lienUrl?: string | null;
  creeParId?: string | null;
}

/**
 * Centre de notifications internes (bannette in-app, pas email) - voir
 * schema.prisma, model Notification. Ne cree jamais une notification vers
 * soi-meme (ex: un avocat qui se corrige sur son propre document).
 */
export async function creerNotification(params: NotificationBase & { destinataireId: string }): Promise<void> {
  if (params.destinataireId === params.creeParId) return;
  await prisma.notification.create({
    data: {
      cabinetId: params.cabinetId,
      destinataireId: params.destinataireId,
      type: params.type,
      titre: params.titre,
      message: params.message ?? null,
      lienUrl: params.lienUrl ?? null,
      creeParId: params.creeParId ?? null,
    },
  });
}

/** Meme notification envoyee a plusieurs destinataires distincts (ex:
 * plusieurs collaborateurs affectes au meme courrier) - chacun recoit sa
 * propre ligne dans sa propre bannette. */
export async function creerNotificationsMultiples(destinataireIds: string[], base: NotificationBase): Promise<void> {
  const distincts = [...new Set(destinataireIds)].filter((id) => id !== base.creeParId);
  if (distincts.length === 0) return;
  await prisma.notification.createMany({
    data: distincts.map((destinataireId) => ({
      cabinetId: base.cabinetId,
      destinataireId,
      type: base.type,
      titre: base.titre,
      message: base.message ?? null,
      lienUrl: base.lienUrl ?? null,
      creeParId: base.creeParId ?? null,
    })),
  });
}
