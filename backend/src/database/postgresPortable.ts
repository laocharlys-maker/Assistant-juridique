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

function postmasterPidPath(dataDir: string): string {
  return path.join(dataDir, "postmaster.pid");
}

interface PostmasterLock {
  pid: number;
  /** null si illisible/absente - voir le format postmaster.pid de Postgres (ligne 4). */
  port: number | null;
}

/**
 * Lit postmaster.pid tel qu'ecrit par Postgres lui-meme (ligne 1 : PID,
 * ligne 4 : port d'ecoute - voir la fonction homonyme cote serveur,
 * src/backend/utils/init/miscinit.c). Ancre volontairement TOUTE decision
 * de reutilisation/nettoyage sur ce fichier specifique au data directory
 * cible, jamais sur une simple verification "quelque chose repond sur ce
 * host:port" (voir le piège ci-dessous) : le port portable (5433 par
 * defaut) est partage par convention entre toutes les instances Aurore de
 * la machine - une verification par pg_isready sur host:port aurait pu
 * trouver une AUTRE instance (une installation differente, un test
 * precedent laisse actif) et conclure a tort "notre cluster est deja pret",
 * avec des identifiants qui ne correspondent pas du tout - constate
 * concretement en testant ce correctif : CREATE ROLE echouait juste apres
 * avec "password authentication failed", la nouvelle instance venant d'etre
 * initialisee avec de nouveaux identifiants pendant qu'une AUTRE instance
 * (deja active sur le meme port) repondait au pg_isready.
 */
function readPostmasterLock(dataDir: string): PostmasterLock | null {
  let raw: string;
  try {
    raw = fs.readFileSync(postmasterPidPath(dataDir), "utf8");
  } catch {
    return null;
  }
  const lines = raw.split(/\r?\n/);
  const pid = Number(lines[0]?.trim());
  if (!Number.isInteger(pid) || pid <= 0) {
    console.warn(`[postgres-portable] ${postmasterPidPath(dataDir)} present mais illisible (PID non numerique).`);
    return null;
  }
  const port = Number(lines[3]?.trim());
  return { pid, port: Number.isInteger(port) ? port : null };
}

function isPidAlive(pid: number): boolean {
  try {
    process.kill(pid, 0); // Ne tue rien (signal 0) - leve seulement si le PID n'existe pas.
    return true;
  } catch {
    return false;
  }
}

/** Dernieres lignes du log Postgres, incluses dans le message d'erreur pour
 * un diagnostic immediat (voir echec du demarrage ci-dessous) sans devoir
 * ouvrir un second fichier a la main. */
function tailLogFile(logFile: string, maxLines = 20): string {
  try {
    const lines = fs.readFileSync(logFile, "utf8").split(/\r?\n/).filter(Boolean);
    return lines.slice(-maxLines).join("\n");
  } catch {
    return "(log illisible ou absent)";
  }
}

export async function startPortablePostgres(instance: PortablePostgresInstance): Promise<void> {
  fs.mkdirSync(path.dirname(instance.logFile), { recursive: true });
  console.log(`[postgres-portable] demarrage du cluster (${instance.host}:${instance.port}, data=${instance.dataDir})...`);

  const lock = readPostmasterLock(instance.dataDir);
  if (lock) {
    if (isPidAlive(lock.pid) && (lock.port === null || lock.port === instance.port)) {
      // Le process backend precedent a probablement plante (exception non
      // rattrapee, crash Windows...) SANS passer par stopPortablePostgres :
      // pg_ctl start demarre postgres.exe comme process DETACHE du cycle de
      // vie de Node (voir le commentaire plus bas sur execFileSync/stdio
      // "ignore" - necessaire pour que les processus auxiliaires
      // checkpointer/bgwriter/walwriter survivent), donc il continue de
      // tourner en arriere-plan meme apres la mort du process Node qui l'a
      // lance. Rappeler pg_ctl start dessus echouerait normalement ("another
      // postmaster may be running") - ce n'est pas une erreur, notre PROPRE
      // cluster (confirme par le PID et le port de CE data directory, pas
      // une simple reponse sur le port) est deja pret, il suffit de le
      // reutiliser tel quel.
      console.log(
        `[postgres-portable] deja demarre (PID ${lock.pid}, probablement laisse actif par un arret non propre du process precedent) - reutilise tel quel.`
      );
      await waitUntilReady(instance);
      console.log("[postgres-portable] pret.");
      return;
    }
    if (!isPidAlive(lock.pid)) {
      // Verrou perime : le PID enregistre ne correspond plus a aucun
      // process actif (arret non propre plus radical - crash machine,
      // panne electrique - jamais observe empiriquement mais possible en
      // theorie). Sans ce nettoyage, pg_ctl start refuserait indefiniment
      // de demarrer alors qu'aucun Postgres ne tourne reellement, avec pour
      // seul recours un geste manuel (voir README-LOT2.md).
      console.warn(
        `[postgres-portable] verrou perime (${postmasterPidPath(instance.dataDir)}, PID ${lock.pid} inexistant) - suppression avant nouvelle tentative de demarrage.`
      );
      fs.rmSync(postmasterPidPath(instance.dataDir), { force: true });
    } else {
      // PID vivant mais port enregistre different de celui attendu - cas
      // limite jamais observe, on n'y touche pas (ne jamais risquer une
      // double instance sur le meme data directory) et on laisse pg_ctl
      // start echouer plus bas avec son message habituel.
      console.warn(
        `[postgres-portable] ${postmasterPidPath(instance.dataDir)} present (PID ${lock.pid} actif) mais port enregistre (${lock.port}) different de celui attendu (${instance.port}) - situation inattendue, tentative de demarrage normale quand meme.`
      );
    }
  }

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
      `[postgres-portable] echec du demarrage : ${error instanceof Error ? error.message : error}\n` +
        `--- dernieres lignes de ${instance.logFile} ---\n${tailLogFile(instance.logFile)}`
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
