import { PrismaClient } from "@prisma/client";

/**
 * Lot 16 - suggestion de dossier par correspondance EXACTE de l'adresse
 * expediteur avec Client.email. Aucune correspondance approximative (nom,
 * domaine, distance textuelle...) : une suggestion erronee est plus grave
 * qu'une absence de suggestion, l'identite du client etant en jeu (voir
 * README-LOT16.md).
 *
 * Client.email est chiffre au repos (voir security/prismaEncryption.ts,
 * ENCRYPTED_FIELDS_BY_MODEL.Client.email) : un `WHERE email = ...` cote SQL
 * est impossible (le texte stocke est un ciphertext non deterministe, deux
 * chiffrements de la meme valeur produisent des octets differents - IV
 * aleatoire). La comparaison se fait donc ici, cote application, sur des
 * enregistrements dechiffres normalement via une lecture Prisma standard
 * (le dechiffrement est transparent, voir prismaEncryption.ts) - jamais de
 * filtre `email` dans un `where` Prisma pour ce modele.
 */

export interface DossierSuggere {
  id: string;
  numeroDossier: string;
  nomAffaire: string;
  clientNom: string;
}

interface ClientAvecDossiers {
  nom: string;
  email: string | null;
  dossiers: Array<{ id: string; numeroDossier: string; nomAffaire: string }>;
}

function normaliserEmail(email: string): string {
  return email.trim().toLowerCase();
}

/**
 * Fonction PURE (aucun acces DB - independamment testable, voir
 * __tests__/suggestionDossier.test.ts) : a partir d'une liste de clients
 * DEJA CHARGEE (dechiffree), renvoie les dossiers de ceux dont l'email
 * correspond exactement (apres normalisation trim + minuscules) a
 * l'expediteur. Un meme dossier n'apparait jamais deux fois, meme si
 * plusieurs fiches Client partagent le meme email.
 */
export function suggererDossiersPourExpediteur(
  clients: ClientAvecDossiers[],
  expediteurEmail: string
): DossierSuggere[] {
  if (!expediteurEmail) return [];
  const cible = normaliserEmail(expediteurEmail);
  const suggestions: DossierSuggere[] = [];
  const dejaVus = new Set<string>();
  for (const client of clients) {
    if (!client.email || normaliserEmail(client.email) !== cible) continue;
    for (const dossier of client.dossiers) {
      if (dejaVus.has(dossier.id)) continue;
      dejaVus.add(dossier.id);
      suggestions.push({ ...dossier, clientNom: client.nom });
    }
  }
  return suggestions;
}

/**
 * Point d'entree utilise par routes/emailIngestion.ts : charge les clients
 * du cabinet (avec leurs dossiers) via une lecture Prisma standard (donc
 * transparente vis-a-vis du chiffrement au repos), puis delegue a la
 * fonction pure ci-dessus. Charge l'ensemble des clients du cabinet a
 * chaque appel plutot qu'un cache : volume attendu (quelques centaines de
 * clients pour un cabinet d'avocats) largement compatible avec cette
 * simplicite, contrainte de performance non explicite dans le prompt pour
 * ce lot.
 */
export async function suggererDossiers(
  prisma: PrismaClient,
  cabinetId: string,
  expediteurEmail: string
): Promise<DossierSuggere[]> {
  if (!expediteurEmail) return [];
  const clients = await prisma.client.findMany({
    where: { cabinetId },
    select: {
      nom: true,
      email: true,
      dossiers: { select: { id: true, numeroDossier: true, nomAffaire: true } },
    },
  });
  return suggererDossiersPourExpediteur(clients, expediteurEmail);
}
