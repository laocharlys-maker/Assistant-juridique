import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { secretsDir } from "../database/portablePaths";

/**
 * SESSION_SECRET propre a une installation portable (Lot 8), genere une
 * seule fois puis reutilise - meme raisonnement et meme dossier protege que
 * la cle de chiffrement (encryptionAtRest.ts) et les identifiants Postgres
 * (credentialsStore.ts) : jamais commis, jamais partage entre
 * installations. Ne s'applique qu'en DATABASE_MODE=portable (voir
 * index.ts) - le mode "externe" (VPS) continue d'exiger SESSION_SECRET
 * dans .env comme avant ce lot, sans changement.
 *
 * Necessaire car config/env.ts valide SESSION_SECRET de facon stricte
 * (min 16 caracteres) des l'import du module : sans .env livre avec
 * l'installeur (impossible - il contiendrait un secret partage par tous
 * les cabinets, commis nulle part), l'app ne demarrait plus du tout.
 */

interface SessionSecretFile {
  version: 1;
  generatedAt: string;
  secret: string;
}

function sessionSecretFilePath(): string {
  return path.join(secretsDir(), "session-secret.json");
}

/** Meme logique que credentialsStore.ts / encryptionAtRest.ts - dupliquee volontairement (chaque module de secrets reste autonome). */
function restrictFilePermissions(filePath: string): void {
  if (process.platform === "win32") {
    try {
      execFileSync("icacls", [filePath, "/inheritance:r", "/grant:r", `${process.env.USERNAME}:F`], {
        stdio: "pipe",
      });
    } catch (error) {
      console.warn(
        `[session-secret] impossible de restreindre les permissions de ${filePath} via icacls (ignore) :`,
        error instanceof Error ? error.message : error
      );
    }
  } else {
    try {
      fs.chmodSync(filePath, 0o600);
    } catch (error) {
      console.warn(`[session-secret] impossible de restreindre les permissions de ${filePath} (ignore).`, error);
    }
  }
}

export function loadOrCreateSessionSecret(): string {
  const filePath = sessionSecretFilePath();
  if (fs.existsSync(filePath)) {
    const parsed = JSON.parse(fs.readFileSync(filePath, "utf8")) as SessionSecretFile;
    return parsed.secret;
  }

  const secret = crypto.randomBytes(32).toString("base64url");
  const payload: SessionSecretFile = {
    version: 1,
    generatedAt: new Date().toISOString(),
    secret,
  };
  fs.mkdirSync(secretsDir(), { recursive: true });
  fs.writeFileSync(filePath, JSON.stringify(payload, null, 2), { mode: 0o600 });
  restrictFilePermissions(filePath);
  console.log(`[session-secret] SESSION_SECRET genere pour cette installation (${filePath}).`);
  return secret;
}
