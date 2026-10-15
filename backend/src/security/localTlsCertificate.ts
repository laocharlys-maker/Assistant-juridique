import fs from "node:fs";
import path from "node:path";
import { X509Certificate } from "node:crypto";
import { execFileSync } from "node:child_process";
import { generate } from "selfsigned";
import { secretsDir } from "../database/portablePaths";
import { getAllPrivateIPv4Addresses, getTailscaleAddress } from "../config/deploymentMode";

/**
 * Certificat TLS auto-signe pour le mode serveur reseau (Lot 6). Genere une
 * seule fois (reutilise tant qu'il couvre toutes les IP locales actuelles et
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
  // Toutes les IP privees couvertes a la generation (informatif : la
  // decision de regenerer s'appuie sur le certificat lui-meme, voir
  // readExistingIfStillValid). `localIp` conserve pour les anciens meta.
  localIps?: string[];
  localIp?: string | null;
  // Facultatif : absent sur un certificat genere avant l'ajout de ce champ -
  // voir readExistingIfStillValid (normalise a null via `?? null`, jamais
  // une regeneration inutile pour un poste qui n'utilise pas Tailscale).
  tailscaleIp?: string | null;
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

function readExistingIfStillValid(currentIps: string[]): LocalTlsCertificate | null {
  try {
    const certPem = fs.readFileSync(certFilePath(), "utf8");
    const keyPem = fs.readFileSync(keyFilePath(), "utf8");
    const x509 = new X509Certificate(certPem);

    // Regeneration uniquement si une adresse ACTUELLE n'est pas couverte par
    // le certificat existant. Un simple changement d'ordre des cartes reseau,
    // ou la disparition d'une adresse (hotspot deconnecte), ne doit jamais
    // invalider un certificat deja installe sur les postes clients.
    const nonCouvertes = currentIps.filter((ip) => !x509.checkIP(ip));
    if (nonCouvertes.length > 0) {
      console.log(
        `[tls] adresse(s) non couverte(s) par le certificat existant (${nonCouvertes.join(", ")}) - regeneration necessaire.`
      );
      return null;
    }

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
 * Retourne un certificat TLS local valide pour l'IP actuelle, l'adresse
 * Tailscale actuelle (si Tailscale est installe et connecte - voir
 * getTailscaleAddress ci-dessous, accès distant hors du réseau du cabinet)
 * et "aurore.local", en generant un nouveau certificat si necessaire
 * (absent, expire bientot, ou IP locale/Tailscale changee depuis la
 * derniere generation). Jamais de duplication de logique de detection
 * reseau (reutilise getLocalNetworkAddress()/getTailscaleAddress() de
 * config/deploymentMode.ts).
 */
export async function ensureLocalTlsCertificate(): Promise<LocalTlsCertificate> {
  const localIps = getAllPrivateIPv4Addresses();
  const tailscaleIp = getTailscaleAddress();

  const existing = readExistingIfStillValid(tailscaleIp ? [...localIps, tailscaleIp] : localIps);
  if (existing) {
    console.log("[tls] certificat local existant reutilise (valide, couvre l'adresse actuelle).");
    return existing;
  }

  console.log(
    `[tls] generation d'un nouveau certificat TLS local (validite ${CERT_VALIDITY_DAYS} jours)${
      localIps.length > 0
        ? `, pour les IP ${localIps.join(", ")} et aurore.local`
        : ", pour aurore.local uniquement (aucune IP LAN detectee)"
    }${tailscaleIp ? `, ainsi que l'adresse Tailscale ${tailscaleIp}` : ""}...`
  );

  const altNames: Array<{ type: 2 | 7; value?: string; ip?: string }> = [
    { type: 2, value: "aurore.local" },
    { type: 2, value: "localhost" },
    { type: 7, ip: "127.0.0.1" },
  ];
  for (const ip of localIps) altNames.push({ type: 7, ip });
  if (tailscaleIp) altNames.push({ type: 7, ip: tailscaleIp });

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
  const meta: CertMeta = { localIps, tailscaleIp, generatedAt: new Date().toISOString() };
  fs.writeFileSync(metaFilePath(), JSON.stringify(meta, null, 2));
  restrictFilePermissions(keyFilePath());

  console.log(
    `[tls] certificat genere (${certFilePath()}) - a distribuer aux postes clients pour eviter l'avertissement de securite, voir installer/import-cert-instructions.md.`
  );

  return { key: pems.private, cert: pems.cert, certPath: certFilePath(), keyPath: keyFilePath() };
}
