import "express-async-errors";
import type { Server } from "node:http";
import express from "express";
import { prisma } from "./lib/prisma";
import { mobileSyncRouter } from "./routes/mobileSync";
import { mobileApiLimiter } from "./middleware/rateLimit";
import { requireLicence } from "./middleware/requireLicence";
import { errorHandler } from "./middleware/errorHandler";

/**
 * Deuxieme instance Express, ISOLEE de l'app principale (backend/src/app.ts),
 * qui ne monte QUE le routeur mobile (/api/m/*) - voir
 * docs/lot10/01-protocole.md section 6 (Objectif A du Prompt 1).
 *
 * Demarree UNE SEULE FOIS au lancement du backend, si
 * Cabinet.mobileSyncActif est deja vrai a cet instant - un changement de ce
 * reglage en cours d'execution necessite un redemarrage d'Aurore pour
 * prendre effet, exactement comme le changement de mode de deploiement
 * (voir routes/networkInfo.ts, "redemarrageRequis: true") : pas une
 * limitation nouvelle, un choix deja accepte dans ce projet pour ce genre
 * de reglage reseau.
 *
 * Mode portable uniquement (voir index.ts) : en mode "externe" (VPS,
 * potentiellement multi-cabinets), cette fonctionnalite n'a pas de sens
 * tel que concu (un seul cabinet par serveur mobile, un seul port) - hors
 * perimetre de ce Lot.
 */

let serveurMobile: Server | null = null;

export async function demarrerServeurMobileSiActif(): Promise<void> {
  // Mode portable = un seul cabinet par installation (meme hypothese deja
  // utilisee par security/licenceManager.ts, runPhoneHomeCheck).
  const cabinet = await prisma.cabinet.findFirst({
    select: { mobileSyncActif: true, mobileSyncInterface: true, mobileSyncPort: true },
  });
  if (!cabinet?.mobileSyncActif) {
    console.log("[mobile-sync] desactive - aucun port supplementaire ouvert.");
    return;
  }

  const app = express();
  app.use(express.json({ limit: "30mb" }));
  app.use(mobileApiLimiter);
  // Meme garde que l'app principale (requireLicence ne filtre que les
  // chemins /api/*, deja le cas de toutes les routes de mobileSyncRouter) -
  // decision explicite du 2026-10-09 : la synchronisation mobile depend
  // uniquement de la licence du cabinet, jamais d'un module payant separe.
  app.use(requireLicence);
  app.use(mobileSyncRouter);
  app.use(errorHandler);

  // Jamais 0.0.0.0 par defaut si aucune interface n'est choisie - meme
  // principe de prudence que le mode reseau du Lot 6, qui lui bind
  // explicitement 0.0.0.0 (document/assume) mais seulement apres un choix
  // explicite de l'utilisateur. Ici, une interface non choisie retombe sur
  // "0.0.0.0" tout de meme car le telephone doit pouvoir joindre le PC
  // depuis n'importe quelle interface locale active (le pare-feu, lui,
  // reste limite au profil reseau PRIVE - voir installer/firewall-rule.ps1) -
  // difference assumee avec le serveur principal (jamais mobile par
  // defaut) qui protege des donnees nettement plus larges que la seule
  // synchronisation mobile.
  const hote = cabinet.mobileSyncInterface || "0.0.0.0";
  await new Promise<void>((resolve, reject) => {
    const serveur = app.listen(cabinet.mobileSyncPort, hote, () => {
      console.log(`[mobile-sync] serveur demarre sur ${hote}:${cabinet.mobileSyncPort}.`);
      resolve();
    });
    serveur.on("error", (error) => {
      console.error(`[mobile-sync] echec de demarrage sur ${hote}:${cabinet.mobileSyncPort} :`, error);
      reject(error);
    });
    serveurMobile = serveur;
  }).catch((error) => {
    // Non fatal pour le reste de l'app - meme principe que les autres
    // echecs de configuration non bloquants de ce projet (jamais tout le
    // backend qui s'arrete pour un port deja occupe sur une fonctionnalite
    // optionnelle).
    console.error("[mobile-sync] le serveur mobile n'a pas pu demarrer, le reste d'Aurore continue normalement :", error);
    serveurMobile = null;
  });
}

export function arreterServeurMobile(): Promise<void> {
  return new Promise((resolve) => {
    if (!serveurMobile) {
      resolve();
      return;
    }
    serveurMobile.close(() => resolve());
    serveurMobile = null;
  });
}
