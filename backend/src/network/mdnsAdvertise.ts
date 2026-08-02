import { Bonjour } from "bonjour-service";

/**
 * Publication mDNS (Lot 6) : rend le serveur joignable via
 * "https://aurore.local:PORT" en plus de l'IP brute, sans dependre d'un
 * service Bonjour/mDNSResponder natif du systeme (`bonjour-service`
 * implemente le protocole mDNS lui-meme en JS pur, via `multicast-dns`).
 *
 * Complement, jamais un remplacement : certains reseaux d'entreprise/
 * pare-feu bloquent le multicast mDNS (port UDP 5353) - l'IP brute affichee
 * par GET /api/network-info reste toujours la solution de secours
 * documentee (voir README-LOT6.md "aurore.local ne fonctionne pas").
 */

export const AURORE_LOCAL_HOSTNAME = "aurore.local";

export interface MdnsAdvertisement {
  stop: () => void;
}

/**
 * Publie "aurore.local" sur le reseau local pour le port donne. Ne leve
 * jamais - une erreur ici (mDNS bloque, pas de carte reseau active...) est
 * journalisee et retourne null, sans jamais empecher le demarrage du
 * serveur (l'IP brute continue de fonctionner dans tous les cas).
 */
export function advertiseAuroreLocal(port: number): MdnsAdvertisement | null {
  try {
    const bonjour = new Bonjour();
    const service = bonjour.publish({
      name: "Aurore",
      type: "https",
      port,
      host: AURORE_LOCAL_HOSTNAME,
    });
    service.start();

    console.log(`[mdns] "${AURORE_LOCAL_HOSTNAME}" publie sur le reseau local (port ${port}).`);

    return {
      stop: () => {
        try {
          bonjour.unpublishAll(() => bonjour.destroy());
        } catch (error) {
          console.warn("[mdns] erreur lors de l'arret de la publication (ignoree).", error instanceof Error ? error.message : error);
        }
      },
    };
  } catch (error) {
    console.warn(
      `[mdns] publication de "${AURORE_LOCAL_HOSTNAME}" impossible (l'IP brute reste utilisable) :`,
      error instanceof Error ? error.message : error
    );
    return null;
  }
}
