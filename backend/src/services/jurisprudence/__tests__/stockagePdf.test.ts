import { describe, it, expect } from "vitest";
import { construireLienInterneDocument, extraireGroupeIdDuLienInterne } from "../stockagePdf";

describe("stockagePdf - lien interne", () => {
  it("construit puis reconnaît le même groupeId (aller-retour)", () => {
    const groupeId = "8f14e45f-ceea-467e-b0ee-9f4d1e3d5a13";
    const lien = construireLienInterneDocument(groupeId);
    expect(lien).toBe(`/api/jurisprudence-base/${groupeId}/document`);
    expect(extraireGroupeIdDuLienInterne(lien)).toBe(groupeId);
  });

  it("ne reconnaît jamais une URL web classique comme un lien interne", () => {
    expect(extraireGroupeIdDuLienInterne("https://exemple.bj/decision/123")).toBeNull();
    expect(extraireGroupeIdDuLienInterne("http://legifrance.gouv.fr/x")).toBeNull();
  });

  it("rejette un format proche mais invalide (segment supplémentaire, préfixe seul)", () => {
    expect(extraireGroupeIdDuLienInterne("/api/jurisprudence-base//document")).toBeNull();
    expect(extraireGroupeIdDuLienInterne("/api/jurisprudence-base/abc/def/document")).toBeNull();
    expect(extraireGroupeIdDuLienInterne("/api/jurisprudence-base/document")).toBeNull();
  });
});
