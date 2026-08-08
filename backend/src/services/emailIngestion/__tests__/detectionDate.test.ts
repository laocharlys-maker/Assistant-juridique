import { describe, expect, it } from "vitest";
import { detecterDate } from "../detectionDate";

// Date de reception fixe pour tous les tests (mardi 4 août 2026, 08h00) -
// sert de point de depart aux formats relatifs/incomplets.
const REFERENCE = new Date(2026, 7, 4, 8, 0, 0);

describe("detectionDate (Lot 16)", () => {
  it("détecte une date numérique complète avec heure (JJ/MM/AAAA à HHhMM)", () => {
    const res = detecterDate("Le rendez-vous est fixé au 12/08/2026 à 10h30 dans nos locaux.", REFERENCE);
    expect(res).not.toBeNull();
    expect(res!.date.getFullYear()).toBe(2026);
    expect(res!.date.getMonth()).toBe(7);
    expect(res!.date.getDate()).toBe(12);
    expect(res!.date.getHours()).toBe(10);
    expect(res!.date.getMinutes()).toBe(30);
    expect(res!.contexte).toContain("12/08/2026");
  });

  it("détecte une date numérique sans heure (défaut 9h00)", () => {
    const res = detecterDate("Merci de confirmer la date du 15/09/2026.", REFERENCE);
    expect(res).not.toBeNull();
    expect(res!.date.getDate()).toBe(15);
    expect(res!.date.getMonth()).toBe(8);
    expect(res!.date.getHours()).toBe(9);
    expect(res!.date.getMinutes()).toBe(0);
  });

  it("détecte une date littérale avec jour de semaine et heure (\"mardi 12 août à 10h\")", () => {
    const res = detecterDate("On se voit mardi 12 août à 10h si cela te convient.", REFERENCE);
    expect(res).not.toBeNull();
    expect(res!.date.getMonth()).toBe(7);
    expect(res!.date.getDate()).toBe(12);
    expect(res!.date.getHours()).toBe(10);
  });

  it("détecte une date littérale sans jour de semaine ni année (infère l'année de référence)", () => {
    const res = detecterDate("Rendez-vous prévu le 20 décembre pour la clôture du dossier.", REFERENCE);
    expect(res).not.toBeNull();
    expect(res!.date.getMonth()).toBe(11);
    expect(res!.date.getDate()).toBe(20);
    expect(res!.date.getFullYear()).toBe(2026);
  });

  it("infère l'année SUIVANTE quand la date littérale est déjà passée de plus d'un jour", () => {
    const res = detecterDate("On se voit le 1 janvier pour la nouvelle année.", REFERENCE);
    expect(res).not.toBeNull();
    expect(res!.date.getFullYear()).toBe(2027);
  });

  it("détecte \"demain à 14h30\" par rapport à la date de réception", () => {
    const res = detecterDate("Peux-tu passer demain à 14h30 ?", REFERENCE);
    expect(res).not.toBeNull();
    expect(res!.date.getDate()).toBe(5); // 4 aout + 1
    expect(res!.date.getHours()).toBe(14);
    expect(res!.date.getMinutes()).toBe(30);
  });

  it("détecte \"après-demain\" (+2 jours)", () => {
    const res = detecterDate("Rendez-vous après-demain à 9h.", REFERENCE);
    expect(res).not.toBeNull();
    expect(res!.date.getDate()).toBe(6);
    expect(res!.date.getHours()).toBe(9);
  });

  it("détecte \"aujourd'hui\" (jour de réception, sans décalage)", () => {
    const res = detecterDate("Peux-tu me rappeler aujourd'hui à 16h ?", REFERENCE);
    expect(res).not.toBeNull();
    expect(res!.date.getDate()).toBe(4);
    expect(res!.date.getHours()).toBe(16);
  });

  it("détecte le format \"le 12 à 10h\" (jour seul + heure explicite, mois courant si pas encore passé)", () => {
    const res = detecterDate("On se voit le 12 à 10h dans nos locaux.", REFERENCE); // ref = 4 aout
    expect(res).not.toBeNull();
    expect(res!.date.getMonth()).toBe(7); // aout, pas encore passe
    expect(res!.date.getDate()).toBe(12);
    expect(res!.date.getHours()).toBe(10);
  });

  it("le format \"le X\" bascule au mois suivant si le jour est déjà passé", () => {
    const res = detecterDate("On se voit le 2 à 10h dans nos locaux.", REFERENCE); // ref = 4 aout, jour 2 deja passe
    expect(res).not.toBeNull();
    expect(res!.date.getMonth()).toBe(8); // septembre
    expect(res!.date.getDate()).toBe(2);
  });

  it("rejette le format \"le X\" SANS heure explicite (trop ambigu, limite documentée)", () => {
    const res = detecterDate("On se voit le 12 dans nos locaux, sans heure précisée.", REFERENCE);
    expect(res).toBeNull();
  });

  it("renvoie null pour un texte sans aucune date reconnaissable", () => {
    const res = detecterDate("Merci de trouver ci-joint le contrat signé.", REFERENCE);
    expect(res).toBeNull();
  });

  it("renvoie null pour une expression vague non couverte (limite documentée)", () => {
    const res = detecterDate("On se voit la semaine prochaine, je te tiens au courant.", REFERENCE);
    expect(res).toBeNull();
  });

  it("rejette une date numérique invalide (jour/mois hors bornes)", () => {
    const res = detecterDate("Réunion le 35/13/2026 à 10h.", REFERENCE);
    expect(res).toBeNull();
  });

  it("le contexte renvoyé reste court et ne contient jamais tout le texte source", () => {
    const texteLong = "Bonjour, ".repeat(50) + "le rendez-vous est fixé au 12/08/2026 à 10h30. " + "Cordialement, ".repeat(50);
    const res = detecterDate(texteLong, REFERENCE);
    expect(res).not.toBeNull();
    expect(res!.contexte.length).toBeLessThan(120);
    expect(res!.contexte.length).toBeLessThan(texteLong.length);
  });

  it("priorité au format numérique même si un format relatif apparaît après dans le texte", () => {
    // Le format numerique (plus fiable) doit gagner, meme s'il apparait
    // apres "demain" dans le texte.
    const res = detecterDate("On pourrait aussi se voir demain, mais gardons le 12/08/2026 à 10h comme prévu.", REFERENCE);
    expect(res).not.toBeNull();
    expect(res!.date.getDate()).toBe(12);
    expect(res!.date.getMonth()).toBe(7);
  });
});
