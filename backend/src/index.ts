import cron from "node-cron";
import { env } from "./config/env";
import { app } from "./app";
import { getLlmProvider } from "./services/llm";
import { runVeillePourTousLesCabinets } from "./services/veilleJuridique";

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
