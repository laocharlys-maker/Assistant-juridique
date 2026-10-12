const mockMagasinFichiers = new Map<string, string>();

jest.mock("expo-file-system", () => {
  class MockDirectory {
    uri: string;
    constructor(...parties: (string | MockDirectory | MockFile)[]) {
      this.uri = parties.map((p) => (typeof p === "string" ? p : p.uri)).join("/");
    }
    create() {
      /* no-op */
    }
  }
  class MockFile {
    uri: string;
    constructor(...parties: (string | MockDirectory | MockFile)[]) {
      this.uri = parties.map((p) => (typeof p === "string" ? p : p.uri)).join("/");
    }
    get exists() {
      return mockMagasinFichiers.has(this.uri);
    }
    write(contenu: string) {
      mockMagasinFichiers.set(this.uri, contenu);
    }
    delete() {
      mockMagasinFichiers.delete(this.uri);
    }
    async text(): Promise<string> {
      return mockMagasinFichiers.get(this.uri) ?? "";
    }
  }
  return { Directory: MockDirectory, File: MockFile, Paths: { document: "file:///document" } };
});

const mockIsAvailableAsync = jest.fn(async () => true);
const mockShareAsync = jest.fn(async (_uri: string, _options?: unknown) => undefined);
jest.mock("expo-sharing", () => ({
  isAvailableAsync: (...args: Parameters<typeof mockIsAvailableAsync>) => mockIsAvailableAsync(...args),
  shareAsync: (...args: Parameters<typeof mockShareAsync>) => mockShareAsync(...args),
}));

import { consignerErreur, listerJournal, exporterJournal, viderJournal, PartageIndisponibleError } from "./journal";

beforeEach(() => {
  mockMagasinFichiers.clear();
  jest.clearAllMocks();
});

describe("logs/journal (Prompt 7, objectif B)", () => {
  it("consigne une entree avec horodatage, contexte et message", async () => {
    await consignerErreur("envoi_element", "type=audio Aurore introuvable sur ce réseau");
    const entrees = await listerJournal();
    expect(entrees).toHaveLength(1);
    expect(entrees[0].contexte).toBe("envoi_element");
    expect(entrees[0].message).toContain("Aurore introuvable");
    expect(new Date(entrees[0].horodatage).getTime()).not.toBeNaN();
  });

  it("plafonne le nombre d'entrees conservees (pas de croissance illimitee)", async () => {
    for (let i = 0; i < 510; i++) {
      await consignerErreur("test", `message-${i}`);
    }
    const entrees = await listerJournal();
    expect(entrees.length).toBeLessThanOrEqual(500);
    // Les plus recentes sont conservees, pas les plus anciennes.
    expect(entrees[entrees.length - 1].message).toBe("message-509");
  });

  it("exporterJournal ouvre le partage natif sur le fichier du journal", async () => {
    await consignerErreur("test", "un message");
    await exporterJournal();
    expect(mockShareAsync).toHaveBeenCalledTimes(1);
    expect(mockShareAsync.mock.calls[0][0]).toContain("journal-erreurs.ndjson");
  });

  it("leve PartageIndisponibleError si le partage n'est pas disponible sur l'appareil", async () => {
    mockIsAvailableAsync.mockResolvedValueOnce(false);
    await expect(exporterJournal()).rejects.toThrow(PartageIndisponibleError);
  });

  it("viderJournal supprime le fichier - plus aucune entree ensuite", async () => {
    await consignerErreur("test", "un message");
    await viderJournal();
    expect(await listerJournal()).toHaveLength(0);
  });

  it("n'echoue jamais meme si l'ecriture sous-jacente leve une exception", async () => {
    const DirectoryReel = require("expo-file-system").Directory;
    jest.spyOn(DirectoryReel.prototype, "create").mockImplementationOnce(() => {
      throw new Error("disque plein");
    });
    await expect(consignerErreur("test", "message")).resolves.toBeUndefined();
  });
});
