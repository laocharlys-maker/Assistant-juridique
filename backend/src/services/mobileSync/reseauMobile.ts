import os from "node:os";
import { getAllPrivateIPv4Addresses, isPrivateIPv4 } from "../../config/deploymentMode";

/**
 * Liste TOUTES les adresses IPv4 locales candidates (contrairement a
 * getLocalNetworkAddress() de config/deploymentMode.ts, qui n'en retient
 * qu'une) - utilisee pour composer le champ "adresses" du QR d'appairage
 * (le telephone essaie chaque adresse jusqu'a trouver celle qui repond,
 * voir docs/lot10/01-protocole.md section 3.1). Filtree sur
 * `interfaceChoisie` (Cabinet.mobileSyncInterface) si renseignee.
 */
export function listerAdressesLocales(interfaceChoisie: string | null): string[] {
  // Aucune interface choisie : uniquement les cartes réelles (Wi-Fi, Ethernet).
  // Les cartes virtuelles (Hyper-V/WSL, VirtualBox, VPN...) ne sont pas
  // joignables depuis le téléphone ; chaque adresse inutile dans le QR
  // allongeait l'attente avant "Aurore introuvable" (voir aussi le délai
  // maximal par adresse dans mobile/src/pairing/appareil.ts).
  if (!interfaceChoisie) return getAllPrivateIPv4Addresses();

  const interfaces = os.networkInterfaces();
  const adresses: string[] = [];
  for (const [nomInterface, infos] of Object.entries(interfaces)) {
    if (!infos) continue;
    for (const info of infos) {
      if (info.family !== "IPv4" || info.internal) continue;
      if (!isPrivateIPv4(info.address)) continue;
      if (interfaceChoisie && info.address !== interfaceChoisie && nomInterface !== interfaceChoisie) continue;
      adresses.push(info.address);
    }
  }
  return adresses;
}
