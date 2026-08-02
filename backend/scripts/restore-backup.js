#!/usr/bin/env node
// Restauration manuelle d'une sauvegarde Postgres portable (pg_restore).
//
// Usage :
//   node scripts/restore-backup.js <fichier.dump> [--database=NOM] [--drop]
//
//   --database=NOM  restaure vers une base differente de celle des
//                    identifiants stockes (par defaut : la base configuree)
//   --drop          supprime et recree la base cible avant restauration
//                    (DESTRUCTIF - sinon restauration additive dans une base
//                    existante, ce qui echoue generalement si les tables
//                    existent deja : utiliser --drop dans ce cas)
//
// Volontairement non expose dans l'UI pour ce lot (demande explicite) :
// outil de recuperation manuelle (PC remplace, corruption, restauration
// d'un poste a un autre) - voir README-LOT2.md pour la procedure complete
// pas a pas.
const path = require("node:path");
const fs = require("node:fs");
const os = require("node:os");
const readline = require("node:readline");
const { execFileSync } = require("node:child_process");

function userDataDir() {
  if (process.env.APPDATA) return path.join(process.env.APPDATA, "Aurore");
  if (process.platform === "darwin") return path.join(os.homedir(), "Library", "Application Support", "Aurore");
  return path.join(process.env.XDG_DATA_HOME || path.join(os.homedir(), ".local", "share"), "Aurore");
}

function credentialsFilePath() {
  return path.join(userDataDir(), "secrets", "db-credentials.json");
}

function pgBinDir() {
  // Ce script tourne depuis backend/scripts/ (poste de developpement/support),
  // pas depuis l'app installee : on cherche donc les binaires portables a
  // cote du projet (prepares par `npm run postgres:download-binaries`),
  // avec repli sur POSTGRES_PORTABLE_BIN_DIR si l'app tourne depuis un autre
  // emplacement (ex: execute directement sur le poste d'un cabinet, en
  // pointant vers le dossier "postgres" installe a cote de l'app).
  if (process.env.POSTGRES_PORTABLE_BIN_DIR) return process.env.POSTGRES_PORTABLE_BIN_DIR;
  const platformDir = process.platform === "win32" ? "win-x64" : process.platform === "darwin" ? "darwin-x64" : "linux-x64";
  return path.join(__dirname, "..", "vendor", "postgres", platformDir, "bin");
}

function pgExecutable(name) {
  return path.join(pgBinDir(), process.platform === "win32" ? `${name}.exe` : name);
}

function loadCredentials() {
  const file = credentialsFilePath();
  if (!fs.existsSync(file)) {
    throw new Error(
      `Identifiants introuvables (${file}).\n` +
        `Ce script doit tourner avec acces au dossier ${userDataDir()} du poste concerne. ` +
        "Si tu restaures sur une machine differente de celle d'origine (PC remplace), copie d'abord " +
        "le dossier \"Aurore\" complet (%APPDATA%\\Aurore) depuis une sauvegarde/l'ancien poste, ou " +
        "reinitialise un cluster neuf (relance l'app une premiere fois) puis restaure par-dessus avec --drop."
    );
  }
  return JSON.parse(fs.readFileSync(file, "utf8"));
}

function ask(question) {
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  return new Promise((resolve) => rl.question(question, (answer) => {
    rl.close();
    resolve(answer);
  }));
}

async function main() {
  const args = process.argv.slice(2);
  const dumpFile = args.find((a) => !a.startsWith("--"));
  const dropExisting = args.includes("--drop");
  const databaseArg = args.find((a) => a.startsWith("--database="));

  if (!dumpFile) {
    console.error(
      "Usage : node scripts/restore-backup.js <fichier.dump> [--database=NOM] [--drop]\n\n" +
        "  --database=NOM  restaure vers une base differente de celle des identifiants stockes\n" +
        "  --drop          supprime et recree la base cible avant restauration (DESTRUCTIF)\n"
    );
    process.exit(1);
  }
  if (!fs.existsSync(dumpFile)) {
    console.error(`Fichier de sauvegarde introuvable : ${dumpFile}`);
    process.exit(1);
  }

  const credentials = loadCredentials();
  const targetDatabase = databaseArg ? databaseArg.slice("--database=".length) : credentials.database;
  const superuserEnv = { ...process.env, PGPASSWORD: credentials.superuserPassword };
  const connArgs = ["-h", credentials.host, "-p", String(credentials.port), "-U", credentials.superuser];

  console.log(`Restauration de "${dumpFile}" vers la base "${targetDatabase}" sur ${credentials.host}:${credentials.port}.`);

  if (dropExisting) {
    const answer = await ask(
      `ATTENTION : ceci va SUPPRIMER puis recreer la base "${targetDatabase}" avant restauration.\n` +
        "Toutes les donnees actuellement dans cette base seront perdues.\n" +
        'Continuer ? (taper "oui" pour confirmer) '
    );
    if (answer.trim().toLowerCase() !== "oui") {
      console.log("Annule.");
      process.exit(0);
    }

    const psql = pgExecutable("psql");
    console.log(`Suppression de la base existante "${targetDatabase}" (si presente)...`);
    execFileSync(psql, [...connArgs, "-d", "postgres", "-v", "ON_ERROR_STOP=1", "-c", `DROP DATABASE IF EXISTS ${targetDatabase};`], {
      stdio: "inherit",
      env: superuserEnv,
    });
    console.log(`Recreation de la base "${targetDatabase}"...`);
    execFileSync(
      psql,
      [...connArgs, "-d", "postgres", "-v", "ON_ERROR_STOP=1", "-c", `CREATE DATABASE ${targetDatabase} OWNER ${credentials.appUser};`],
      { stdio: "inherit", env: superuserEnv }
    );
  }

  console.log("Restauration en cours (pg_restore)...");
  execFileSync(
    pgExecutable("pg_restore"),
    [...connArgs, "-d", targetDatabase, "--no-owner", "--role", credentials.superuser, dumpFile],
    { stdio: "inherit", env: superuserEnv }
  );

  console.log(
    "\nRestauration terminee. Verifie l'application (connexion, quelques dossiers/clients) avant de considerer la migration terminee."
  );
}

main().catch((error) => {
  console.error(`\nEchec de la restauration : ${error.message}`);
  process.exit(1);
});
