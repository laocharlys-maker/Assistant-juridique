import { describe, expect, it } from "vitest";
import { dernierCreneauPasse, dernierCreneauVeilleJuridique, dernierCreneauRoleSemaine } from "../creneauHebdomadaire";

/**
 * Rattrapage au demarrage (veille juridique / role de la semaine) : verifie
 * le calcul du "dernier creneau deja passe", en UTC pur (Benin = UTC+1 fixe,
 * voir en-tete du module). Toutes les dates de test sont ecrites en UTC
 * explicite pour rester independantes du fuseau horaire de la machine qui
 * execute les tests.
 */

describe("dernierCreneauPasse", () => {
  it("reste sur le jour courant si l'heure cible n'est pas encore atteinte", () => {
    // Lundi 2026-08-31, 5h UTC - avant le creneau lundi 6h UTC vise.
    const maintenant = new Date("2026-08-31T05:00:00.000Z");
    const creneau = dernierCreneauPasse(maintenant, 1, 6);
    // Doit retomber sur le lundi PRECEDENT (2026-08-24), pas le jour meme.
    expect(creneau.toISOString()).toBe("2026-08-24T06:00:00.000Z");
  });

  it("reste sur le jour courant si l'heure cible est deja atteinte", () => {
    // Lundi 2026-08-31, 6h01 UTC - juste apres le creneau.
    const maintenant = new Date("2026-08-31T06:01:00.000Z");
    const creneau = dernierCreneauPasse(maintenant, 1, 6);
    expect(creneau.toISOString()).toBe("2026-08-31T06:00:00.000Z");
  });

  it("exactement au creneau : considere comme deja passe (inclusif)", () => {
    const maintenant = new Date("2026-08-31T06:00:00.000Z");
    const creneau = dernierCreneauPasse(maintenant, 1, 6);
    expect(creneau.toISOString()).toBe("2026-08-31T06:00:00.000Z");
  });

  it("un jour quelconque de la semaine retombe sur le bon jour cible precedent", () => {
    // Jeudi 2026-09-03 -> dernier lundi 6h UTC = 2026-08-31.
    const maintenant = new Date("2026-09-03T12:00:00.000Z");
    const creneau = dernierCreneauPasse(maintenant, 1, 6);
    expect(creneau.toISOString()).toBe("2026-08-31T06:00:00.000Z");
  });
});

describe("dernierCreneauVeilleJuridique (lundi 7h heure du Benin = lundi 6h UTC)", () => {
  it("calcule le bon creneau", () => {
    const maintenant = new Date("2026-09-02T10:00:00.000Z"); // mercredi
    expect(dernierCreneauVeilleJuridique(maintenant).toISOString()).toBe("2026-08-31T06:00:00.000Z");
  });
});

describe("dernierCreneauRoleSemaine (vendredi 8h heure du Benin = vendredi 7h UTC)", () => {
  it("calcule le bon creneau", () => {
    const maintenant = new Date("2026-09-02T10:00:00.000Z"); // mercredi
    // Dernier vendredi 7h UTC precedant mercredi 2026-09-02 = 2026-08-28.
    expect(dernierCreneauRoleSemaine(maintenant).toISOString()).toBe("2026-08-28T07:00:00.000Z");
  });
});
