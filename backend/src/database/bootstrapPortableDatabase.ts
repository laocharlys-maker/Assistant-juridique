import { ensureClusterInitialized } from "./initCluster";
import { startPortablePostgres, stopPortablePostgres } from "./postgresPortable";
import { buildDatabaseUrl } from "./credentialsStore";
import { pgBinDir, pgDataDir, pgLogFile, portableSettingsFromEnv } from "./portablePaths";

export interface PortableDatabaseHandle {
  databaseUrl: string;
  host: string;
  port: number;
  database: string;
  /** Arret propre (pg_ctl stop -m fast) - a appeler explicitement a la fermeture de l'app. */
  stop: () => Promise<void>;
}

/**
 * Point d'entree unique pour le mode standalone (DATABASE_MODE=portable) :
 * initialise le cluster si besoin (une seule fois), le demarre, et retourne
 * l'URL de connexion a injecter dans process.env.DATABASE_URL avant que
 * Prisma ne soit instancie. Voir src/index.ts pour le sequencement complet.
 *
 * Le mode reseau (Lot 6) reutilisera startPortablePostgres/stopPortablePostgres
 * directement sur le poste serveur, avec un host different (0.0.0.0 ou l'IP
 * LAN plutot que 127.0.0.1) - cette fonction reste specifique au cas
 * mono-poste (host toujours local).
 */
export async function bootstrapPortableDatabase(): Promise<PortableDatabaseHandle> {
  const { host, port, database } = portableSettingsFromEnv();
  const binDir = pgBinDir();
  const dataDir = pgDataDir();
  const logFile = pgLogFile();

  const credentials = await ensureClusterInitialized({ binDir, dataDir, logFile, host, port, database });
  await startPortablePostgres({ binDir, dataDir, logFile, host, port });

  return {
    databaseUrl: buildDatabaseUrl(credentials),
    host,
    port,
    database,
    stop: () => stopPortablePostgres({ binDir, dataDir, logFile }),
  };
}
