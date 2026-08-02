import cron from "node-cron";
import { env } from "./config/env";
import { app } from "./app";
import { prisma } from "./lib/prisma";
import { getLlmProvider } from "./services/llm";
import { runVeillePourTousLesCabinets } from "./services/veilleJuridique";
import { runRetentionJobs } from "./services/retention";
import { runRoleSemaineRecapPourTousLesCabinets } from "./services/roleSemaineRecap";

const server = app.listen(env.PORT, () => {
  console.log(`Aurore backend demarre sur le port ${env.PORT} (${env.NODE_ENV})`);
});

// Arret propre (Lot 1) : ferme le serveur HTTP puis deconnecte Prisma avant
// de quitter. Declenche par un signal OS (Ctrl+C en ligne de commande) ou,
// lorsque ce process tourne comme sidecar Tauri, par l'ecriture de
// "shutdown" sur son stdin (voir src-tauri/src/main.rs) - Windows ne
// propageant pas SIGTERM de facon fiable a un process enfant.
let shuttingDown = false;
async function gracefulShutdown(reason: string) {
  if (shuttingDown) return;
  shuttingDown = true;
  console.log(`Arret du backend demande (${reason})...`);
  server.close(async (closeErr) => {
    if (closeErr) {
      console.error("Erreur lors de la fermeture du serveur HTTP :", closeErr);
    }
    try {
      await prisma.$disconnect();
    } catch (error) {
      console.error("Erreur lors de la deconnexion Prisma :", error);
    }
    process.exit(0);
  });
  // Filet de securite si des connexions restent ouvertes (keep-alive) et
  // empechent server.close() d'aboutir.
  setTimeout(() => process.exit(0), 5000).unref();
}

process.on("SIGINT", () => void gracefulShutdown("SIGINT"));
process.on("SIGTERM", () => void gracefulShutdown("SIGTERM"));
process.on("SIGBREAK", () => void gracefulShutdown("SIGBREAK"));

if (process.stdin.isTTY === undefined) {
  // stdin est un pipe (cas du sidecar Tauri) : on l'ecoute pour la commande
  // d'arret. En TTY interactif, Ctrl+C declenche deja SIGINT ci-dessus.
  process.stdin.on("data", (chunk) => {
    if (chunk.toString("utf8").trim().toLowerCase() === "shutdown") {
      void gracefulShutdown("stdin:shutdown");
    }
  });
  process.stdin.resume();
}

// Veille juridique hebdomadaire : chaque lundi a 7h (heure du Benin), pour
// tous les cabinets ayant active la veille dans leurs parametres.
cron.schedule(
  "0 7 * * 1",
  () => {
    runVeillePourTousLesCabinets(getLlmProvider()).catch((error) => {
      console.error("Erreur lors de l'execution de la veille juridique hebdomadaire :", error);
    });
  },
  { timezone: "Africa/Porto-Novo" }
);

// Recapitulatif du role de la semaine : chaque vendredi a 8h (heure du
// Benin), envoi par mail des audiences deja saisies pour la semaine qui
// commence 10 jours plus tard (le greffe communique le role dans ce delai) -
// le cabinet a ainsi la semaine intermediaire pour se preparer.
cron.schedule(
  "0 8 * * 5",
  () => {
    runRoleSemaineRecapPourTousLesCabinets().catch((error) => {
      console.error("Erreur lors de l'envoi du recapitulatif du role de la semaine :", error);
    });
  },
  { timezone: "Africa/Porto-Novo" }
);

// Retention des donnees : chaque lundi a 6h (avant la veille juridique),
// purge des vieux logs d'audit, suppression des fiches recherches inactives,
// archivage des dossiers clotures depuis assez longtemps. Ne supprime
// jamais un dossier client reel.
cron.schedule(
  "0 6 * * 1",
  () => {
    runRetentionJobs().catch((error) => {
      console.error("Erreur lors de l'execution des jobs de retention :", error);
    });
  },
  { timezone: "Africa/Porto-Novo" }
);
