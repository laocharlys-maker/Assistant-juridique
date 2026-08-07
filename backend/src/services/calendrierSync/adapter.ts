import { ConnexionCalendrierExterne } from "@prisma/client";

/**
 * Lot 12b - forme neutre d'un Evenement Aurore, telle que consommee par les
 * adaptateurs de synchronisation externe (Google Calendar, CalDAV) -
 * volontairement decouplee du modele Prisma complet (pas besoin de
 * dossierId, assignes, etc. cote fournisseur externe).
 */
export interface EvenementExterneInput {
  titre: string;
  description?: string | null;
  lieu?: string | null;
  dateDebut: Date;
  dateFin?: Date | null;
  touteLaJournee: boolean;
}

/**
 * Interface commune aux deux adaptateurs (googleCalendar.ts, caldav.ts) -
 * permet a syncQueue.ts de traiter les deux fournisseurs de facon identique,
 * et facilite l'ajout d'un futur fournisseur sans dupliquer la logique de
 * synchro (voir README-LOT12B.md, "bonnes pratiques" du prompt).
 */
export interface CalendrierExterneAdapter {
  /** Cree l'evenement cote externe, renvoie son identifiant externe. */
  creerEvenement(connexion: ConnexionCalendrierExterne, evenement: EvenementExterneInput): Promise<string>;
  /** Met a jour l'evenement externe existant (jamais de duplication). */
  modifierEvenement(
    connexion: ConnexionCalendrierExterne,
    externalEventId: string,
    evenement: EvenementExterneInput
  ): Promise<void>;
  /** Supprime l'evenement cote externe. Idempotent : un 404/410 (deja
   * supprime cote externe, ex. par l'utilisateur lui-meme) n'est jamais une
   * erreur. */
  supprimerEvenement(connexion: ConnexionCalendrierExterne, externalEventId: string): Promise<void>;
}
