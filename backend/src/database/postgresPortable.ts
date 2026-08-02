import fs from "node:fs";
import path from "node:path";
import { execFile, execFileSync } from "node:child_process";
import { pgExecutable } from "./portablePaths";

/**
 * Cycle de vie courant (demarrage/arret) d'un cluster Postgres portable
 * DEJA initialise. La logique de premiere initialisation (initdb, creation
 * du role/de la base/de pgvector) vit dans initCluster.ts - deux
 * responsabilites separees, comme demande.
 */
export interface PortablePostgresInstance {
  binDir: string;
  dataDir: string;
  logFile: string;
  host: string;
  port: number;
}

export function clusterIsInitialized(dataDir: string): boolean {
  // PG_VERSION est cree par initdb en toute derniere etape et est le
  // marqueur standard d'un data directory Postgres valide.
  return fs.existsSync(path.join(dataDir, "PG_VERSION"));
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Verifie que le serveur accepte reellement des connexions, via pg_isready
 * (vraie negociation au niveau protocole Postgres) - jamais un simple delai
 * fixe. Un PC lent au demarrage aura simplement plus de tentatives, pas un
 * echec premature.
 */
export async function waitUntilReady(
  instance: Pick<PortablePostgresInstance, "binDir" | "host" | "port">,
  options: { maxAttempts?: number; intervalMs?: number } = {}
): Promise<void> {
  const maxAttempts = options.maxAttempts ?? 60;
  const intervalMs = options.intervalMs ?? 500;
  const pgIsReady = pgExecutable("pg_isready");

  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    const ready = await new Promise<boolean>((resolve) => {
      execFile(pgIsReady, ["-h", instance.host, "-p", String(instance.port)], (error) => resolve(!error));
    });
    if (ready) {
      console.log(`[postgres-portable] connexion confirmee (tentative ${attempt}/${maxAttempts}).`);
      return;
    }
    if (attempt % 10 === 0) {
      console.log(`[postgres-portable] toujours en attente de connexion (tentative ${attempt}/${maxAttempts})...`);
    }
    await sleep(intervalMs);
  }

  throw new Error(
    `[postgres-portable] pas de reponse sur ${instance.host}:${instance.port} apres ${maxAttempts} tentatives - voir le log ${path.dirname(
      pgIsReady
    )}/../../ (logFile passe a startPortablePostgres).`
  );
}

export async function startPortablePostgres(instance: PortablePostgresInstance): Promise<void> {
  fs.mkdirSync(path.dirname(instance.logFile), { recursive: true });
  console.log(`[postgres-portable] demarrage du cluster (${instance.host}:${instance.port}, data=${instance.dataDir})...`);

  try {
    // execFileSync avec stdio "ignore" - PAS execFile/execFileAsync - est
    // ESSENTIEL ici, pas juste un detail : pg_ctl start demarre postgres.exe
    // (et ses process auxiliaires - checkpointer, bgwriter, walwriter...)
    // comme processus persistants qui HERITENT des handles stdout/stderr du
    // process Node quand ce sont des pipes. execFile (API callback/promise)
    // utilise toujours des pipes pour stdout/stderr (l'option stdio n'existe
    // meme pas sur son type) et Node attend leur fermeture (EOF) pour
    // resoudre - qui n'arrive jamais tant que postgres tourne, donc jamais.
    // Constate empiriquement : avec execFileAsync (pipes), pg_ctl start
    // (pourtant termine en <1s cote Postgres, confirme par son propre log)
    // ne rendait jamais la main a Node - hang indefini. execFileSync
    // supporte reellement l'option stdio, d'ou son usage ici bien que le
    // reste du fichier soit ecrit en style async. Le vrai retour "pret" est
    // de toute facon confirme juste apres par waitUntilReady (vraie
    // tentative de connexion), pas par la sortie texte de pg_ctl.
    execFileSync(
      pgExecutable("pg_ctl"),
      ["start", "-D", instance.dataDir, "-l", instance.logFile, "-w", "-t", "60", "-o", `-p ${instance.port} -h ${instance.host}`],
      { stdio: "ignore" }
    );
  } catch (error) {
    throw new Error(
      `[postgres-portable] echec du demarrage (voir ${instance.logFile} pour le detail) : ${
        error instanceof Error ? error.message : error
      }`
    );
  }

  // pg_ctl -w attend deja un signal de disponibilite, mais on confirme
  // explicitement par une vraie tentative de connexion (voir waitUntilReady)
  // avant de rendre la main, conformement a la consigne du lot.
  await waitUntilReady(instance);
  console.log("[postgres-portable] pret.");
}

export async function stopPortablePostgres(
  instance: Pick<PortablePostgresInstance, "binDir" | "dataDir" | "logFile">
): Promise<void> {
  if (!clusterIsInitialized(instance.dataDir)) {
    return;
  }
  console.log("[postgres-portable] arret propre (pg_ctl stop -m fast)...");
  try {
    execFileSync(pgExecutable("pg_ctl"), ["stop", "-D", instance.dataDir, "-m", "fast", "-w", "-t", "30"], {
      stdio: "ignore",
    });
    console.log("[postgres-portable] arrete proprement, aucune corruption attendue au prochain demarrage.");
  } catch (error) {
    // On ne relance jamais un kill -9 automatique ici : mieux vaut un
    // message d'erreur clair a diagnostiquer qu'un risque de corruption du
    // data directory. Voir README-LOT2.md.
    console.error(
      "[postgres-portable] echec de l'arret propre - le process pg_ctl/postgres a pu rester actif, verifier manuellement :",
      error instanceof Error ? error.message : error
    );
  }
}

/** Utilise par initCluster.ts pour invoquer initdb/psql de facon synchrone pendant le provisionnement initial. */
export function runPortableExecutableSync(
  name: string,
  args: string[],
  options?: { env?: NodeJS.ProcessEnv }
): void {
  execFileSync(pgExecutable(name), args, { stdio: "pipe", env: options?.env ?? process.env });
}
