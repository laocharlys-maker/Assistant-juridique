const mockEnregistrerElementLocal = jest.fn(async () => undefined);
const mockObtenirElementLocal = jest.fn();
jest.mock("../storage/db", () => ({
  enregistrerElementLocal: (...args: Parameters<typeof mockEnregistrerElementLocal>) =>
    mockEnregistrerElementLocal(...args),
  obtenirElementLocal: (...args: Parameters<typeof mockObtenirElementLocal>) => mockObtenirElementLocal(...args),
}));

jest.mock("expo-crypto", () => ({
  randomUUID: () => "bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb",
}));

import { creerNoteLocale, joindreNoteAElement, NoteVideError, ElementIntrouvableError, ElementDejaEnvoyeError } from "./notes";
import type { ElementLocal } from "../storage/db";

beforeEach(() => {
  jest.clearAllMocks();
});

describe("notes - note autonome", () => {
  it("cree une note rattachee a un dossier", async () => {
    const element = await creerNoteLocale("  Appeler le client demain  ", "dossier-1");
    expect(element.type).toBe("note");
    expect(element.statut).toBe("en_attente");
    expect(element.dossierId).toBe("dossier-1");
    expect(element.noteTexte).toBe("Appeler le client demain"); // espaces superflus retires
    expect(mockEnregistrerElementLocal).toHaveBeenCalledWith(element);
  });

  it("refuse une note vide (y compris seulement des espaces)", async () => {
    await expect(creerNoteLocale("   ", null)).rejects.toThrow(NoteVideError);
    expect(mockEnregistrerElementLocal).not.toHaveBeenCalled();
  });
});

describe("notes - jointe a un element existant", () => {
  const elementEnAttente: ElementLocal = {
    clientId: "client-1",
    type: "audio",
    statut: "en_attente",
    dossierId: null,
    creeLe: "2026-01-01T00:00:00.000Z",
    noteTexte: null,
    derniereErreurEnvoi: null,
  };

  it("remplace le noteTexte d'un element en attente", async () => {
    mockObtenirElementLocal.mockResolvedValueOnce({ ...elementEnAttente });
    const element = await joindreNoteAElement("client-1", "vu avec le confrere");
    expect(element.noteTexte).toBe("vu avec le confrere");
    expect(mockEnregistrerElementLocal).toHaveBeenCalledWith(element);
  });

  it("refuse si l'element est introuvable", async () => {
    mockObtenirElementLocal.mockResolvedValueOnce(null);
    await expect(joindreNoteAElement("inconnu", "texte")).rejects.toThrow(ElementIntrouvableError);
  });

  it("refuse si l'element a deja ete envoye", async () => {
    mockObtenirElementLocal.mockResolvedValueOnce({ ...elementEnAttente, statut: "envoye" });
    await expect(joindreNoteAElement("client-1", "texte")).rejects.toThrow(ElementDejaEnvoyeError);
  });

  it("refuse un texte vide", async () => {
    mockObtenirElementLocal.mockResolvedValueOnce({ ...elementEnAttente });
    await expect(joindreNoteAElement("client-1", "   ")).rejects.toThrow(NoteVideError);
  });
});
