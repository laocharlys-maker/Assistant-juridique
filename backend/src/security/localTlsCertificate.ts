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
  /** Autorite locale Aurore (a importer UNE FOIS sur chaque poste client). */
  caCertPath: string;
}

// Cert local importe manuellement (jamais chaine a une autorite
// publiquement approuvee) : pas soumis a la limite de validite de ~397
// jours imposee par les navigateurs aux certificats publics - on choisit
// une duree large pour eviter un renouvellement frequent. Voir
// README-LOT6.md "Certificat expire".
const CERT_VALIDITY_DAYS = 730;
const RENEW_MARGIN_DAYS = 30;
// Autorite de certification locale (Aurore) : generee UNE SEULE FOIS, c'est
// elle (et non le certificat du serveur) que les postes clients importent.
// Le certificat du serveur, signe par elle, peut alors etre regenere a
// volonte (nouvelle IP, expiration) sans aucune action sur les postes.
const CA_VALIDITY_DAYS = 3650;
const CA_RENEW_MARGIN_DAYS = 90;

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
function caCertFilePath(): string {
  return path.join(tlsDir(), "aurore-ca.pem");
}
function caKeyFilePath(): string {
  return path.join(tlsDir(), "aurore-ca-key.pem");
}
/** Copie de l'autorite avec l'extension .crt : Windows ouvre l'assistant
 * d'import sur un .crt (pas sur un .pem). Meme contenu, aucune cle privee. */
function caCrtFilePath(): string {
  return path.join(tlsDir(), "aurore-ca.crt");
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

interface CaPair {
  key: string;
  cert: string;
}

function daysFromNow(days: number): number {
  return Date.now() + days * 24 * 60 * 60 * 1000;
}

/** Autorite existante si lisible et pas proche de l'expiration, sinon null. */
function readExistingCa(): CaPair | null {
  try {
    const cert = fs.readFileSync(caCertFilePath(), "utf8");
    const key = fs.readFileSync(caKeyFilePath(), "utf8");
    const x509 = new X509Certificate(cert);
    if (new Date(x509.validTo).getTime() <= daysFromNow(CA_RENEW_MARGIN_DAYS)) return null;
    return { key, cert };
  } catch {
    return null;
  }
}

async function ensureCa(): Promise<CaPair> {
  const existing = readExistingCa();
  if (existing) return existing;

  console.log("[tls] generation de l'autorite de certification locale Aurore (a importer une fois sur chaque poste).");
  const notBeforeDate = new Date();
  const notAfterDate = new Date(daysFromNow(CA_VALIDITY_DAYS));
  const pems = await generate([{ name: "commonName", value: "Aurore - Autorite locale" }], {
    algorithm: "sha256",
    notBeforeDate,
    notAfterDate,
    keySize: 2048,
    extensions: [
      { name: "basicConstraints", cA: true, critical: true },
      { name: "keyUsage", keyCertSign: true, cRLSign: true, critical: true },
    ],
  });
  fs.mkdirSync(tlsDir(), { recursive: true });
  fs.writeFileSync(caCertFilePath(), pems.cert, { mode: 0o600 });
  fs.writeFileSync(caCrtFilePath(), pems.cert, { mode: 0o600 });
  fs.writeFileSync(caKeyFilePath(), pems.private, { mode: 0o600 });
  restrictFilePermissions(caKeyFilePath());
  return { key: pems.private, cert: pems.cert };
}

function readExistingIfStillValid(currentIps: string[], ca: CaPair): LocalTlsCertificate | null {
  try {
    const certPem = fs.readFileSync(certFilePath(), "utf8");
    const keyPem = fs.readFileSync(keyFilePath(), "utf8");
    const x509 = new X509Certificate(certPem);

    // Un certificat serveur d'une version anterieure (auto-signe) ou signe
    // par une ancienne autorite n'est pas approuve par les postes qui
    // importent l'autorite actuelle : on le remplace.
    if (!x509.verify(new X509Certificate(ca.cert).publicKey)) {
      console.log("[tls] le certificat existant n'est pas signe par l'autorite locale actuelle - regeneration necessaire.");
      return null;
    }

    // Regeneration uniquement si une adresse ACTUELLE n'est pas couverte par
    // le certificat existant. Un simple changement d'ordre des cartes reseau,
    // ou la disparition d'une adresse (hotspot deconnecte), ne regenere rien.
    // Meme alors, les postes clients n'ont rien a refaire : ils font
    // confiance a l'autorite, pas au certificat du serveur.
    const nonCouvertes = currentIps.filter((ip) => !x509.checkIP(ip));
    if (nonCouvertes.length > 0) {
      console.log(
        `[tls] adresse(s) non couverte(s) par le certificat existant (${nonCouvertes.join(", ")}) - regeneration necessaire.`
      );
      return null;
    }

    if (new Date(x509.validTo).getTime() <= daysFromNow(RENEW_MARGIN_DAYS)) {
      console.log("[tls] le certificat existant expire bientot (ou est deja expire) - regeneration.");
      return null;
    }

    return { key: keyPem, cert: certPem, certPath: certFilePath(), keyPath: keyFilePath(), caCertPath: caCertFilePath() };
  } catch {
    // Absent au premier lancement, ou illisible/corrompu - generation
    // normale ci-dessous dans les deux cas.
    return null;
  }
}

/**
 * Retourne un certificat TLS local valide pour toutes les IP privees
 * actuelles (hors cartes virtuelles), l'adresse Tailscale (si active) et
 * "aurore.local", SIGNE par l'autorite locale Aurore (creee au premier
 * lancement). Les postes clients importent l'autorite UNE SEULE FOIS
 * (aurore-ca.crt) ; le certificat serveur peut ensuite etre regenere
 * (nouvelle IP, expiration) sans aucune action sur les postes.
 */
export async function ensureLocalTlsCertificate(): Promise<LocalTlsCertificate> {
  const localIps = getAllPrivateIPv4Addresses();
  const tailscaleIp = getTailscaleAddress();

  const ca = await ensureCa();

  const existing = readExistingIfStillValid(tailscaleIp ? [...localIps, tailscaleIp] : localIps, ca);
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
  const notAfterDate = new Date(daysFromNow(CERT_VALIDITY_DAYS));

  const pems = await generate([{ name: "commonName", value: "aurore.local" }], {
    algorithm: "sha256",
    notBeforeDate,
    notAfterDate,
    keySize: 2048,
    ca: { key: ca.key, cert: ca.cert },
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
    `[tls] certificat genere. A importer UNE FOIS sur chaque poste client : ${caCrtFilePath()} (voir installer/import-cert-instructions.md).`
  );

  return { key: pems.private, cert: pems.cert, certPath: certFilePath(), keyPath: keyFilePath(), caCertPath: caCertFilePath() };
}
