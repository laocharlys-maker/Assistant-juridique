import { delaiAvantProchaineTentativeMs, peutRetenterMaintenant, calculerProchaineTentativeAt } from "./backoff";

describe("backoff - délais croissants (Prompt 6, objectif C)", () => {
  it("augmente strictement à chaque tentative, jamais de boucle serrée", () => {
    const delais = [0, 1, 2, 3, 4].map(delaiAvantProchaineTentativeMs);
    for (let i = 1; i < delais.length; i++) {
      expect(delais[i]).toBeGreaterThan(delais[i - 1]);
    }
    expect(delais[0]).toBeGreaterThanOrEqual(5_000); // jamais immediat.
  });

  it("plafonne au dernier palier au-delà (jamais une attente infinie qui grossit sans fin)", () => {
    expect(delaiAvantProchaineTentativeMs(100)).toBe(delaiAvantProchaineTentativeMs(4));
  });

  it("peutRetenterMaintenant : true si jamais tenté", () => {
    expect(peutRetenterMaintenant(null)).toBe(true);
    expect(peutRetenterMaintenant(undefined)).toBe(true);
  });

  it("peutRetenterMaintenant : false avant l'échéance, true après", () => {
    const maintenant = 1_000_000;
    const future = new Date(maintenant + 10_000).toISOString();
    expect(peutRetenterMaintenant(future, maintenant)).toBe(false);
    expect(peutRetenterMaintenant(future, maintenant + 10_001)).toBe(true);
  });

  it("calculerProchaineTentativeAt produit une date cohérente avec le délai attendu", () => {
    const maintenant = 1_000_000;
    const resultat = calculerProchaineTentativeAt(0, maintenant);
    expect(new Date(resultat).getTime()).toBe(maintenant + delaiAvantProchaineTentativeMs(0));
  });
});
