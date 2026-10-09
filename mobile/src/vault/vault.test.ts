// expo-secure-store et expo-crypto sont des modules NATIFS (pas de binaire
// disponible sous Jest) - mocks explicites en memoire, suffisants pour
// tester la logique de chiffrement elle-meme (@noble/ciphers, pure JS,
// deja verifie par protocol.test.ts).
const mockMagasinSecureStore = new Map<string, string>();
jest.mock("expo-secure-store", () => ({
  WHEN_UNLOCKED_THIS_DEVICE_ONLY: "WHEN_UNLOCKED_THIS_DEVICE_ONLY",
  getItemAsync: jest.fn(async (cle: string) => mockMagasinSecureStore.get(cle) ?? null),
  setItemAsync: jest.fn(async (cle: string, valeur: string) => {
    mockMagasinSecureStore.set(cle, valeur);
  }),
  deleteItemAsync: jest.fn(async (cle: string) => {
    mockMagasinSecureStore.delete(cle);
  }),
}));

jest.mock("expo-crypto", () => ({
  getRandomBytes: (taille: number) => new Uint8Array(require("node:crypto").randomBytes(taille)),
}));

import {
  chargerOuCreerCleMaitresse,
  _reinitialiserCachePourTests,
  chiffrer,
  dechiffrer,
  chiffrerTexte,
  dechiffrerTexte,
  CoffreDechiffrementError,
  stockerValeur,
  lireValeur,
  supprimerValeur,
} from "./vault";

beforeEach(() => {
  mockMagasinSecureStore.clear();
  _reinitialiserCachePourTests();
});

describe("vault - clé maîtresse", () => {
  it("génère une clé de 32 octets au premier appel, puis la même à chaque appel suivant", async () => {
    const cle1 = await chargerOuCreerCleMaitresse();
    expect(cle1.length).toBe(32);
    _reinitialiserCachePourTests(); // force une relecture depuis le "coffre"
    const cle2 = await chargerOuCreerCleMaitresse();
    expect(Buffer.from(cle2).equals(Buffer.from(cle1))).toBe(true);
  });

  it("la clé est bien stockée via expo-secure-store (jamais en clair en dehors du module)", async () => {
    await chargerOuCreerCleMaitresse();
    expect(mockMagasinSecureStore.size).toBe(1);
  });
});

describe("vault - chiffrement/déchiffrement", () => {
  it("chiffre puis déchiffre un texte correctement (round-trip)", async () => {
    const texte = "Compte-rendu confidentiel - Maître Koffi Jean-Baptiste";
    const enveloppe = await chiffrerTexte(texte);
    expect(enveloppe).not.toContain("Koffi");
    const relu = await dechiffrerTexte(enveloppe);
    expect(relu).toBe(texte);
  });

  it("deux chiffrements du même texte produisent des enveloppes différentes (nonce aléatoire)", async () => {
    const enveloppe1 = await chiffrerTexte("même texte");
    const enveloppe2 = await chiffrerTexte("même texte");
    expect(enveloppe1).not.toBe(enveloppe2);
  });

  it("rejette le déchiffrement d'une enveloppe corrompue", async () => {
    await chargerOuCreerCleMaitresse();
    await expect(dechiffrer("pas une enveloppe valide")).rejects.toThrow(CoffreDechiffrementError);
  });

  it("rejette le déchiffrement si la clé maîtresse change entre-temps (coffre vidé)", async () => {
    const enveloppe = await chiffrerTexte("secret");
    mockMagasinSecureStore.clear(); // simule une reinstallation : le coffre materiel est vide
    _reinitialiserCachePourTests();
    await expect(dechiffrerTexte(enveloppe)).rejects.toThrow(CoffreDechiffrementError);
  });

  it("chiffre des octets binaires arbitraires (pas seulement du texte UTF-8)", async () => {
    const binaire = new Uint8Array([0x25, 0x50, 0x44, 0x46, 0x00, 0xff, 0x10]);
    const enveloppe = await chiffrer(binaire);
    const relu = await dechiffrer(enveloppe);
    expect(Buffer.from(relu).equals(Buffer.from(binaire))).toBe(true);
  });
});

describe("vault - petites valeurs (adresse PC, PIN haché...)", () => {
  it("stocke, lit puis supprime une valeur simple", async () => {
    await stockerValeur("adresse_pc", "192.168.1.42:3100");
    expect(await lireValeur("adresse_pc")).toBe("192.168.1.42:3100");
    await supprimerValeur("adresse_pc");
    expect(await lireValeur("adresse_pc")).toBeNull();
  });
});
