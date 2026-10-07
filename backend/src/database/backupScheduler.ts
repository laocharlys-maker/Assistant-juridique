import fs from "node:fs";
import path from "node:path";
import cron from "node-cron";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { loadCredentials } from "./credentialsStore";
import { backupsDir, pgExecutable, userDataDir, secretsDir } from "./portablePaths";
import { appRoot } from "../lib/seaPaths";

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
 * Corbeille/pieces jointes (2026-10-07) : les pieces jointes de dossier
 * (DocumentDossier/ActionVersionFichier, services/stockageDocuments.ts),
 * les signatures utilisateur et l'en-tete du cabinet (routes/signature.ts,
 * routes/cabinet.ts) sont des FICHIERS SUR DISQUE, jamais dans Postgres -
 * le pg_dump ci-dessous ne les protege donc pas du tout. Sans ceci, une
 * panne disque ou une perte du poste rendrait TOUTES les pieces jointes et
 * signatures irrecuperables, meme avec la sauvegarde de base de donnees en
 * place (le seul filet de securite que l'utilisateur croit avoir).
 *
 * Miroir simple (pas un historique par nuit comme les dumps SQL ci-dessus -
 * ces fichiers changent rarement une fois crees, un miroir a jour suffit et
 * evite de dupliquer des gigaoctets de pieces jointes chaque nuit) : copie
 * recursive vers backups/fichiers, jamais de suppression du cote source,
 * jamais destructif si la copie echoue partiellement (les fichiers
 * precedents dans le miroir restent en l'etat, prochaine tentative la nuit
 * suivante).
 *
 * La cle de chiffrement (secretsDir(), security/encryptionAtRest.ts) est
 * INDISPENSABLE a inclure : sans elle, les pieces jointes chiffrees
 * (stockageDocuments.ts) copiees seraient illisibles meme restaurees.
 */
function mirrorFichiersUtilisateur(): void {
  const cibleRacine = path.join(backupsDir(), "fichiers");
  const sources: Array<{ src: string; dest: string }> = [
    { src: path.join(userDataDir(), "documents"), dest: path.join(cibleRacine, "documents") },
    { src: secretsDir(), dest: path.join(cibleRacine, "secrets") },
    { src: path.join(appRoot(), "public", "uploads"), dest: path.join(cibleRacine, "uploads") },
  ];

  for (const { src, dest } of sources) {
    if (!fs.existsSync(src)) continue; // rien a sauvegarder encore (ex: premier lancement, aucune piece jointe).
    try {
      fs.mkdirSync(path.dirname(dest), { recursive: true });
      fs.cpSync(src, dest, { recursive: true });
    } catch (error) {
      console.error(
        `[postgres-backup] échec de la copie de secours de "${src}" (ignoré, retenté au prochain cycle) :`,
        error instanceof Error ? error.message : error
      );
    }
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

  console.log("[postgres-backup] copie de secours des pièces jointes/signatures/clé de chiffrement...");
  mirrorFichiersUtilisateur();
  console.log("[postgres-backup] copie de secours terminée.");

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
