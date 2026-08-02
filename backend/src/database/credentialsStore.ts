import crypto from "node:crypto";
import fs from "node:fs";
import { execFileSync } from "node:child_process";
import { credentialsFilePath, secretsDir } from "./portablePaths";

/**
 * Identifiants Postgres generes une seule fois, a la premiere
 * initialisation du cluster portable (voir initCluster.ts), et reutilises
 * a chaque demarrage suivant. Jamais en dur dans le code, jamais commis,
 * jamais logges (voir README-LOT2.md).
 */
export interface PortablePostgresCredentials {
  version: 1;
  generatedAt: string;
  host: string;
  port: number;
  database: string;
  /** Superutilisateur cree par initdb - utilise uniquement pour le provisionnement (creation role/base/extension), jamais par l'app au quotidien. */
  superuser: string;
  superuserPassword: string;
  /** Role applicatif dedie, proprietaire de la base - utilise par Prisma via DATABASE_URL. */
  appUser: string;
  appUserPassword: string;
}

function generateSecret(): string {
  // 24 octets aleatoires -> ~32 caracteres base64url, sans caracteres
  // problematiques pour une URL de connexion ou une ligne de commande.
  return crypto.randomBytes(24).toString("base64url");
}

export function credentialsExist(): boolean {
  return fs.existsSync(credentialsFilePath());
}

export function loadCredentials(): PortablePostgresCredentials {
  const raw = fs.readFileSync(credentialsFilePath(), "utf8");
  return JSON.parse(raw) as PortablePostgresCredentials;
}

/**
 * Restreint le fichier d'identifiants a l'utilisateur Windows courant
 * (equivalent de chmod 600). Best-effort : icacls n'est pas garanti present
 * sur toutes les configurations (ex: Windows tres allege) ; un echec ici ne
 * doit pas empecher l'app de demarrer, juste etre signale.
 */
function restrictFilePermissions(filePath: string): void {
  if (process.platform === "win32") {
    try {
      execFileSync("icacls", [filePath, "/inheritance:r", "/grant:r", `${process.env.USERNAME}:F`], {
        stdio: "pipe",
      });
    } catch (error) {
      console.warn(
        `[postgres-credentials] impossible de restreindre les permissions de ${filePath} via icacls (ignore) :`,
        error instanceof Error ? error.message : error
      );
    }
  } else {
    try {
      fs.chmodSync(filePath, 0o600);
    } catch (error) {
      console.warn(`[postgres-credentials] impossible de restreindre les permissions de ${filePath} (ignore).`, error);
    }
  }
}

export function generateAndStoreCredentials(settings: {
  host: string;
  port: number;
  database: string;
}): PortablePostgresCredentials {
  const credentials: PortablePostgresCredentials = {
    version: 1,
    generatedAt: new Date().toISOString(),
    host: settings.host,
    port: settings.port,
    database: settings.database,
    superuser: "aurore_superadmin",
    superuserPassword: generateSecret(),
    appUser: "aurore_app",
    appUserPassword: generateSecret(),
  };

  fs.mkdirSync(secretsDir(), { recursive: true });
  const filePath = credentialsFilePath();
  fs.writeFileSync(filePath, JSON.stringify(credentials, null, 2), { mode: 0o600 });
  restrictFilePermissions(filePath);

  console.log(
    `[postgres-credentials] identifiants generes et stockes dans ${filePath} (utilisateur applicatif : ${credentials.appUser}).`
  );
  return credentials;
}

export function buildDatabaseUrl(credentials: PortablePostgresCredentials): string {
  const user = encodeURIComponent(credentials.appUser);
  const password = encodeURIComponent(credentials.appUserPassword);
  return `postgresql://${user}:${password}@${credentials.host}:${credentials.port}/${credentials.database}?schema=public`;
}
