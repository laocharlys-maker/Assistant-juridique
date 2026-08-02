import fs from "node:fs";
import path from "node:path";
import { X509Certificate } from "node:crypto";
import { execFileSync } from "node:child_process";
import { generate } from "selfsigned";
import { secretsDir } from "../database/portablePaths";
import { getLocalNetworkAddress } from "../config/deploymentMode";

/**
 * Certificat TLS auto-signe pour le mode serveur reseau (Lot 6). Genere une
 * seule fois (reutilise tant qu'il couvre toujours l'IP locale actuelle et
 * n'expire pas bientot - voir ensureLocalTlsCertificate), stocke dans le
 * meme dossier protege que les autres secrets (identifiants Postgres, cle
 * de chiffrement, cle de licence - voir database/portablePaths.ts).
 *
 * Choix technique : `selfsigned` (pure JS, aucune dependance a un binaire
 * `openssl` externe - non garanti present sur un poste Windows) plutot que
 * `node:crypto` seul - Node fournit `X509Certificate` pour LIRE un
 * certificat (utilise ci-dessous pour verifier sa date d'expiration) mais
 * aucune API pour en GENERER un ; reconstruire l'ASN.1 X.509 a la main
 * serait une reimplementation non justifiee de ce que `selfsigned` fait
 * deja correctement. Voir README-LOT6.md.
 */

export interface LocalTlsCertificate {
  key: string;
  cert: string;
  certPath: string;
  keyPath: string;
}

// Cert local importe manuellement (jamais chaine a une autorite
// publiquement approuvee) : pas soumis a la limite de validite de ~397
// jours imposee par les navigateurs aux certificats publics - on choisit
// une duree large pour eviter un renouvellement frequent. Voir
// README-LOT6.md "Certificat expire".
const CERT_VALIDITY_DAYS = 730;
const RENEW_MARGIN_DAYS = 30;

function tlsDir(): string {
  return path.join(secretsDir(), "tls");
}
function certFilePath(): string {
  return path.join(tlsDir(), "aurore-cert.pem");
}
function keyFilePath(): string {
  return path.join(tlsDir(), "aurore-key.pem");
}
/** Trace l'IP locale utilisee au moment de la generation - permet de
 * detecter qu'un changement de reseau (nouvelle box, nouvelle plage DHCP)
 * rend le certificat existant incomplet pour la nouvelle adresse, et donc
 * qu'il faut en regenerer un plutot que de garder silencieusement un
 * certificat qui ne couvre plus la bonne IP (voir README-LOT6.md
 * "Resilience reseau"). */
function metaFilePath(): string {
  return path.join(tlsDir(), "aurore-cert-meta.json");
}

interface CertMeta {
  localIp: string | null;
  generatedAt: string;
}

function restrictFilePermissions(filePath: string): void {
  if (process.platform === "win32") {
    try {
      execFileSync("icacls", [filePath, "/inheritance:r", "/grant:r", `${process.env.USERNAME}:F`], {
        stdio: "pipe",
      });
    } catch (error) {
      console.warn(
        `[tls] impossible de restreindre les permissions de ${filePath} via icacls (ignore) :`,
        error instanceof Error ? error.message : error
      );
    }
  } else {
    try {
      fs.chmodSync(filePath, 0o600);
    } catch (error) {
      console.warn(`[tls] impossible de restreindre les permissions de ${filePath} (ignore).`, error);
    }
  }
}

function readExistingIfStillValid(currentLocalIp: string | null): LocalTlsCertificate | null {
  try {
    const certPem = fs.readFileSync(certFilePath(), "utf8");
    const keyPem = fs.readFileSync(keyFilePath(), "utf8");
    const meta = JSON.parse(fs.readFileSync(metaFilePath(), "utf8")) as CertMeta;

    if (meta.localIp !== currentLocalIp) {
      console.log(
        "[tls] l'adresse IP locale a change depuis la generation du certificat existant - regeneration necessaire."
      );
      return null;
    }

    const x509 = new X509Certificate(certPem);
    const validTo = new Date(x509.validTo).getTime();
    const renewBefore = validTo - RENEW_MARGIN_DAYS * 24 * 60 * 60 * 1000;
    if (Date.now() >= renewBefore) {
      console.log("[tls] le certificat existant expire bientot (ou est deja expire) - regeneration.");
      return null;
    }

    return { key: keyPem, cert: certPem, certPath: certFilePath(), keyPath: keyFilePath() };
  } catch {
    // Absent au premier lancement, ou illisible/corrompu - generation
    // normale ci-dessous dans les deux cas.
    return null;
  }
}

/**
 * Retourne un certificat TLS local valide pour l'IP actuelle et
 * "aurore.local", en generant un nouveau certificat si necessaire (absent,
 * expire bientot, ou IP locale changee depuis la derniere generation).
 * Jamais de duplication de logique de detection reseau (reutilise
 * getLocalNetworkAddress() de config/deploymentMode.ts).
 */
export async function ensureLocalTlsCertificate(): Promise<LocalTlsCertificate> {
  const localIp = getLocalNetworkAddress()?.address ?? null;

  const existing = readExistingIfStillValid(localIp);
  if (existing) {
    console.log("[tls] certificat local existant reutilise (valide, couvre l'adresse actuelle).");
    return existing;
  }

  console.log(
    `[tls] generation d'un nouveau certificat TLS local (validite ${CERT_VALIDITY_DAYS} jours)${
      localIp ? `, pour l'IP ${localIp} et aurore.local` : ", pour aurore.local uniquement (aucune IP LAN detectee)"
    }...`
  );

  const altNames: Array<{ type: 2 | 7; value?: string; ip?: string }> = [
    { type: 2, value: "aurore.local" },
    { type: 2, value: "localhost" },
    { type: 7, ip: "127.0.0.1" },
  ];
  if (localIp) altNames.push({ type: 7, ip: localIp });

  const notBeforeDate = new Date();
  const notAfterDate = new Date(notBeforeDate.getTime() + CERT_VALIDITY_DAYS * 24 * 60 * 60 * 1000);

  const pems = await generate([{ name: "commonName", value: "aurore.local" }], {
    algorithm: "sha256",
    notBeforeDate,
    notAfterDate,
    keySize: 2048,
    extensions: [
      { name: "basicConstraints", cA: false },
      { name: "keyUsage", digitalSignature: true, keyEncipherment: true },
      { name: "extKeyUsage", serverAuth: true },
      { name: "subjectAltName", altNames },
    ],
  });

  fs.mkdirSync(tlsDir(), { recursive: true });
  fs.writeFileSync(certFilePath(), pems.cert, { mode: 0o600 });
  fs.writeFileSync(keyFilePath(), pems.private, { mode: 0o600 });
  const meta: CertMeta = { localIp, generatedAt: new Date().toISOString() };
  fs.writeFileSync(metaFilePath(), JSON.stringify(meta, null, 2));
  restrictFilePermissions(keyFilePath());

  console.log(
    `[tls] certificat genere (${certFilePath()}) - a distribuer aux postes clients pour eviter l'avertissement de securite, voir installer/import-cert-instructions.md.`
  );

  return { key: pems.private, cert: pems.cert, certPath: certFilePath(), keyPath: keyFilePath() };
}
