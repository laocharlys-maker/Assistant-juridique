// Charge .env avant tout (y compris avant de lire DATABASE_MODE ci-dessous).
// La validation stricte des variables d'environnement (config/env.ts) est
// importee dynamiquement plus bas, une fois DATABASE_URL determinee - voir
// le commentaire au-dessus de main().
import "dotenv/config";
import cron from "node-cron";

/**
 * Point d'entree. Structure en fonction async (plutot que des imports
 * statiques executes au chargement du module, comme avant le Lot 2) car en
 * mode portable, DATABASE_URL n'existe pas encore dans process.env au
 * demarrage : elle est calculee dynamiquement par bootstrapPortableDatabase()
 * (identifiants generes/charges, cluster Postgres local demarre) AVANT que
 * quoi que ce soit n'importe ./config/env (qui valide process.env.DATABASE_URL
 * des le chargement du module) ou ./app (qui instancie PrismaClient via
 * ./lib/prisma des le chargement du module, transitivement). D'ou les
 * `await import(...)` ci-dessous plutot que des `import` en tete de fichier.
 *
 * En mode "externe" (VPS actuel), DATABASE_URL provient de .env comme avant
 * le Lot 2 - comportement inchange, bootstrapPortableDatabase() n'est meme
 * pas importe.
 */
async function main() {
  const databaseMode = (process.env.DATABASE_MODE || "externe").toLowerCase();

  let stopPortableDatabase: (() => Promise<void>) | null = null;

  if (databaseMode === "portable") {
    console.log("[demarrage] DATABASE_MODE=portable : initialisation/demarrage du cluster Postgres local...");
    const { bootstrapPortableDatabase } = await import("./database/bootstrapPortableDatabase");
    const portableDb = await bootstrapPortableDatabase();
    process.env.DATABASE_URL = portableDb.databaseUrl;
    stopPortableDatabase = portableDb.stop;
    console.log(`[demarrage] Postgres portable pret sur ${portableDb.host}:${portableDb.port}/${portableDb.database}.`);
  } else {
    console.log(`[demarrage] DATABASE_MODE=${databaseMode} : DATABASE_URL fournie via .env, inchangee (mode Lot 1).`);
  }

  // Tout ce qui suit (chargement d'./app et de ses dependances, ecoute HTTP)
  // est enveloppe dans un try/catch : si Postgres portable a deja demarre
  // (stopPortableDatabase non nul) et qu'une etape ulterieure echoue - ex:
  // une dependance manquante lors du chargement d'un service -, il ne doit
  // JAMAIS rester orphelin en arriere-plan. Constate concretement pendant
  // le developpement de ce lot : sans ce filet, un echec de chargement
  // laissait le process postgres.exe (et ses processus auxiliaires) tourner
  // indefiniment malgre l'arret du backend.
  try {
    const [
      { env },
      { app },
      { prisma },
      { getLlmProvider },
      { runVeillePourTousLesCabinets },
      { runRetentionJobs },
      { runRoleSemaineRecapPourTousLesCabinets },
    ] = await Promise.all([
      import("./config/env"),
      import("./app"),
      import("./lib/prisma"),
      import("./services/llm"),
      import("./services/veilleJuridique"),
      import("./services/retention"),
      import("./services/roleSemaineRecap"),
    ]);

    const server = app.listen(env.PORT, env.HOST, () => {
      console.log(`Aurore backend demarre sur ${env.HOST}:${env.PORT} (${env.NODE_ENV})`);
    });

    if (databaseMode === "portable") {
      const { schedulePortableBackups } = await import("./database/backupScheduler");
      schedulePortableBackups();
    }

    // Arret propre : ferme le serveur HTTP, deconnecte Prisma, puis arrete
    // Postgres portable (si actif) - dans cet ordre, pour ne jamais couper
    // une requete/transaction en cours ni arreter Postgres avant que Prisma
    // ait fini de l'utiliser. Declenche par un signal OS (Ctrl+C en ligne de
    // commande) ou, lorsque ce process tourne comme sidecar Tauri, par
    // l'ecriture de "shutdown" sur son stdin (voir src-tauri/src/main.rs) -
    // Windows ne propageant pas SIGTERM de facon fiable a un process enfant.
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
        if (stopPortableDatabase) {
          try {
            await stopPortableDatabase();
          } catch (error) {
            console.error("Erreur lors de l'arret de Postgres portable :", error);
          }
        }
        process.exit(0);
      });
      // Filet de securite si des connexions restent ouvertes (keep-alive) et
      // empechent server.close() d'aboutir. Plus genereux qu'au Lot 1 (5s)
      // car l'arret propre de Postgres (pg_ctl stop -m fast) prend lui-meme
      // quelques secondes.
      setTimeout(() => process.exit(0), 15000).unref();
    }

    process.on("SIGINT", () => void gracefulShutdown("SIGINT"));
    process.on("SIGTERM", () => void gracefulShutdown("SIGTERM"));
    process.on("SIGBREAK", () => void gracefulShutdown("SIGBREAK"));

    if (process.stdin.isTTY === undefined) {
      // stdin est un pipe (cas du sidecar Tauri) : on l'ecoute pour la
      // commande d'arret. En TTY interactif, Ctrl+C declenche deja SIGINT
      // ci-dessus.
      process.stdin.on("data", (chunk) => {
        if (chunk.toString("utf8").trim().toLowerCase() === "shutdown") {
          void gracefulShutdown("stdin:shutdown");
        }
      });
      process.stdin.resume();
    }

    // Veille juridique hebdomadaire : chaque lundi a 7h (heure du Benin),
    // pour tous les cabinets ayant active la veille dans leurs parametres.
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
    // commence 10 jours plus tard (le greffe communique le role dans ce
    // delai) - le cabinet a ainsi la semaine intermediaire pour se preparer.
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
    // purge des vieux logs d'audit, suppression des fiches recherches
    // inactives, archivage des dossiers clotures depuis assez longtemps. Ne
    // supprime jamais un dossier client reel.
    cron.schedule(
      "0 6 * * 1",
      () => {
        runRetentionJobs().catch((error) => {
          console.error("Erreur lors de l'execution des jobs de retention :", error);
        });
      },
      { timezone: "Africa/Porto-Novo" }
    );
  } catch (error) {
    if (stopPortableDatabase) {
      console.error("Echec du demarrage apres l'ouverture de Postgres portable - arret de Postgres avant de quitter...");
      try {
        await stopPortableDatabase();
      } catch (stopError) {
        console.error("Erreur lors de l'arret de Postgres portable pendant la gestion de l'echec de demarrage :", stopError);
      }
    }
    throw error;
  }
}

main().catch((error) => {
  console.error("Echec du demarrage du backend :", error);
  process.exit(1);
});
