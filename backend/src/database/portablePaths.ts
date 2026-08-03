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

const WINDOWS_EXTENDED_LENGTH_PREFIX = "\\\\?\\";
const WINDOWS_EXTENDED_LENGTH_UNC_PREFIX = "\\\\?\\UNC\\";
// Limite classique de l'API Win32 (MAX_PATH). Le manifest de l'app ne
// declare pas le support des chemins longs, et les binaires Postgres
// portables (voir stripWindowsExtendedLengthPrefix ci-dessous) tournent
// desormais SANS le prefixe \\?\ qui permettrait de la depasser.
const WINDOWS_MAX_PATH = 260;

/**
 * Windows uniquement : `resource_dir()` de Tauri (voir AURORE_APP_ROOT
 * positionne dans src-tauri/src/main.rs) peut renvoyer un chemin "verbatim"
 * prefixe \\?\ (ou \\?\UNC\ pour un partage reseau) - le mecanisme natif
 * Windows pour depasser MAX_PATH (260 caracteres). Ce prefixe est correct
 * tel quel pour nos propres appels (execFileSync le transmet sans le
 * toucher), mais initdb.exe le CASSE en interne : pour verifier sa version
 * avant de s'executer, initdb re-derive le chemin de postgres.exe a partir
 * de son propre argv0 en passant par la canonicalisation de chemin de
 * PostgreSQL (src/common/path.c), qui remplace inconditionnellement tous
 * les '\' par des '/' - y compris dans le prefixe \\?\, qui devient //?/
 * et n'est alors plus reconnu par Windows ("le chemin d'acces specifie est
 * introuvable"). D'ou le retrait explicite ici, au point de construction
 * commun a tous les executables Postgres (initdb, postgres, pg_ctl, psql,
 * pg_isready, pg_dump).
 *
 * RISQUE CONNU, documente volontairement meme si rien n'est casse
 * aujourd'hui : retirer ce prefixe desactive le support "chemin long" pour
 * ces executables. Verifie pour le cas reel actuel (installation per-
 * utilisateur NSIS sous %LOCALAPPDATA%\Aurore\...) : un chemin comme
 * "C:\Users\<utilisateur>\AppData\Local\Aurore\postgres\win-x64\bin\
 * postgres.exe" reste largement sous les 260 caracteres de MAX_PATH, meme
 * pour un nom d'utilisateur long - voir aussi l'avertissement d'execution
 * ci-dessous si ce n'etait plus le cas. Si le dossier d'installation venait
 * un jour a s'allonger au point de depasser cette limite, la solution n'est
 * PAS de reintroduire ce prefixe (initdb ne le tolere pas), mais soit de
 * raccourcir le chemin d'installation, soit d'activer explicitement le
 * support des chemins longs Windows (manifest applicatif + cle de registre
 * LongPathsEnabled) ET de verifier au prealable que la chaine d'outils
 * Postgres portable le tolere reellement de bout en bout.
 */
function stripWindowsExtendedLengthPrefix(rawPath: string): string {
  if (process.platform !== "win32") {
    return rawPath;
  }
  if (rawPath.startsWith(WINDOWS_EXTENDED_LENGTH_UNC_PREFIX)) {
    return "\\\\" + rawPath.slice(WINDOWS_EXTENDED_LENGTH_UNC_PREFIX.length);
  }
  if (rawPath.startsWith(WINDOWS_EXTENDED_LENGTH_PREFIX)) {
    return rawPath.slice(WINDOWS_EXTENDED_LENGTH_PREFIX.length);
  }
  return rawPath;
}

/** Dossier des binaires Postgres portables embarques (voir scripts/download-postgres-binaries.js). */
export function pgBinDir(): string {
  const platformDir = PLATFORM_BINARY_DIR[process.platform] ?? process.platform;
  const binDir = path.join(stripWindowsExtendedLengthPrefix(appRoot()), "postgres", platformDir, "bin");

  if (process.platform === "win32" && binDir.length + "\\postgres.exe".length > WINDOWS_MAX_PATH) {
    console.warn(
      `[postgres-portable] ATTENTION : le chemin des binaires Postgres portables (${binDir}) approche ou depasse ` +
        `la limite Windows MAX_PATH (${WINDOWS_MAX_PATH} caracteres) une fois le prefixe de chemin long retire ` +
        "(voir stripWindowsExtendedLengthPrefix dans ce fichier). initdb/postgres vont probablement echouer avec " +
        '"chemin d\'acces introuvable". Raccourcir le dossier d\'installation ou revoir ce mecanisme.'
    );
  }

  return binDir;
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
