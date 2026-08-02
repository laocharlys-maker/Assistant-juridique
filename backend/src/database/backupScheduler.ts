import fs from "node:fs";
import path from "node:path";
import cron from "node-cron";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { loadCredentials } from "./credentialsStore";
import { backupsDir, pgExecutable } from "./portablePaths";

const execFileAsync = promisify(execFile);

const DEFAULT_CRON = "0 3 * * *"; // tous les jours a 3h (heure du Benin, comme les autres jobs planifies du projet)
const DEFAULT_RETENTION = 14;

function timestampForFilename(date: Date): string {
  return date.toISOString().replace(/[:.]/g, "-");
}

function pruneOldBackups(dir: string, keep: number): void {
  const files = fs
    .readdirSync(dir)
    .filter((f) => f.startsWith("aurore-") && f.endsWith(".dump"))
    .sort(); // le prefixe ISO du nom de fichier trie chronologiquement

  const toDelete = files.slice(0, Math.max(0, files.length - keep));
  for (const file of toDelete) {
    fs.rmSync(path.join(dir, file), { force: true });
    console.log(`[postgres-backup] ancienne sauvegarde supprimee (retention=${keep}) : ${file}`);
  }
}

/**
 * Execute une sauvegarde `pg_dump` immediatement (format "custom", -F c :
 * compresse, et directement exploitable par pg_restore / restore-backup.js).
 * Exportee separement de schedulePortableBackups() pour permettre un
 * declenchement manuel (tests, script de restauration, futur bouton UI).
 */
export async function runBackupNow(): Promise<string> {
  const credentials = loadCredentials();
  const dir = backupsDir();
  fs.mkdirSync(dir, { recursive: true });

  const outFile = path.join(dir, `aurore-${timestampForFilename(new Date())}.dump`);
  const env = { ...process.env, PGPASSWORD: credentials.appUserPassword };

  console.log(`[postgres-backup] demarrage de la sauvegarde -> ${outFile}`);
  try {
    await execFileAsync(pgExecutable("pg_dump"), [
      "-h",
      credentials.host,
      "-p",
      String(credentials.port),
      "-U",
      credentials.appUser,
      "-d",
      credentials.database,
      "-F",
      "c",
      "-f",
      outFile,
    ], { env });
  } catch (error) {
    // On ne journalise jamais credentials.appUserPassword : l'erreur de
    // pg_dump (stderr) ne contient normalement pas le mot de passe, mais on
    // reste prudent et n'affiche que le message d'erreur, pas l'objet env.
    console.error("[postgres-backup] echec de la sauvegarde :", error instanceof Error ? error.message : error);
    throw error;
  }

  console.log("[postgres-backup] sauvegarde terminee.");
  pruneOldBackups(dir, Number(process.env.POSTGRES_BACKUP_RETENTION || DEFAULT_RETENTION));
  return outFile;
}

/**
 * Integre la sauvegarde planifiee au meme mecanisme node-cron que les autres
 * jobs du projet (veille juridique, retention, recap role de la semaine -
 * voir src/index.ts). Frequence configurable via POSTGRES_BACKUP_CRON
 * (syntaxe cron standard), 3h du matin par defaut.
 */
export function schedulePortableBackups(): void {
  const cronExpression = process.env.POSTGRES_BACKUP_CRON || DEFAULT_CRON;
  cron.schedule(
    cronExpression,
    () => {
      runBackupNow().catch((error) => {
        console.error("[postgres-backup] echec de la sauvegarde planifiee :", error instanceof Error ? error.message : error);
      });
    },
    { timezone: "Africa/Porto-Novo" }
  );
  console.log(`[postgres-backup] sauvegarde planifiee : "${cronExpression}" (Africa/Porto-Novo), dossier ${backupsDir()}`);
}
