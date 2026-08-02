import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { secretsDir } from "../database/portablePaths";

const execFileAsync = promisify(execFile);

/**
 * Empreinte machine (Lot 3) : identifie la machine sur laquelle Aurore
 * tourne, pour lier une licence a un poste precis. Choix technique :
 * lecture directe de l'UUID materiel via PowerShell/registre Windows
 * (et equivalents Linux/macOS), plutot que la dependance `node-machine-id`
 * suggeree en alternative par le prompt - le projet evite deliberement les
 * dependances tierces evitables (meme choix que le chiffrement au repos du
 * Lot 2bis, `node:crypto` natif plutot qu'une lib). La lecture reste
 * volontairement tres simple (une poignee de lignes par plateforme) ; voir
 * README-LOT3.md pour le detail de ce choix.
 *
 * IMPORTANT : l'identifiant materiel brut n'est JAMAIS stocke ni logue - il
 * est immediatement hashe en SHA-256, et seul ce hash est conserve/expose.
 */

function fingerprintFilePath(): string {
  return path.join(secretsDir(), "machine-fingerprint.json");
}

interface FingerprintFile {
  version: 1;
  generatedAt: string;
  fingerprint: string;
}

let cachedFingerprint: string | null = null;

function sha256Hex(value: string): string {
  return crypto.createHash("sha256").update(value, "utf8").digest("hex");
}

/** Lit l'identifiant materiel brut, specifique a la plateforme. Ne doit
 * JAMAIS etre logue ni renvoye tel quel a l'appelant - uniquement passe a
 * sha256Hex(). Leve si aucune source n'a fonctionne (l'appelant retombe sur
 * un identifiant de secours moins stable, voir readRawMachineIdentifier). */
async function readPlatformIdentifier(): Promise<string> {
  if (process.platform === "win32") {
    try {
      const { stdout } = await execFileAsync("powershell", [
        "-NoProfile",
        "-NonInteractive",
        "-Command",
        "(Get-CimInstance -ClassName Win32_ComputerSystemProduct).UUID",
      ]);
      const uuid = stdout.trim();
      if (uuid) return uuid;
    } catch {
      // Repli sur le registre ci-dessous.
    }
    // MachineGuid : identifiant genere par Windows lui-meme a l'installation
    // (distinct de l'UUID materiel, mais tout aussi stable et unique par
    // machine) - repli si Get-CimInstance echoue (droits restreints,
    // PowerShell absent...).
    const { stdout } = await execFileAsync("reg", [
      "query",
      "HKLM\\SOFTWARE\\Microsoft\\Cryptography",
      "/v",
      "MachineGuid",
    ]);
    const match = stdout.match(/MachineGuid\s+REG_SZ\s+(\S+)/);
    if (match) return match[1];
    throw new Error("MachineGuid introuvable dans la sortie de reg query");
  }

  if (process.platform === "darwin") {
    const { stdout } = await execFileAsync("ioreg", ["-rd1", "-c", "IOPlatformExpertDevice"]);
    const match = stdout.match(/"IOPlatformUUID"\s*=\s*"([^"]+)"/);
    if (match) return match[1];
    throw new Error("IOPlatformUUID introuvable dans la sortie de ioreg");
  }

  // Linux (pertinent pour le mode reseau du Lot 6, serveur cabinet sous
  // Linux) : identifiant standard systemd/dbus, stable par installation.
  for (const candidate of ["/etc/machine-id", "/var/lib/dbus/machine-id"]) {
    try {
      const content = fs.readFileSync(candidate, "utf8").trim();
      if (content) return content;
    } catch {
      // Tente le candidat suivant.
    }
  }
  throw new Error("Aucun identifiant machine trouve (/etc/machine-id, /var/lib/dbus/machine-id)");
}

/** Identifiant de secours si aucune source materielle n'est lisible (droits
 * insuffisants, plateforme inattendue) - moins stable en theorie (le nom de
 * la machine peut changer), mais evite un blocage total plutot que de ne
 * jamais pouvoir calculer d'empreinte du tout. */
function fallbackIdentifier(): string {
  console.warn(
    "[machine-fingerprint] impossible de lire un identifiant materiel stable - repli sur hostname/plateforme " +
      "(moins fiable, voir README-LOT3.md)."
  );
  return `fallback:${os.hostname()}:${os.platform()}:${os.arch()}`;
}

function readCachedFingerprint(): string | null {
  try {
    const raw = fs.readFileSync(fingerprintFilePath(), "utf8");
    const parsed = JSON.parse(raw) as FingerprintFile;
    if (typeof parsed.fingerprint === "string" && /^[0-9a-f]{64}$/.test(parsed.fingerprint)) {
      return parsed.fingerprint;
    }
  } catch {
    // Pas encore genere, ou fichier illisible - recalcul plus bas.
  }
  return null;
}

function persistFingerprint(fingerprint: string): void {
  try {
    fs.mkdirSync(secretsDir(), { recursive: true });
    const payload: FingerprintFile = { version: 1, generatedAt: new Date().toISOString(), fingerprint };
    fs.writeFileSync(fingerprintFilePath(), JSON.stringify(payload, null, 2), { mode: 0o600 });
  } catch (error) {
    // Non bloquant : l'empreinte sera simplement recalculee au prochain
    // appel si elle n'a pas pu etre mise en cache.
    console.warn("[machine-fingerprint] impossible de mettre en cache l'empreinte (recalcul au prochain demarrage).", error instanceof Error ? error.message : error);
  }
}

/**
 * Calcule (ou relit depuis le cache local) l'empreinte SHA-256 de cette
 * machine. Stable dans le temps sur une meme machine (l'identifiant
 * materiel source ne change pas au redemarrage), differente entre deux
 * machines. Ne journalise jamais l'identifiant brut - uniquement un
 * booleen de succes.
 */
export async function getMachineFingerprint(): Promise<string> {
  if (cachedFingerprint) return cachedFingerprint;

  const fromDisk = readCachedFingerprint();
  if (fromDisk) {
    cachedFingerprint = fromDisk;
    return cachedFingerprint;
  }

  let raw: string;
  try {
    raw = await readPlatformIdentifier();
  } catch (error) {
    console.warn(
      "[machine-fingerprint] lecture de l'identifiant materiel echouee, repli active.",
      error instanceof Error ? error.message : error
    );
    raw = fallbackIdentifier();
  }

  const fingerprint = sha256Hex(raw);
  persistFingerprint(fingerprint);
  console.log("[machine-fingerprint] empreinte machine prete (calculee: true).");
  cachedFingerprint = fingerprint;
  return cachedFingerprint;
}
