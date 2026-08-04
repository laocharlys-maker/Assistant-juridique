// Charge .env avant tout (y compris avant de lire DATABASE_MODE ci-dessous).
// La validation stricte des variables d'environnement (config/env.ts) est
// importee dynamiquement plus bas, une fois DATABASE_URL determinee - voir
// le commentaire au-dessus de main().
import "dotenv/config";
import cron from "node-cron";
import {
  BUNDLED_GEMINI_API_KEY,
  BUNDLED_GROQ_API_KEY,
  BUNDLED_TAVILY_API_KEY,
  BUNDLED_SMTP_HOST,
  BUNDLED_SMTP_USER,
  BUNDLED_SMTP_PASSWORD,
  BUNDLED_SMTP_FROM_EMAIL,
} from "./config/bundledExternalServiceKeys";
import { MissingConfigurationError } from "./lib/configurationError";

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
 * En mode "externe"/"reseau" (VPS actuel, ou serveur LAN du Lot 6),
 * DATABASE_URL provient de .env comme avant le Lot 2 - comportement
 * inchange, bootstrapPortableDatabase() n'est meme pas importe.
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

    // Lot 8 : l'installeur ne peut pas livrer de .env contenant un
    // SESSION_SECRET (secret qui serait alors partage par toutes les
    // installations, jamais commis nulle part) - genere/recharge un secret
    // propre a ce poste si absent, AVANT que config/env ne le valide
    // ci-dessous. Mode "externe" (VPS) inchange : SESSION_SECRET y reste
    // fourni par .env comme avant ce lot.
    if (!process.env.SESSION_SECRET) {
      const { loadOrCreateSessionSecret } = await import("./security/sessionSecretStore");
      process.env.SESSION_SECRET = loadOrCreateSessionSecret();
    }

    // Invalide toute session existante a CHAQUE demarrage de l'app desktop -
    // voir resetServerSessionEpoch() (services/auth.ts) pour le detail et le
    // raisonnement de securite. Sans effet en mode VPS/externe (jamais
    // appelee dans cette branche).
    {
      const { resetServerSessionEpoch } = await import("./services/auth");
      resetServerSessionEpoch();
    }

    // LLM_PROVIDER=groq (decision AzoMedIA, deja utilise sur le SaaS
    // existant) : sans ce forçage, rien ne le positionnait jamais dans
    // l'environnement du binaire empaquete (aucun .env livre - voir plus
    // bas), donc le defaut Zod ("gemini", config/env.ts) s'appliquait
    // silencieusement a la place - cause racine reelle du crash "Mise en
    // demeure" (et de tout autre type d'acte) : getLlmProvider() tentait
    // Gemini, sans cle, dans un chemin non protege par un try/catch local
    // (voir routes/webActions.ts). Pas un secret (juste un choix de
    // fournisseur) : positionne directement, sans passer par le mecanisme
    // GitHub Secrets des identifiants ci-dessous.
    if (!process.env.LLM_PROVIDER) {
      process.env.LLM_PROVIDER = "groq";
    }

    // Identifiants de services externes partages AzoMedIA (LLM Groq/Gemini,
    // recherche web Tavily, envoi d'email SMTP/Brevo - decision Option A,
    // voir README-LOT8.md et config/bundledExternalServiceKeys.ts) : meme
    // principe que SESSION_SECRET juste au-dessus - ne comble QUE ce qu'un
    // .env n'a pas deja fourni, jamais un ecrasement. En pratique ce fichier
    // reste un placeholder vide (undefined) partout sauf dans le binaire
    // produit par le workflow CI, qui le reecrit juste avant le build a
    // partir des GitHub Secrets - voir
    // .github/workflows/build-windows-installer.yml. Volontairement PAS
    // pour N8N_WEBHOOK_BASE_URL/PUBLIC_BASE_URL (n8n) : hors perimetre du
    // Lot 8, confirme - la degradation silencieuse existante reste voulue.
    if (!process.env.GEMINI_API_KEY && BUNDLED_GEMINI_API_KEY) {
      process.env.GEMINI_API_KEY = BUNDLED_GEMINI_API_KEY;
    }
    if (!process.env.GROQ_API_KEY && BUNDLED_GROQ_API_KEY) {
      process.env.GROQ_API_KEY = BUNDLED_GROQ_API_KEY;
    }
    if (!process.env.TAVILY_API_KEY && BUNDLED_TAVILY_API_KEY) {
      process.env.TAVILY_API_KEY = BUNDLED_TAVILY_API_KEY;
    }
    if (!process.env.SMTP_HOST && BUNDLED_SMTP_HOST) {
      process.env.SMTP_HOST = BUNDLED_SMTP_HOST;
    }
    if (!process.env.SMTP_USER && BUNDLED_SMTP_USER) {
      process.env.SMTP_USER = BUNDLED_SMTP_USER;
    }
    if (!process.env.SMTP_PASSWORD && BUNDLED_SMTP_PASSWORD) {
      process.env.SMTP_PASSWORD = BUNDLED_SMTP_PASSWORD;
    }
    if (!process.env.SMTP_FROM_EMAIL && BUNDLED_SMTP_FROM_EMAIL) {
      process.env.SMTP_FROM_EMAIL = BUNDLED_SMTP_FROM_EMAIL;
    }
  } else {
    console.log(`[demarrage] DATABASE_MODE=${databaseMode} : DATABASE_URL fournie via .env, inchangee (mode Lot 1).`);
  }

  // Filet de securite final : toute exception non rattrapee ailleurs (ex:
  // un futur appel oublie sans try/catch dans une route) ne doit JAMAIS
  // laisser Postgres portable tourner en arriere-plan une fois le process
  // Node mort - constate concretement : pg_ctl start demarre postgres.exe
  // comme process DETACHE du cycle de vie de Node (necessaire pour que les
  // processus auxiliaires - checkpointer, bgwriter... - survivent, voir
  // postgresPortable.ts), donc un crash brutal ici le laisse actif,
  // bloquant tout redemarrage suivant ("another postmaster may be running")
  // jusqu'a l'arrivee du contournement ajoute dans postgresPortable.ts
  // (isAlreadyReachable) - mieux vaut cependant ne jamais en arriver la.
  // process.exit() y met volontairement fin depuis ici plutot que de
  // laisser Node crasher tout seul (qui aurait le meme effet sur Postgres,
  // en pire : aucun log clair, aucune tentative d'arret propre).
  let uncaughtHandled = false;
  function handleFatalError(kind: string, error: unknown): void {
    if (uncaughtHandled) return; // Evite une boucle si l'arret lui-meme echoue bruyamment.
    // Une MissingConfigurationError (cle API absente - voir
    // lib/configurationError.ts) est une degradation attendue et deja
    // documentee ailleurs dans le code (jurisprudence, embeddings, envoi
    // d'email...), jamais une panne reelle : si elle arrive malgre tout
    // jusqu'ici (un futur appel oublie sans le wrapper local, voir
    // getLlmProviderSafe dans routes/webActions.ts), le bon geste est de
    // journaliser et laisser le process VIVANT - la requete en cours reste
    // sans reponse (le client verra un echec reseau ponctuel), mais arreter
    // TOUTE l'application pour une simple fonctionnalite non configuree
    // serait disproportionne. Reserve l'arret complet (avec nettoyage
    // Postgres) aux erreurs vraiment inattendues.
    if (error instanceof MissingConfigurationError) {
      console.error(
        `[fatal] ${kind} non rattrapee mais reconnue comme configuration manquante - process conserve en vie :`,
        error.message
      );
      return;
    }
    uncaughtHandled = true;
    console.error(`[fatal] ${kind} non rattrapee - arret du process apres nettoyage :`, error);
    const cleanup = stopPortableDatabase ? stopPortableDatabase() : Promise.resolve();
    // Timeout de securite : ne jamais rester bloque indefiniment sur l'arret
    // de Postgres si quelque chose tourne deja mal - un process qui ne quitte
    // jamais est pire qu'un arret de Postgres non confirme (voir
    // stopPortablePostgres, qui journalise deja son propre echec).
    Promise.race([cleanup.catch(() => undefined), new Promise((resolve) => setTimeout(resolve, 10000))]).finally(
      () => process.exit(1)
    );
  }
  process.on("uncaughtException", (error) => handleFatalError("exception", error));
  process.on("unhandledRejection", (error) => handleFatalError("rejet de promesse", error));

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
      { runPhoneHomeCheck },
    ] = await Promise.all([
      import("./config/env"),
      import("./app"),
      import("./lib/prisma"),
      import("./services/llm"),
      import("./services/veilleJuridique"),
      import("./services/retention"),
      import("./services/roleSemaineRecap"),
      import("./security/licenceManager"),
    ]);

    // Lot 6 : en mode desktop (DATABASE_MODE=portable, sidecar Tauri ou
    // service NSSM), le binding reseau est decide par la config locale
    // "standalone"/"reseau" (config/deploymentMode.ts), PAS par env.HOST -
    // celui-ci reste a 127.0.0.1 par defaut/force par Tauri aujourd'hui,
    // mais ce serait fragile de s'y fier pour une decision de securite
    // ("bind sur toutes les interfaces ou non") : on la recalcule
    // explicitement ici, avec un repli sur "standalone" (127.0.0.1)
    // systematique si la config est absente/corrompue - jamais 0.0.0.0 par
    // defaut. Le mode "externe" (VPS actuel, Traefik devant) est
    // entierement inchange : env.HOST comme avant ce lot.
    let server: import("node:http").Server | import("node:https").Server;
    let stopMdns: (() => void) | null = null;

    if (databaseMode === "portable") {
      const { effectiveDeploymentMode } = await import("./config/deploymentMode");
      const deploymentMode = effectiveDeploymentMode();

      if (deploymentMode === "reseau") {
        console.log(
          "[demarrage] mode serveur reseau (Lot 6) : bind 0.0.0.0, HTTPS avec certificat local auto-signe."
        );
        const [{ default: https }, { ensureLocalTlsCertificate }, { advertiseAuroreLocal }] = await Promise.all([
          import("node:https"),
          import("./security/localTlsCertificate"),
          import("./network/mdnsAdvertise"),
        ]);
        const tlsCertificate = await ensureLocalTlsCertificate();
        server = https.createServer({ key: tlsCertificate.key, cert: tlsCertificate.cert }, app);
        server.listen(env.PORT, "0.0.0.0", () => {
          console.log(`Aurore backend demarre en mode reseau sur 0.0.0.0:${env.PORT} (HTTPS, ${env.NODE_ENV}).`);
        });
        const mdns = advertiseAuroreLocal(env.PORT);
        stopMdns = mdns?.stop ?? null;
      } else {
        server = app.listen(env.PORT, "127.0.0.1", () => {
          console.log(`Aurore backend demarre sur 127.0.0.1:${env.PORT} (${env.NODE_ENV}) - poste unique.`);
        });
      }
    } else {
      server = app.listen(env.PORT, env.HOST, () => {
        console.log(`Aurore backend demarre sur ${env.HOST}:${env.PORT} (${env.NODE_ENV})`);
      });
    }

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
      if (stopMdns) {
        try {
          stopMdns();
        } catch (error) {
          console.error("Erreur lors de l'arret de la publication mDNS :", error);
        }
      }
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

    // Phone-home licence (Lot 3) : verification au demarrage puis chaque
    // dimanche a 5h (n'effectue reellement un appel reseau qu'en mode
    // "auto" - voir runPhoneHomeCheck, qui reste un no-op silencieux en
    // mode "manuel" ou en l'absence de toute licence). Jamais bloquant :
    // une erreur ici est journalisee, jamais propagee.
    runPhoneHomeCheck().catch((error) => {
      console.error("Erreur lors de la verification de licence au demarrage :", error);
    });
    cron.schedule(
      "0 5 * * 0",
      () => {
        runPhoneHomeCheck().catch((error) => {
          console.error("Erreur lors de la verification hebdomadaire de licence :", error);
        });
      },
      { timezone: "Africa/Porto-Novo" }
    );

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
        // getLlmProvider() peut lever une MissingConfigurationError de
        // facon SYNCHRONE (cle API absente) - AVANT meme que
        // runVeillePourTousLesCabinets(...) ne soit appelee, donc avant que
        // le .catch() ci-dessous existe. Sans ce try/catch local, une telle
        // erreur echapperait a ce .catch() et remonterait comme exception
        // non rattrapee depuis ce callback cron (voir le meme probleme
        // corrige dans routes/webActions.ts, getLlmProviderSafe).
        try {
          runVeillePourTousLesCabinets(getLlmProvider()).catch((error) => {
            console.error("Erreur lors de l'execution de la veille juridique hebdomadaire :", error);
          });
        } catch (error) {
          console.error("Veille juridique hebdomadaire ignoree (fournisseur IA non configure) :", error);
        }
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
