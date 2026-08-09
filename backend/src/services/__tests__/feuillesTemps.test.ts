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
  { userId: "u1", userNom: "Awa Toko", dossierId: "d1", dossierLabel: "AFF-1 — Affaire A", dureeMinutes: 60, tauxHoraireApplique: 10000 },
  { userId: "u1", userNom: "Awa Toko", dossierId: "d2", dossierLabel: "AFF-2 — Affaire B", dureeMinutes: 30, tauxHoraireApplique: 10000 },
  { userId: "u1", userNom: "Awa Toko", dossierId: "d1", dossierLabel: "AFF-1 — Affaire A", dureeMinutes: 45, tauxHoraireApplique: 10000 },
  { userId: "u2", userNom: "Jean Kokou", dossierId: "d1", dossierLabel: "AFF-1 — Affaire A", dureeMinutes: 120, tauxHoraireApplique: 20000 },
];

describe("agregerParCollaborateur", () => {
  it("somme le temps et le montant par utilisateur, tous dossiers confondus", () => {
    const lignes = agregerParCollaborateur(saisies);
    expect(lignes).toHaveLength(2);

    const awa = lignes.find((l) => l.cle === "u1")!;
    expect(awa.dureeMinutes).toBe(135); // 60 + 30 + 45
    expect(awa.montant).toBe(22500); // (60/60*10000) + (30/60*10000) + (45/60*10000)

    const jean = lignes.find((l) => l.cle === "u2")!;
    expect(jean.dureeMinutes).toBe(120);
    expect(jean.montant).toBe(40000);
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
    // d1 : 60 (u1) + 45 (u1) + 120 (u2)
    expect(d1.dureeMinutes).toBe(225);
    expect(d1.montant).toBe(10000 + 7500 + 40000);

    const d2 = lignes.find((l) => l.cle === "d2")!;
    expect(d2.dureeMinutes).toBe(30);
    expect(d2.montant).toBe(5000);
  });
});
