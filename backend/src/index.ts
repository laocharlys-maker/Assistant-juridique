import cron from "node-cron";
import { env } from "./config/env";
import { app } from "./app";
import { getLlmProvider } from "./services/llm";
import { runVeillePourTousLesCabinets } from "./services/veilleJuridique";
import { runRetentionJobs } from "./services/retention";

app.listen(env.PORT, () => {
  console.log(`Aurore backend demarre sur le port ${env.PORT} (${env.NODE_ENV})`);
});

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
