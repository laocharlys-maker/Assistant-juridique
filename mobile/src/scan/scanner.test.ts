// Systeme de fichiers en memoire - meme principe que audio/recorder.test.ts
// (expo-file-system est un module natif, aucun binaire sous Jest).
const mockMagasinFichiers = new Map<string, Uint8Array>();

jest.mock("expo-file-system", () => {
  function cheminDepuisUri(uri: string): string {
    return uri.replace(/^file:\/\//, "");
  }

  class MockDirectory {
    uri: string;
    constructor(...parties: (string | MockDirectory | MockFile)[]) {
      this.uri = parties.map((p) => (typeof p === "string" ? p : p.uri)).join("/");
    }
    get exists() {
      return Array.from(mockMagasinFichiers.keys()).some((c) => c.startsWith(this.uri));
    }
    create() {
      /* no-op */
    }
    delete() {
      for (const cle of Array.from(mockMagasinFichiers.keys())) {
        if (cle.startsWith(this.uri)) mockMagasinFichiers.delete(cle);
      }
    }
  }

  class MockFile {
    uri: string;
    constructor(...parties: (string | MockDirectory | MockFile)[]) {
      this.uri = parties.map((p) => (typeof p === "string" ? p : p.uri)).join("/");
    }
    get exists() {
      return mockMagasinFichiers.has(cheminDepuisUri(this.uri));
    }
    create() {
      const cle = cheminDepuisUri(this.uri);
      if (!mockMagasinFichiers.has(cle)) mockMagasinFichiers.set(cle, new Uint8Array());
    }
    write(contenu: string | Uint8Array) {
      const octets = typeof contenu === "string" ? new TextEncoder().encode(contenu) : contenu;
      mockMagasinFichiers.set(cheminDepuisUri(this.uri), octets);
    }
    delete() {
      mockMagasinFichiers.delete(cheminDepuisUri(this.uri));
    }
    async bytes(): Promise<Uint8Array> {
      return mockMagasinFichiers.get(cheminDepuisUri(this.uri)) ?? new Uint8Array();
    }
    async text(): Promise<string> {
      return new TextDecoder().decode(mockMagasinFichiers.get(cheminDepuisUri(this.uri)) ?? new Uint8Array());
    }
  }

  return {
    Directory: MockDirectory,
    File: MockFile,
    Paths: { document: "file:///document", cache: "file:///cache" },
  };
});

// Module natif de redressement - aucun traitement d'image reel sous Jest
// (c'est du Kotlin, voir modules/image-warp). On simule juste l'ecriture
// d'une page redressee a l'emplacement demande, et on capture les arguments
// recus pour verifier que scanner.ts les transmet correctement.
const mockRedresser = jest.fn(async (cheminSource: string, _coins: unknown, cheminDestination: string) => {
  mockMagasinFichiers.set(cheminDestination, new TextEncoder().encode(`page-redressee:${cheminSource}`));
  return cheminDestination;
});
jest.mock("../../modules/image-warp/src/ImageWarpModule", () => ({
  __esModule: true,
  default: { redresser: (...args: Parameters<typeof mockRedresser>) => mockRedresser(...args) },
}));

// pdf-lib n'est pas le sujet de ce test (bibliotheque tierce deja testee
// independamment, voir sa propre suite) - on verifie seulement que
// scanner.ts lui fournit bien une page par image ajoutee.
const mockEmbedJpg = jest.fn(async () => ({ width: 100, height: 140 }));
const mockDrawImage = jest.fn();
const mockAddPage = jest.fn(() => ({ drawImage: mockDrawImage }));
const mockSave = jest.fn(async () => new Uint8Array([1, 2, 3, 4]));
jest.mock("pdf-lib", () => ({
  PDFDocument: {
    create: jest.fn(async () => ({
      embedJpg: mockEmbedJpg,
      addPage: mockAddPage,
      save: mockSave,
    })),
  },
}));

jest.mock("expo-crypto", () => ({
  randomUUID: () => "aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa",
  getRandomBytes: (taille: number) => new Uint8Array(require("node:crypto").randomBytes(taille)),
}));

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

const mockEnregistrerElementLocal = jest.fn(async () => undefined);
jest.mock("../storage/db", () => ({
  enregistrerElementLocal: (...args: Parameters<typeof mockEnregistrerElementLocal>) =>
    mockEnregistrerElementLocal(...args),
}));

import {
  demarrerScan,
  estScanEnCours,
  ajouterPage,
  listerPages,
  supprimerPage,
  deplacerPage,
  terminerScan,
  annulerScan,
  reinitialiserSessionScan,
  AucunePageError,
  ScanDejaEnCoursError,
} from "./scanner";

beforeEach(() => {
  mockMagasinFichiers.clear();
  mockMagasinSecureStore.clear();
  jest.clearAllMocks();
  reinitialiserSessionScan();
});

describe("scan/scanner - session et pages", () => {
  it("demarre une session et refuse d'en demarrer une deuxieme", () => {
    expect(estScanEnCours()).toBe(false);
    demarrerScan();
    expect(estScanEnCours()).toBe(true);
    expect(() => demarrerScan()).toThrow(ScanDejaEnCoursError);
  });

  it("ajoute des pages dans l'ordre et transmet les coins au module natif", async () => {
    demarrerScan();
    const coins = [
      { x: 10, y: 10 },
      { x: 90, y: 12 },
      { x: 88, y: 130 },
      { x: 8, y: 128 },
    ];
    await ajouterPage("file:///cache/photo-brute-1.jpg", coins);
    expect(mockRedresser).toHaveBeenCalledWith("/cache/photo-brute-1.jpg", coins, expect.stringContaining("page-0.jpg"));
    expect(listerPages()).toHaveLength(1);

    await ajouterPage("file:///cache/photo-brute-2.jpg", coins);
    expect(listerPages()).toHaveLength(2);
  });

  it("supprime et reordonne les pages", async () => {
    demarrerScan();
    await ajouterPage("file:///cache/p1.jpg", []);
    await ajouterPage("file:///cache/p2.jpg", []);
    await ajouterPage("file:///cache/p3.jpg", []);
    const [p1, p2, p3] = listerPages();

    deplacerPage(2, 0); // p3 passe en premier
    expect(listerPages()).toEqual([p3, p1, p2]);

    supprimerPage(1); // retire p1 (maintenant a l'index 1)
    expect(listerPages()).toEqual([p3, p2]);
  });

  it("refuse de terminer un scan sans aucune page", async () => {
    demarrerScan();
    await expect(terminerScan({ dossierId: null, typeScan: "piece", noteTexte: null })).rejects.toThrow(
      AucunePageError
    );
  });

  it("assemble, chiffre et enregistre l'element pour un scan avec pages", async () => {
    demarrerScan();
    await ajouterPage("file:///cache/p1.jpg", []);
    await ajouterPage("file:///cache/p2.jpg", []);

    const element = await terminerScan({ dossierId: "dossier-1", typeScan: "courrier", noteTexte: "vu avec le client" });

    expect(element.type).toBe("scan");
    expect(element.statut).toBe("en_attente");
    expect(element.nombrePages).toBe(2);
    expect(element.typeScan).toBe("courrier");
    expect(element.dossierId).toBe("dossier-1");
    expect(element.noteTexte).toBe("vu avec le client");
    expect(mockEmbedJpg).toHaveBeenCalledTimes(2);
    expect(mockEnregistrerElementLocal).toHaveBeenCalledWith(element);

    // Session reinitialisee - un nouveau scan est de nouveau possible.
    expect(estScanEnCours()).toBe(false);

    // Le PDF chiffre a bien ete ecrit sur disque (relecture via
    // reconstituerPdfClair, teste indirectement ici par son existence).
    const cheminAttendu = "/document/scans-enc/aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa.enc";
    expect(mockMagasinFichiers.has(cheminAttendu)).toBe(true);
  });

  it("annulerScan nettoie la session sans rien enregistrer", async () => {
    demarrerScan();
    await ajouterPage("file:///cache/p1.jpg", []);
    annulerScan();
    expect(estScanEnCours()).toBe(false);
    expect(mockEnregistrerElementLocal).not.toHaveBeenCalled();
  });
});
