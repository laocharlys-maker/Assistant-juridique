import os from "node:os";
import path from "node:path";
import { appRoot } from "../lib/seaPaths";

/**
 * Tous les chemins lies au Postgres portable (Lot 2), centralises ici pour
 * eviter de dupliquer cette logique entre credentialsStore.ts,
 * postgresPortable.ts, initCluster.ts, backupScheduler.ts et
 * scripts/restore-backup.js.
 */

/**
 * Dossier de donnees utilisateur de l'app (jamais le dossier d'installation,
 * qui peut etre en lecture seule ou ecrase a la mise a jour).
 */
export function userDataDir(): string {
  if (process.env.APPDATA) {
    return path.join(process.env.APPDATA, "Aurore");
  }
  if (process.platform === "darwin") {
    return path.join(os.homedir(), "Library", "Application Support", "Aurore");
  }
  // Linux/serveur (pertinent pour le mode reseau du Lot 6, qui reutilise ce module).
  return path.join(process.env.XDG_DATA_HOME || path.join(os.homedir(), ".local", "share"), "Aurore");
}

/** Meme emplacement que la future cle de chiffrement (Lot 2bis). */
export function secretsDir(): string {
  return path.join(userDataDir(), "secrets");
}

export function credentialsFilePath(): string {
  return path.join(secretsDir(), "db-credentials.json");
}

export function pgDataDir(): string {
  return path.join(userDataDir(), "pgdata");
}

export function pgLogFile(): string {
  return path.join(userDataDir(), "logs", "postgres.log");
}

export function backupsDir(): string {
  return path.join(userDataDir(), "backups");
}

const PLATFORM_BINARY_DIR: Partial<Record<NodeJS.Platform, string>> = {
  win32: "win-x64",
  linux: "linux-x64",
  darwin: "darwin-x64",
};

/** Dossier des binaires Postgres portables embarques (voir scripts/download-postgres-binaries.js). */
export function pgBinDir(): string {
  const platformDir = PLATFORM_BINARY_DIR[process.platform] ?? process.platform;
  return path.join(appRoot(), "postgres", platformDir, "bin");
}

export function pgExecutable(name: string): string {
  return path.join(pgBinDir(), process.platform === "win32" ? `${name}.exe` : name);
}

/** Script SQL genere (voir prisma/portable-init.sql et `npm run prisma:portable-sql`). */
export function portableSchemaSqlFile(): string {
  return path.join(appRoot(), "prisma", "portable-init.sql");
}

export interface PortablePostgresSettings {
  host: string;
  port: number;
  database: string;
}

export function portableSettingsFromEnv(): PortablePostgresSettings {
  return {
    host: process.env.POSTGRES_PORTABLE_HOST || "127.0.0.1",
    // 5433 par defaut : distinct du port Postgres standard (5432) pour ne
    // jamais entrer en conflit avec une eventuelle installation Postgres
    // systeme deja presente sur le poste.
    port: Number(process.env.POSTGRES_PORTABLE_PORT || 5433),
    database: process.env.POSTGRES_PORTABLE_DATABASE || "aurore",
  };
}
