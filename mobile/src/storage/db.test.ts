// Fausse base SQLite en memoire - expo-sqlite est un module natif (aucun
// binaire disponible sous Jest). Implemente seulement le sous-ensemble
// d'API reellement utilise par db.ts.
interface LigneDossier {
  id: string;
  donnees_chiffrees: string;
}

function creerFausseBase() {
  const dossiers = new Map<string, string>();
  const meta = new Map<string, string>();
  return {
    execAsync: jest.fn(async () => undefined),
    withTransactionAsync: jest.fn(async (tache: () => Promise<void>) => tache()),
    runAsync: jest.fn(async (sql: string, params?: unknown[]) => {
      if (sql.startsWith("DELETE FROM dossiers_cache")) {
        dossiers.clear();
      } else if (sql.startsWith("INSERT INTO dossiers_cache")) {
        const [id, donnees] = params as [string, string];
        dossiers.set(id, donnees);
      } else if (sql.startsWith("INSERT OR REPLACE INTO meta")) {
        const [valeur] = params as [string];
        meta.set("dossiers_derniere_maj", valeur);
      }
    }),
    getAllAsync: jest.fn(async (): Promise<LigneDossier[]> => {
      return Array.from(dossiers.entries())
        .sort(([a], [b]) => a.localeCompare(b))
        .map(([id, donnees_chiffrees]) => ({ id, donnees_chiffrees }));
    }),
    getFirstAsync: jest.fn(async () => {
      const valeur = meta.get("dossiers_derniere_maj");
      return valeur ? { valeur } : null;
    }),
  };
}

const mockOpenDatabaseAsync = jest.fn();
// La propriete doit etre une fonction qui APPELLE mockOpenDatabaseAsync au
// moment de l'invocation (jamais une reference directe evaluee a la
// definition de la factory) - jest.mock() est hoiste au-dessus de la
// declaration `const` ci-dessus, qui n'est pas encore initialisee quand la
// factory elle-meme s'execute (au premier import de "expo-sqlite").
jest.mock("expo-sqlite", () => ({
  openDatabaseAsync: (...args: unknown[]) => mockOpenDatabaseAsync(...args),
}));

// Chiffrement reel du coffre (pas un simple passthrough) - verifie au
// passage que db.ts l'utilise correctement, sans reexaminer sa propre
// crypto (deja couverte par vault.test.ts).
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

import { remplacerCacheDossiers, listerDossiersCache, dateDerniereMajDossiers, _reinitialiserDbPourTests } from "./db";

const DOSSIERS_EXEMPLE = [
  { id: "d1", numeroDossier: "2026-001", nomAffaire: "Affaire Koffi", nomClient: "Koffi Jean", prochaineAudience: null },
  { id: "d2", numeroDossier: "2026-002", nomAffaire: "Affaire Dupont", nomClient: "Dupont Alice", prochaineAudience: "2026-12-01T09:00:00.000Z" },
];

beforeEach(() => {
  _reinitialiserDbPourTests();
  mockOpenDatabaseAsync.mockResolvedValue(creerFausseBase());
});

describe("storage/db - cache dossiers", () => {
  it("liste vide avant toute synchronisation", async () => {
    expect(await listerDossiersCache()).toEqual([]);
    expect(await dateDerniereMajDossiers()).toBeNull();
  });

  it("enregistre puis relit les dossiers, bit-à-bit identiques", async () => {
    await remplacerCacheDossiers(DOSSIERS_EXEMPLE);
    const relu = await listerDossiersCache();
    expect(relu).toEqual(DOSSIERS_EXEMPLE);
  });

  it("enregistre une date de dernière mise à jour", async () => {
    const avant = Date.now();
    await remplacerCacheDossiers(DOSSIERS_EXEMPLE);
    const derniereMaj = await dateDerniereMajDossiers();
    expect(derniereMaj).not.toBeNull();
    expect(derniereMaj!.getTime()).toBeGreaterThanOrEqual(avant);
  });

  it("remplace entièrement le cache (une suppression côté serveur disparaît aussi du cache)", async () => {
    await remplacerCacheDossiers(DOSSIERS_EXEMPLE);
    await remplacerCacheDossiers([DOSSIERS_EXEMPLE[0]]);
    const relu = await listerDossiersCache();
    expect(relu).toEqual([DOSSIERS_EXEMPLE[0]]);
  });

  it("les données sur le disque (simulé) sont chiffrées, jamais le nom en clair", async () => {
    await remplacerCacheDossiers(DOSSIERS_EXEMPLE);
    const base = await mockOpenDatabaseAsync.mock.results[0].value;
    const lignes = await base.getAllAsync();
    for (const ligne of lignes) {
      expect(ligne.donnees_chiffrees).not.toContain("Koffi");
      expect(ligne.donnees_chiffrees).not.toContain("Dupont");
    }
  });
});
