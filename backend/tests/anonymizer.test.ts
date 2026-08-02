import { describe, expect, it } from "vitest";
import { anonymize } from "../src/security/anonymizer";
import type { ChampIdentifiantInput } from "../src/security/pseudonymisation.types";

describe("anonymize - tokenisation simple", () => {
  it("remplace un demandeur et un defendeur par PARTIE_A/PARTIE_B, jamais les vrais noms", () => {
    const champs: ChampIdentifiantInput[] = [
      { champ: "nomClient", role: "PARTIE", valeur: "Jean Dupont" },
      { champ: "nomPartieAdverse", role: "PARTIE", valeur: "Marie Martin" },
    ];
    const promptTexte = "Affaire : Dupont contre Martin\nClient : Jean Dupont\nPartie adverse : Marie Martin";

    const { promptAnonymise, tokenMap, entitiesCount } = anonymize(champs, promptTexte);

    expect(promptAnonymise).toContain("PARTIE_A");
    expect(promptAnonymise).toContain("PARTIE_B");
    expect(promptAnonymise).not.toContain("Jean Dupont");
    expect(promptAnonymise).not.toContain("Marie Martin");
    expect(entitiesCount).toBe(2);
    expect(tokenMap.get("PARTIE_A")).toBe("Jean Dupont");
    expect(tokenMap.get("PARTIE_B")).toBe("Marie Martin");
  });

  it("attribue des prefixes de role differents (JUGE, GREFFIER, ADRESSE...) avec suffixe numerique", () => {
    const champs: ChampIdentifiantInput[] = [
      { champ: "nomJuge", role: "JUGE", valeur: "Paul Kokou" },
      { champ: "nomGreffier", role: "GREFFIER", valeur: "Alice Houinsou" },
      { champ: "adresse", role: "ADRESSE", valeur: "Cotonou, quartier Fidjrossè" },
    ];
    const { promptAnonymise, tokenMap } = anonymize(champs, "Juge: Paul Kokou, Greffier: Alice Houinsou, Adresse: Cotonou, quartier Fidjrossè");

    expect(promptAnonymise).toContain("JUGE_1");
    expect(promptAnonymise).toContain("GREFFIER_1");
    expect(promptAnonymise).toContain("ADRESSE_1");
    expect(tokenMap.get("JUGE_1")).toBe("Paul Kokou");
  });
});

describe("anonymize - stabilite des tokens", () => {
  it("remplace TOUTES les occurrences de la meme valeur par le MEME token", () => {
    const champs: ChampIdentifiantInput[] = [{ champ: "nomClient", role: "PARTIE", valeur: "Jean Dupont" }];
    const promptTexte = "Client : Jean Dupont. Jean Dupont demande réparation. Signé Jean Dupont.";

    const { promptAnonymise } = anonymize(champs, promptTexte);

    const occurrences = promptAnonymise.split("PARTIE_A").length - 1;
    expect(occurrences).toBe(3);
    expect(promptAnonymise).not.toContain("Jean Dupont");
  });

  it("reutilise le meme token si la meme valeur reelle apparait sous deux champs distincts", () => {
    const champs: ChampIdentifiantInput[] = [
      { champ: "nomClient", role: "PARTIE", valeur: "Cabinet ACME" },
      { champ: "partie1", role: "PARTIE", valeur: "Cabinet ACME" },
    ];
    const { tokenMap, entitiesCount } = anonymize(champs, "Cabinet ACME");
    expect(entitiesCount).toBe(1);
    expect(tokenMap.get("PARTIE_A")).toBe("Cabinet ACME");
  });
});

describe("anonymize - parties multiples", () => {
  it("attribue un token distinct et stable a chaque entite differente du meme role", () => {
    const champs: ChampIdentifiantInput[] = [
      { champ: "demandeur1", role: "PARTIE", valeur: "Jean Dupont" },
      { champ: "demandeur2", role: "PARTIE", valeur: "Marie Martin" },
      { champ: "demandeur3", role: "PARTIE", valeur: "Paul Adjovi" },
    ];
    const { promptAnonymise, tokenMap, entitiesCount } = anonymize(
      champs,
      "Demandeurs : Jean Dupont, Marie Martin et Paul Adjovi"
    );

    expect(entitiesCount).toBe(3);
    expect(tokenMap.get("PARTIE_A")).toBe("Jean Dupont");
    expect(tokenMap.get("PARTIE_B")).toBe("Marie Martin");
    expect(tokenMap.get("PARTIE_C")).toBe("Paul Adjovi");
    expect(promptAnonymise).toBe("Demandeurs : PARTIE_A, PARTIE_B et PARTIE_C");
  });
});

describe("anonymize - cas limites", () => {
  it("ignore silencieusement les champs vides, absents ou uniquement des espaces", () => {
    const champs: ChampIdentifiantInput[] = [
      { champ: "nomClient", role: "PARTIE", valeur: "Jean Dupont" },
      { champ: "nomPartieAdverse", role: "PARTIE", valeur: "" },
      { champ: "nomJuge", role: "JUGE", valeur: undefined },
      { champ: "nomGreffier", role: "GREFFIER", valeur: null },
      { champ: "adresse", role: "ADRESSE", valeur: "   " },
    ];
    const { entitiesCount, tokenMap } = anonymize(champs, "Client : Jean Dupont");
    expect(entitiesCount).toBe(1);
    expect(tokenMap.get("PARTIE_A")).toBe("Jean Dupont");
  });

  it("gere les accents, apostrophes et caracteres speciaux courants en droit beninois/francophone", () => {
    const champs: ChampIdentifiantInput[] = [
      { champ: "nomClient", role: "PARTIE", valeur: "N'Da Amétépé Kokou d'Almeida" },
      { champ: "adresse", role: "ADRESSE", valeur: "Résidence Aïcha, Cotonou — Bénin" },
    ];
    const promptTexte = "Client : N'Da Amétépé Kokou d'Almeida, demeurant Résidence Aïcha, Cotonou — Bénin";

    const { promptAnonymise } = anonymize(champs, promptTexte);

    expect(promptAnonymise).not.toContain("N'Da Amétépé Kokou d'Almeida");
    expect(promptAnonymise).not.toContain("Aïcha");
    expect(promptAnonymise).toContain("PARTIE_A");
    expect(promptAnonymise).toContain("ADRESSE_1");
  });

  it("ne mutile pas une valeur longue qui contient une valeur plus courte", () => {
    // "Jean" est un sous-mot de "Jean Dupont" - si la valeur courte etait
    // remplacee en premier, "Jean Dupont" deviendrait "PARTIE_A Dupont"
    // (corrompu) au lieu d'etre remplace integralement par son propre token.
    const champs: ChampIdentifiantInput[] = [
      { champ: "prenom", role: "PARTIE", valeur: "Jean" },
      { champ: "nomComplet", role: "PARTIE", valeur: "Jean Dupont" },
    ];
    const { promptAnonymise } = anonymize(champs, "Jean Dupont et Jean sont mentionnes");

    // "Jean Dupont" (valeur la plus longue) doit être entierement remplace
    // par un seul token, jamais laisser "Dupont" orphelin a cote d'un token.
    expect(promptAnonymise).not.toContain("Dupont");
  });

  it("retourne le texte inchange et 0 entite si aucun champ identifiant n'est fourni", () => {
    const { promptAnonymise, entitiesCount } = anonymize([], "Texte neutre sans identite");
    expect(promptAnonymise).toBe("Texte neutre sans identite");
    expect(entitiesCount).toBe(0);
  });
});
