import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFileSync } from "node:child_process";
import {
  clusterIsInitialized,
  startPortablePostgres,
  stopPortablePostgres,
  runPortableExecutableSync,
} from "./postgresPortable";
import {
  credentialsExist,
  loadCredentials,
  generateAndStoreCredentials,
  type PortablePostgresCredentials,
} from "./credentialsStore";
import { pgExecutable, credentialsFilePath, portableSchemaSqlFile } from "./portablePaths";

export interface InitClusterOptions {
  binDir: string;
  dataDir: string;
  logFile: string;
  host: string;
  port: number;
  database: string;
}

function sqlLiteral(value: string): string {
  return `'${value.replace(/'/g, "''")}'`;
}

function runPsql(args: string[], env: NodeJS.ProcessEnv): void {
  execFileSync(pgExecutable("psql"), ["-v", "ON_ERROR_STOP=1", ...args], { stdio: "pipe", env });
}

/**
 * Ecrit APRES le tout dernier GRANT reussi : distingue "initdb a tourne"
 * (PG_VERSION existe) de "le provisionnement complet (role/base/pgvector/
 * schema/privileges) a reussi". Sans ce marqueur, un echec partiel (ex:
 * pgvector absent du build - voir README-LOT2.md) suivi d'un redemarrage
 * ferait passer le cluster pour "deja pret" alors que le schema applicatif
 * n'existe pas, et l'app demarrerait contre une base vide au lieu d'echouer
 * clairement.
 */
function provisioningMarkerFile(dataDir: string): string {
  return path.join(dataDir, ".aurore-provisioned");
}

function isFullyProvisioned(dataDir: string): boolean {
  return fs.existsSync(provisioningMarkerFile(dataDir));
}

/**
 * Premiere initialisation d'un cluster Postgres portable : initdb, creation
 * du role applicatif dedie, de la base, activation de pgvector et mise en
 * place du schema (voir prisma/portable-init.sql). Ne fait RIEN si un
 * cluster existe deja (idempotent) - c'est postgresPortable.ts qui gere le
 * demarrage/arret courant a chaque lancement suivant.
 *
 * Ne journalise jamais un mot de passe, meme en cas d'erreur (les commandes
 * psql/initdb recoivent le mot de passe via PGPASSWORD/--pwfile, jamais en
 * argument de ligne de commande visible dans les logs de process).
 */
export async function ensureClusterInitialized(options: InitClusterOptions): Promise<PortablePostgresCredentials> {
  const clusterExists = clusterIsInitialized(options.dataDir);

  if (clusterExists) {
    if (!credentialsExist() || !isFullyProvisioned(options.dataDir)) {
      throw new Error(
        `[postgres-init] cluster Postgres present (${options.dataDir}) mais incomplet (identifiants ${
          credentialsExist() ? "presents" : "MANQUANTS"
        }, provisionnement ${isFullyProvisioned(options.dataDir) ? "termine" : "INCOMPLET"} - ` +
          `marqueur attendu : ${provisioningMarkerFile(options.dataDir)}). ` +
          "Cause la plus probable : une premiere initialisation a echoue en cours de route (ex: pgvector absent du build, " +
          "voir README-LOT2.md) et n'a pas ete nettoyee. Ne PAS re-initialiser automatiquement par-dessus (risque de perte de " +
          "donnees si le probleme est en realite ailleurs) : intervention manuelle requise - verifier le log " +
          `(${options.logFile}), corriger la cause, puis supprimer le dossier ${options.dataDir} et ${credentialsFilePath()} ` +
          "avant de relancer l'app pour repartir d'une initialisation propre."
      );
    }
    console.log("[postgres-init] cluster deja initialise, rien a faire.");
    return loadCredentials();
  }

  console.log(`[postgres-init] premiere initialisation du cluster portable (${options.dataDir})...`);
  const credentials = generateAndStoreCredentials({
    host: options.host,
    port: options.port,
    database: options.database,
  });

  fs.mkdirSync(options.dataDir, { recursive: true });

  const pwFile = path.join(os.tmpdir(), `aurore-pg-init-${process.pid}-${Date.now()}.txt`);
  fs.writeFileSync(pwFile, credentials.superuserPassword, { mode: 0o600 });
  try {
    console.log("[postgres-init] initdb...");
    runPortableExecutableSync("initdb", [
      "-D",
      options.dataDir,
      "-U",
      credentials.superuser,
      `--pwfile=${pwFile}`,
      "--auth=scram-sha-256",
      "-E",
      "UTF8",
      "--locale=C",
    ]);
  } finally {
    fs.rmSync(pwFile, { force: true });
  }

  console.log("[postgres-init] demarrage temporaire pour provisionnement...");
  await startPortablePostgres({
    binDir: options.binDir,
    dataDir: options.dataDir,
    logFile: options.logFile,
    host: options.host,
    port: options.port,
  });

  try {
    const superuserEnv = { ...process.env, PGPASSWORD: credentials.superuserPassword };
    const connArgs = ["-h", options.host, "-p", String(options.port), "-U", credentials.superuser];

    console.log("[postgres-init] creation du role applicatif dedie...");
    runPsql(
      [...connArgs, "-d", "postgres", "-c", `CREATE ROLE ${credentials.appUser} LOGIN PASSWORD ${sqlLiteral(credentials.appUserPassword)};`],
      superuserEnv
    );

    console.log(`[postgres-init] creation de la base "${options.database}"...`);
    runPsql([...connArgs, "-d", "postgres", "-c", `CREATE DATABASE ${options.database} OWNER ${credentials.appUser};`], superuserEnv);

    console.log("[postgres-init] activation de pgvector et mise en place du schema applicatif...");
    const schemaSqlFile = portableSchemaSqlFile();
    if (!fs.existsSync(schemaSqlFile)) {
      throw new Error(
        `[postgres-init] ${schemaSqlFile} introuvable - as-tu bien lance \`npm run build:sea\` (qui regenere ce fichier via ` +
          "prisma:portable-sql) plutot que de copier le binaire a la main ?"
      );
    }
    runPsql([...connArgs, "-d", options.database, "-f", schemaSqlFile], superuserEnv);

    console.log("[postgres-init] octroi des privileges au role applicatif...");
    runPsql(
      [...connArgs, "-d", options.database, "-c", `GRANT ALL PRIVILEGES ON ALL TABLES IN SCHEMA public TO ${credentials.appUser};`],
      superuserEnv
    );
    runPsql(
      [...connArgs, "-d", options.database, "-c", `GRANT ALL PRIVILEGES ON ALL SEQUENCES IN SCHEMA public TO ${credentials.appUser};`],
      superuserEnv
    );

    fs.writeFileSync(provisioningMarkerFile(options.dataDir), new Date().toISOString());
    console.log("[postgres-init] cluster initialise avec succes.");
  } finally {
    await stopPortablePostgres({ binDir: options.binDir, dataDir: options.dataDir, logFile: options.logFile });
  }

  return credentials;
}
