import fs from "node:fs";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { pgExecutable, portableMigrationsDir } from "./portablePaths";
import type { PortablePostgresCredentials } from "./credentialsStore";

/**
 * Applique aux installations EXISTANTES les migrations ajoutees par une mise
 * a jour de l'app (Lot 2 corrige) - avant ce module, ensureClusterInitialized()
 * (initCluster.ts) n'appliquait le schema complet (prisma/portable-init.sql)
 * qu'a la toute premiere initialisation d'un cluster ; un cluster deja
 * initialise n'etait ensuite plus jamais mis a jour, quel que soit le nombre
 * de versions installees par-dessus - une mise a jour ajoutant une table ou
 * une colonne faisait planter le backend au demarrage suivant ("relation ...
 * does not exist", constate concretement au Lot 14bis avec facture_rappels_ignores).
 *
 * Strategie : une table de suivi minimale (_aurore_schema_migrations, un nom
 * de migration par ligne) plutot que l'historique complet de Prisma
 * (_prisma_migrations, jamais utilise par ce projet - voir README-LOT2.md,
 * "ce projet n'utilise pas l'historique prisma migrate deploy"). Pour un
 * cluster tout juste initialise, TOUTES les migrations existantes au moment
 * du build sont marquees appliquees sans etre rejouees (voir
 * marquerMigrationsCommeAppliquees ci-dessous, appele par initCluster.ts) -
 * portable-init.sql les a deja toutes appliquees en un seul script. Pour un
 * cluster PRE-EXISTANT (mis a jour depuis une version anterieure a ce
 * correctif, donc sans cette table), on tolere qu'une migration soit deja
 * effectivement appliquee (portable-init.sql l'incluait deja a l'epoque) en
 * detectant l'erreur Postgres "already exists" plutot que d'echouer -
 * jamais une re-initialisation, jamais une perte de donnees.
 */

const MIGRATIONS_TABLE = "_aurore_schema_migrations";

interface ConnInfo {
  host: string;
  port: number;
  database: string;
  credentials: PortablePostgresCredentials;
  // Uniquement pour les tests (voir tests/e2e/applyPendingMigrations.test.ts) :
  // permet d'injecter le psql d'un Postgres systeme trouve sur la machine de
  // dev/CI plutot que celui, bundle, attendu par pgExecutable() en
  // production (absent d'un checkout source, uniquement present une fois
  // `npm run postgres:download-binaries` execute).
  psqlPath?: string;
}

function superuserEnv(credentials: PortablePostgresCredentials): NodeJS.ProcessEnv {
  return { ...process.env, PGPASSWORD: credentials.superuserPassword };
}

function connArgs(info: ConnInfo): string[] {
  return ["-h", info.host, "-p", String(info.port), "-U", info.credentials.superuser, "-d", info.database];
}

function runPsql(info: ConnInfo, args: string[], env: NodeJS.ProcessEnv): string {
  return execFileSync(info.psqlPath ?? pgExecutable("psql"), args, { stdio: "pipe", env }).toString("utf8");
}

function listMigrationFolders(): string[] {
  const dir = portableMigrationsDir();
  if (!fs.existsSync(dir)) return [];
  return fs
    .readdirSync(dir, { withFileTypes: true })
    .filter((entry) => entry.isDirectory() && fs.existsSync(path.join(dir, entry.name, "migration.sql")))
    .map((entry) => entry.name)
    .sort();
}

function ensureMigrationsTable(info: ConnInfo): void {
  runPsql(
    info,
    [...connArgs(info), "-v", "ON_ERROR_STOP=1", "-c", `CREATE TABLE IF NOT EXISTS "${MIGRATIONS_TABLE}" (name TEXT PRIMARY KEY, applied_at TIMESTAMPTZ NOT NULL DEFAULT now());`],
    superuserEnv(info.credentials)
  );
}

function loadAppliedMigrations(info: ConnInfo): Set<string> {
  const raw = runPsql(info, [...connArgs(info), "-t", "-A", "-c", `SELECT name FROM "${MIGRATIONS_TABLE}";`], superuserEnv(info.credentials));
  return new Set(
    raw
      .split(/\r?\n/)
      .map((line) => line.trim())
      .filter(Boolean)
  );
}

function recordMigration(info: ConnInfo, name: string): void {
  const escaped = name.replace(/'/g, "''");
  runPsql(
    info,
    [...connArgs(info), "-v", "ON_ERROR_STOP=1", "-c", `INSERT INTO "${MIGRATIONS_TABLE}" (name) VALUES ('${escaped}') ON CONFLICT (name) DO NOTHING;`],
    superuserEnv(info.credentials)
  );
}

/**
 * Appelee uniquement juste apres une premiere initialisation reussie
 * (initCluster.ts) : portable-init.sql vient d'appliquer la totalite du
 * schema en un seul script - les migrations individuelles n'ont donc pas
 * besoin d'etre rejouees, seulement enregistrees comme deja faites.
 */
export function marquerMigrationsCommeAppliquees(info: ConnInfo): void {
  ensureMigrationsTable(info);
  for (const folder of listMigrationFolders()) {
    recordMigration(info, folder);
  }
}

/**
 * Appelee a CHAQUE demarrage (bootstrapPortableDatabase.ts), une fois
 * Postgres deja demarre. No-op rapide (une seule requete SELECT) si tout est
 * deja a jour - c'est le cas courant a chaque lancement.
 */
export async function applyPendingMigrations(info: ConnInfo): Promise<void> {
  const folders = listMigrationFolders();
  if (folders.length === 0) return; // build sans dossier migrations embarque (anterieur a ce correctif) - rien a faire.

  ensureMigrationsTable(info);
  const applied = loadAppliedMigrations(info);
  const pending = folders.filter((name) => !applied.has(name));
  if (pending.length === 0) return;

  console.log(`[postgres-migrate] ${pending.length} migration(s) en attente : ${pending.join(", ")}`);

  for (const folder of pending) {
    const sqlFile = path.join(portableMigrationsDir(), folder, "migration.sql");
    try {
      runPsql(info, [...connArgs(info), "-v", "ON_ERROR_STOP=1", "-f", sqlFile], superuserEnv(info.credentials));
      console.log(`[postgres-migrate] migration appliquee : ${folder}`);
    } catch (error) {
      const stderr = (error as { stderr?: Buffer })?.stderr?.toString("utf8") ?? "";
      const message = error instanceof Error ? error.message : String(error);
      // Cluster mis a jour depuis une version anterieure a ce mecanisme de
      // suivi : portable-init.sql avait deja applique cette migration a
      // l'epoque, sans laisser de trace dans MIGRATIONS_TABLE (qui vient
      // seulement d'etre creee). Jamais une vraie panne dans ce cas precis -
      // on se contente de l'enregistrer comme faite, sans la rejouer.
      if (/already exists|existe déjà|existe deja/i.test(stderr) || /already exists|existe déjà|existe deja/i.test(message)) {
        console.warn(`[postgres-migrate] "${folder}" semble deja appliquee (objets deja presents) - marquee sans reexecution.`);
      } else {
        throw new Error(`[postgres-migrate] echec de la migration "${folder}" : ${message}\n${stderr}`);
      }
    }
    recordMigration(info, folder);
  }

  // Une nouvelle table/colonne creee par une migration n'herite pas
  // automatiquement des privileges du role applicatif (voir le meme GRANT
  // en toute fin de provisionnement initial, initCluster.ts) - sans ce
  // rappel, Prisma (qui se connecte avec aurore_app, jamais le superutilisateur)
  // echouerait avec "permission denied" sur les objets fraichement crees.
  runPsql(
    info,
    [...connArgs(info), "-v", "ON_ERROR_STOP=1", "-c", `GRANT ALL PRIVILEGES ON ALL TABLES IN SCHEMA public TO ${info.credentials.appUser}; GRANT ALL PRIVILEGES ON ALL SEQUENCES IN SCHEMA public TO ${info.credentials.appUser};`],
    superuserEnv(info.credentials)
  );
  console.log("[postgres-migrate] privileges du role applicatif mis a jour sur les nouveaux objets.");
}
