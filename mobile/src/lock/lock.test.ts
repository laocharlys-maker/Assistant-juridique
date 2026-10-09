const mockMagasin = new Map<string, string>();
jest.mock("../vault/vault", () => ({
  lireValeur: jest.fn(async (cle: string) => mockMagasin.get(cle) ?? null),
  stockerValeur: jest.fn(async (cle: string, valeur: string) => {
    mockMagasin.set(cle, valeur);
  }),
  supprimerValeur: jest.fn(async (cle: string) => {
    mockMagasin.delete(cle);
  }),
}));

jest.mock("expo-crypto", () => ({
  getRandomBytes: (taille: number) => new Uint8Array(require("node:crypto").randomBytes(taille)),
}));

jest.mock("expo-local-authentication", () => ({
  hasHardwareAsync: jest.fn(async () => true),
  isEnrolledAsync: jest.fn(async () => true),
  authenticateAsync: jest.fn(async () => ({ success: true })),
}));

import {
  pinDejaConfigure,
  configurerPin,
  verifierPin,
  reinitialiserPin,
  biometrieDisponible,
  authentifierParBiometrie,
  lireDelaiVerrouillageMinutes,
  definirDelaiVerrouillageMinutes,
  doitSeVerrouiller,
} from "./lock";

beforeEach(() => {
  mockMagasin.clear();
});

describe("PIN", () => {
  it("aucun PIN configuré au départ", async () => {
    expect(await pinDejaConfigure()).toBe(false);
  });

  it("configure puis vérifie correctement un PIN valide", async () => {
    await configurerPin("1234");
    expect(await pinDejaConfigure()).toBe(true);
    expect(await verifierPin("1234")).toBe(true);
  });

  it("rejette un PIN incorrect", async () => {
    await configurerPin("1234");
    expect(await verifierPin("0000")).toBe(false);
  });

  it("rejette un format de PIN invalide à la configuration (jamais stocké)", async () => {
    await expect(configurerPin("ab")).rejects.toThrow("PIN_INVALIDE");
    expect(await pinDejaConfigure()).toBe(false);
  });

  it("ne stocke jamais le PIN en clair (uniquement un sel + un hash)", async () => {
    await configurerPin("5678");
    for (const valeur of mockMagasin.values()) {
      expect(valeur).not.toBe("5678");
    }
  });

  it("réinitialise le PIN (plus aucun PIN configuré après)", async () => {
    await configurerPin("1234");
    await reinitialiserPin();
    expect(await pinDejaConfigure()).toBe(false);
  });
});

describe("biométrie", () => {
  it("disponible si matériel présent et empreinte/visage déjà enregistré", async () => {
    expect(await biometrieDisponible()).toBe(true);
  });

  it("authentifie avec succès (mock)", async () => {
    expect(await authentifierParBiometrie()).toBe(true);
  });
});

describe("délai de verrouillage automatique", () => {
  it("2 minutes par défaut si jamais réglé", async () => {
    expect(await lireDelaiVerrouillageMinutes()).toBe(2);
  });

  it("respecte un réglage personnalisé", async () => {
    await definirDelaiVerrouillageMinutes(10);
    expect(await lireDelaiVerrouillageMinutes()).toBe(10);
  });

  it("ne se reverrouille pas avant le délai écoulé", async () => {
    const miseEnArrierePlan = Date.now() - 30 * 1000; // 30s, delai par defaut 2 min
    expect(await doitSeVerrouiller(miseEnArrierePlan)).toBe(false);
  });

  it("se reverrouille une fois le délai dépassé", async () => {
    const miseEnArrierePlan = Date.now() - 3 * 60 * 1000; // 3 min
    expect(await doitSeVerrouiller(miseEnArrierePlan)).toBe(true);
  });

  it("jamais de verrouillage si l'app n'a pas été mise en arrière-plan", async () => {
    expect(await doitSeVerrouiller(null)).toBe(false);
  });
});
