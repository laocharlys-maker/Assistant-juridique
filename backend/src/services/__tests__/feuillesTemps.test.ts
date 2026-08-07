import { describe, it, expect } from "vitest";
import {
  agregerParCollaborateur,
  agregerParDossier,
  calculerMontant,
  formatDuree,
  SaisiePourAgregation,
} from "../feuillesTemps";

describe("calculerMontant", () => {
  it("calcule le montant proportionnellement à la durée et au taux appliqué", () => {
    expect(calculerMontant(60, 15000)).toBe(15000);
    expect(calculerMontant(30, 15000)).toBe(7500);
    expect(calculerMontant(90, 20000)).toBe(30000);
  });

  it("renvoie 0 si aucun taux n'était configuré au moment de la saisie", () => {
    expect(calculerMontant(120, null)).toBe(0);
  });
});

describe("formatDuree", () => {
  it("formate heures et minutes de façon compacte", () => {
    expect(formatDuree(30)).toBe("30min");
    expect(formatDuree(60)).toBe("1h");
    expect(formatDuree(90)).toBe("1h30");
    expect(formatDuree(125)).toBe("2h05");
  });
});

const saisies: SaisiePourAgregation[] = [
  { userId: "u1", userNom: "Awa Toko", dossierId: "d1", dossierLabel: "AFF-1 — Affaire A", dureeMinutes: 60, tauxHoraireApplique: 10000, facturable: true },
  { userId: "u1", userNom: "Awa Toko", dossierId: "d2", dossierLabel: "AFF-2 — Affaire B", dureeMinutes: 30, tauxHoraireApplique: 10000, facturable: true },
  { userId: "u1", userNom: "Awa Toko", dossierId: "d1", dossierLabel: "AFF-1 — Affaire A", dureeMinutes: 45, tauxHoraireApplique: 10000, facturable: false },
  { userId: "u2", userNom: "Jean Kokou", dossierId: "d1", dossierLabel: "AFF-1 — Affaire A", dureeMinutes: 120, tauxHoraireApplique: 20000, facturable: true },
];

describe("agregerParCollaborateur", () => {
  it("somme le temps facturable/non facturable et le montant par utilisateur, tous dossiers confondus", () => {
    const lignes = agregerParCollaborateur(saisies);
    expect(lignes).toHaveLength(2);

    const awa = lignes.find((l) => l.cle === "u1")!;
    expect(awa.dureeMinutesFacturable).toBe(90); // 60 + 30
    expect(awa.dureeMinutesNonFacturable).toBe(45);
    expect(awa.montantFacturable).toBe(15000); // (60/60*10000) + (30/60*10000)

    const jean = lignes.find((l) => l.cle === "u2")!;
    expect(jean.dureeMinutesFacturable).toBe(120);
    expect(jean.montantFacturable).toBe(40000);
  });

  it("trie les lignes par libellé", () => {
    const lignes = agregerParCollaborateur(saisies);
    expect(lignes.map((l) => l.label)).toEqual(["Awa Toko", "Jean Kokou"]);
  });
});

describe("agregerParDossier", () => {
  it("somme par dossier, tous collaborateurs confondus", () => {
    const lignes = agregerParDossier(saisies);
    const d1 = lignes.find((l) => l.cle === "d1")!;
    // d1 facturable : 60 (u1) + 120 (u2) ; non facturable : 45 (u1)
    expect(d1.dureeMinutesFacturable).toBe(180);
    expect(d1.dureeMinutesNonFacturable).toBe(45);
    expect(d1.montantFacturable).toBe(10000 + 40000);

    const d2 = lignes.find((l) => l.cle === "d2")!;
    expect(d2.dureeMinutesFacturable).toBe(30);
    expect(d2.dureeMinutesNonFacturable).toBe(0);
  });
});
