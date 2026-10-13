import type { Request } from "express";
import { prisma } from "../lib/prisma";

/**
 * Journal des connexions (2026-10-13) - une ligne par connexion, pour
 * repondre a "qui s'est connecte, quand, pendant combien de temps". Aucune
 * table de session serveur n'existait avant (JWT stateless, cookie 7
 * jours, voir services/auth.ts) - ce journal est purement declaratif pour
 * l'audit, jamais consulte par middleware/requireAuth.ts pour valider une
 * requete.
 *
 * `derniereActiviteLe` est rafraichie au fil des requetes authentifiees
 * (toucherConnexion, appelee depuis requireAuth.ts) - throttle en memoire
 * pour eviter un UPDATE a chaque requete (un process Node seul, jamais
 * cluster - voir index.ts). Sert de point final de "duree de connexion"
 * quand aucune deconnexion explicite n'a eu lieu (fermeture du
 * navigateur/de l'app, crash...).
 */
const THROTTLE_MS = 3 * 60 * 1000;
const dernierToucherParUtilisateur = new Map<string, number>();

function extraireIp(req: Request): string | null {
  // req.ip respecte deja "trust proxy" (voir app.ts) - suffisant ici, pas
  // besoin de reparser X-Forwarded-For nous-memes.
  return req.ip || null;
}

export async function ouvrirConnexion(cabinetId: string, userId: string, req: Request): Promise<void> {
  try {
    await prisma.journalConnexion.create({
      data: {
        cabinetId,
        userId,
        adresseIp: extraireIp(req),
        userAgent: (req.headers["user-agent"] as string | undefined)?.slice(0, 500) || null,
      },
    });
    dernierToucherParUtilisateur.set(userId, Date.now());
  } catch (error) {
    console.error("[journal-connexion] échec d'ouverture :", error);
  }
}

/** Appelee a chaque requete authentifiee - jamais attendue par l'appelant
 * (fire-and-forget), un echec ici ne doit jamais ralentir ni faire echouer
 * la requete qu'elle accompagne. */
export function toucherConnexion(userId: string): void {
  const maintenant = Date.now();
  const dernier = dernierToucherParUtilisateur.get(userId) || 0;
  if (maintenant - dernier < THROTTLE_MS) return;
  dernierToucherParUtilisateur.set(userId, maintenant);

  prisma.journalConnexion
    .updateMany({
      where: { userId, deconnecteLe: null },
      data: { derniereActiviteLe: new Date() },
    })
    .catch((error) => console.error("[journal-connexion] échec de mise à jour d'activité :", error));
}

/** Ferme la connexion OUVERTE la plus recente de cet utilisateur (heuristique
 * raisonnable : en multi-appareils/onglets, ne ferme pas forcement la bonne
 * session precise, mais reste la meilleure approximation sans etat de
 * session serveur explicite). */
export async function fermerConnexion(userId: string): Promise<void> {
  try {
    const derniere = await prisma.journalConnexion.findFirst({
      where: { userId, deconnecteLe: null },
      orderBy: { connecteLe: "desc" },
    });
    if (!derniere) return;
    await prisma.journalConnexion.update({
      where: { id: derniere.id },
      data: { deconnecteLe: new Date(), derniereActiviteLe: new Date() },
    });
    dernierToucherParUtilisateur.delete(userId);
  } catch (error) {
    console.error("[journal-connexion] échec de fermeture :", error);
  }
}
