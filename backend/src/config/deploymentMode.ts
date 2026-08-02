import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { userDataDir } from "../database/portablePaths";

/**
 * Mode de deploiement (Lot 6) : "standalone" (poste unique, bind
 * 127.0.0.1, HTTP - comportement inchange depuis les Lots 1/2) ou "reseau"
 * (serveur LAN, bind 0.0.0.0, HTTPS - voir index.ts et
 * security/localTlsCertificate.ts). Concerne uniquement le mode desktop
 * (DATABASE_MODE=portable, sidecar Tauri ou service NSSM) - le mode
 * "externe" (VPS actuel) ignore ce module entierement, comportement
 * inchange (voir index.ts).
 *
 * Module volontairement isole (lecture/ecriture de config + detection
 * reseau, aucun acces DB/Express) pour rester testable independamment du
 * reste du demarrage serveur - bonne pratique demandee par le prompt.
 */

export type DeploymentMode = "standalone" | "reseau";

export interface DeploymentConfig {
  /** null = jamais choisi explicitement par l'utilisateur - l'ecran
   * setup-mode.html doit alors s'afficher, et le binding reseau doit
   * rester sur la valeur la plus sure ("standalone") en attendant. */
  deploymentMode: DeploymentMode | null;
  setupCompletedAt: string | null;
}

const DEFAULT_CONFIG: DeploymentConfig = { deploymentMode: null, setupCompletedAt: null };

function configFilePath(): string {
  return path.join(userDataDir(), "config.json");
}

export function readDeploymentConfig(): DeploymentConfig {
  try {
    const raw = fs.readFileSync(configFilePath(), "utf8");
    const parsed = JSON.parse(raw) as Partial<DeploymentConfig>;
    const mode = parsed.deploymentMode === "reseau" || parsed.deploymentMode === "standalone" ? parsed.deploymentMode : null;
    return {
      deploymentMode: mode,
      setupCompletedAt: typeof parsed.setupCompletedAt === "string" ? parsed.setupCompletedAt : null,
    };
  } catch {
    // Fichier absent (premier lancement) ou illisible/corrompu : traite
    // comme "jamais configure", jamais comme une erreur bloquante - voir
    // effectiveDeploymentMode() pour le repli securise associe.
    return { ...DEFAULT_CONFIG };
  }
}

export function writeDeploymentMode(mode: DeploymentMode): DeploymentConfig {
  const config: DeploymentConfig = { deploymentMode: mode, setupCompletedAt: new Date().toISOString() };
  fs.mkdirSync(userDataDir(), { recursive: true });
  fs.writeFileSync(configFilePath(), JSON.stringify(config, null, 2));
  console.log(`[deploiement] mode enregistre : "${mode}".`);
  return config;
}

/**
 * Mode effectif a utiliser pour le binding reseau. Repli SECURISE explicite
 * sur "standalone" (127.0.0.1) si jamais configure - jamais "reseau" par
 * defaut, meme si le fichier de config est absent/corrompu. C'est la seule
 * fonction que index.ts doit appeler pour decider du binding.
 */
export function effectiveDeploymentMode(): DeploymentMode {
  const config = readDeploymentConfig();
  return config.deploymentMode === "reseau" ? "reseau" : "standalone";
}

export function isSetupComplete(): boolean {
  return readDeploymentConfig().deploymentMode !== null;
}

// ============================================================================
// Detection de l'adresse LAN locale (utilisee par networkInfo.ts,
// mdnsAdvertise.ts et localTlsCertificate.ts - une seule implementation,
// jamais dupliquee entre ces trois modules).
// ============================================================================

export interface LocalNetworkAddress {
  address: string;
  interfaceName: string;
}

/** Motifs de noms d'interfaces reseau typiquement virtuelles/VPN, a
 * deprioriser (jamais exclure completement : mieux vaut afficher une IP
 * "probablement VPN" que de n'en afficher aucune si c'est la seule
 * interface disponible). Casse ignoree. */
const INTERFACE_NAME_DEPRIORITISE_PATTERNS = [
  /vpn/i,
  /tailscale/i,
  /wireguard/i,
  /zerotier/i,
  /tap/i,
  /tun/i,
  /vethernet/i,
  /virtualbox/i,
  /vmware/i,
  /hyper-v/i,
  /loopback/i,
  /bluetooth/i,
];

function isPrivateIPv4(address: string): boolean {
  const parts = address.split(".").map(Number);
  if (parts.length !== 4 || parts.some((n) => Number.isNaN(n))) return false;
  const [a, b] = parts;
  // RFC 1918 : 10.0.0.0/8, 172.16.0.0/12, 192.168.0.0/16.
  if (a === 10) return true;
  if (a === 172 && b >= 16 && b <= 31) return true;
  if (a === 192 && b === 168) return true;
  return false;
}

/**
 * Detecte l'adresse IPv4 privee (RFC 1918) de l'interface LAN/WiFi la plus
 * plausible - privilegie une interface dont le nom ne ressemble pas a un
 * adaptateur VPN/virtuel courant (voir INTERFACE_NAME_DEPRIORITISE_PATTERNS),
 * pour eviter d'afficher l'IP d'un VPN actif plutot que celle du reseau du
 * cabinet (voir README-LOT6.md "Detection IP"). Retourne null si aucune
 * interface privee n'est trouvee (machine sans reseau local, ou uniquement
 * des interfaces publiques/inhabituelles).
 */
export function getLocalNetworkAddress(): LocalNetworkAddress | null {
  const interfaces = os.networkInterfaces();
  const candidatsPrivilegies: LocalNetworkAddress[] = [];
  const candidatsRepli: LocalNetworkAddress[] = [];

  for (const [interfaceName, addresses] of Object.entries(interfaces)) {
    if (!addresses) continue;
    for (const addr of addresses) {
      if (addr.family !== "IPv4" || addr.internal) continue;
      if (!isPrivateIPv4(addr.address)) continue;

      const candidat: LocalNetworkAddress = { address: addr.address, interfaceName };
      const ressembleVirtuel = INTERFACE_NAME_DEPRIORITISE_PATTERNS.some((pattern) => pattern.test(interfaceName));
      (ressembleVirtuel ? candidatsRepli : candidatsPrivilegies).push(candidat);
    }
  }

  return candidatsPrivilegies[0] ?? candidatsRepli[0] ?? null;
}
