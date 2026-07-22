import { describe, it, expect } from "vitest";
import { computeDeadline } from "../delais";

function iso(date: Date): string {
  return date.toISOString().slice(0, 10);
}

describe("computeDeadline", () => {
  it("ajoute un nombre de jours sans report si le resultat tombe un jour ouvre", () => {
    // 2026-07-06 est un lundi ; +10 jours = 2026-07-16, un jeudi.
    const result = computeDeadline(new Date("2026-07-06T00:00:00Z"), 10, "jours", true);
    expect(iso(result)).toBe("2026-07-16");
  });

  it("reporte au prochain jour ouvre si la date tombe un samedi", () => {
    // 2026-07-06 (lundi) + 4 jours = 2026-07-10, un vendredi -> pas de report.
    // 2026-07-06 (lundi) + 5 jours = 2026-07-11, un samedi -> report au lundi 13.
    const result = computeDeadline(new Date("2026-07-06T00:00:00Z"), 5, "jours", true);
    expect(iso(result)).toBe("2026-07-13");
  });

  it("reporte au prochain jour ouvre si la date tombe un dimanche", () => {
    const result = computeDeadline(new Date("2026-07-06T00:00:00Z"), 6, "jours", true);
    expect(iso(result)).toBe("2026-07-13");
  });

  it("ne reporte pas si joursOuvresUniquement est desactive", () => {
    const result = computeDeadline(new Date("2026-07-06T00:00:00Z"), 5, "jours", false);
    expect(iso(result)).toBe("2026-07-11");
  });

  it("calcule un delai en mois au meme quantieme", () => {
    const result = computeDeadline(new Date("2026-01-15T00:00:00Z"), 1, "mois", false);
    expect(iso(result)).toBe("2026-02-15");
  });

  it("ramene au dernier jour du mois cible si le quantieme n'existe pas", () => {
    // 31 janvier + 1 mois -> fevrier n'a pas de 31, donc 28 (2026 n'est pas bissextile).
    const result = computeDeadline(new Date("2026-01-31T00:00:00Z"), 1, "mois", false);
    expect(iso(result)).toBe("2026-02-28");
  });

  it("gere le changement d'annee pour un delai en mois", () => {
    const result = computeDeadline(new Date("2026-12-05T00:00:00Z"), 2, "mois", false);
    expect(iso(result)).toBe("2027-02-05");
  });
});
