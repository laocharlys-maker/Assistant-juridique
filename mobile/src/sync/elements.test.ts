import type { ElementLocal } from "../storage/db";

// Pile en memoire simulant la table SQLite chiffree - les mocks de
// storage/db ci-dessous lisent/ecrivent directement dedans, comme le
// ferait la vraie base (meme principe que les autres suites de ce
// projet : scanner.test.ts, recorder.test.ts).
let mockElements: ElementLocal[] = [];

function mockTrouver(clientId: string): ElementLocal {
  const element = mockElements.find((e) => e.clientId === clientId);
  if (!element) throw new Error("element introuvable dans le mock");
  return element;
}

jest.mock("../storage/db", () => ({
  listerElementsLocaux: jest.fn(async () => mockElements.map((e) => ({ ...e }))),
  majStatutElementLocal: jest.fn(async (clientId: string, statut: ElementLocal["statut"]) => {
    mockTrouver(clientId).statut = statut;
  }),
  majErreurEnvoiElementLocal: jest.fn(async (clientId: string, message: string | null) => {
    mockTrouver(clientId).derniereErreurEnvoi = message;
  }),
  majEchecEnvoiElementLocal: jest.fn(
    async (clientId: string, message: string, prochaineTentativeAt: string | null, permanent: boolean) => {
      const element = mockTrouver(clientId);
      element.statut = "en_erreur";
      element.derniereErreurEnvoi = message;
      element.nombreTentatives = (element.nombreTentatives ?? 0) + 1;
      element.prochaineTentativeAt = prochaineTentativeAt;
      element.echecPermanent = permanent;
    }
  ),
  majProgressionEnvoiElementLocal: jest.fn(async (clientId: string, nombreChunksEnvoyes: number) => {
    mockTrouver(clientId).nombreChunksEnvoyes = nombreChunksEnvoyes;
  }),
}));

const mockEnvoyerRequeteAuthentifiee = jest.fn();
// La classe d'erreur DOIT etre definie DANS la factory (jamais une
// reference a une classe externe, meme prefixee "mock") : une reference
// directe a une const/classe hors-scope ne se comporte pas correctement a
// l'execution ici, contrairement a ce que la seule regle de hoisting
// documentee par Jest laisserait penser (constate empiriquement - voir
// aussi scan/scanner.test.ts et notes/notes.test.ts pour le meme
// contournement sur des fonctions).
jest.mock("../pairing/appareil", () => {
  class AppareilRevoqueError extends Error {
    constructor() {
      super("APPAREIL_REVOQUE");
    }
  }
  return {
    envoyerRequeteAuthentifiee: (...args: unknown[]) => mockEnvoyerRequeteAuthentifiee(...args),
    AppareilRevoqueError,
  };
});

const mockReconstituerAudioClair = jest.fn(async () => new TextEncoder().encode("0123456789"));
jest.mock("../audio/recorder", () => ({
  reconstituerAudioClair: (...args: Parameters<typeof mockReconstituerAudioClair>) =>
    mockReconstituerAudioClair(...args),
}));

jest.mock("../scan/scanner", () => ({
  reconstituerPdfClair: jest.fn(async () => new Uint8Array(0)),
}));

const mockSynchroniserDossiers = jest.fn(async () => true);
jest.mock("./dossiers", () => ({
  synchroniserDossiers: (...args: Parameters<typeof mockSynchroniserDossiers>) => mockSynchroniserDossiers(...args),
}));

import {
  envoyerElement,
  envoyerElementsEnAttente,
  compterElementsEnAttente,
  EnregistrementVideError,
} from "./elements";
import { AppareilRevoqueError } from "../pairing/appareil";

function nouvelElementAudio(partiel: Partial<ElementLocal> = {}): ElementLocal {
  return {
    clientId: `client-${Math.random()}`,
    type: "audio",
    statut: "en_attente",
    dossierId: null,
    creeLe: "2026-01-01T00:00:00.000Z",
    noteTexte: null,
    derniereErreurEnvoi: null,
    nombreSegments: 1,
    ...partiel,
  };
}

beforeEach(() => {
  mockElements = [];
  jest.clearAllMocks();
  mockReconstituerAudioClair.mockResolvedValue(new TextEncoder().encode("0123456789"));
  mockSynchroniserDossiers.mockResolvedValue(true);
});

describe("sync/elements - machine d'états (Prompt 6)", () => {
  it("passe par en_cours puis envoye en cas de succès, et resynchronise les dossiers", async () => {
    const element = nouvelElementAudio();
    mockElements.push(element);
    mockEnvoyerRequeteAuthentifiee.mockImplementation(async (chemin: string) => {
      if (chemin === "/api/m/items") return { itemId: "item-1" };
      return { ok: true };
    });

    await envoyerElement(element);

    expect(mockTrouver(element.clientId).statut).toBe("envoye");
    expect(mockTrouver(element.clientId).derniereErreurEnvoi).toBeNull();
    expect(mockSynchroniserDossiers).toHaveBeenCalledTimes(1);
  });

  it("reprend l'envoi des morceaux a partir de nombreChunksEnvoyes (reprise exacte, jamais depuis 0)", async () => {
    // Contenu de 10 octets, morceaux de taille normale (256 Ko) => 1 seul
    // morceau attendu - on force artificiellement nombreChunksEnvoyes a 1
    // (deja envoye) pour verifier qu'aucun chunk n'est reenvoye.
    const element = nouvelElementAudio({ nombreChunksEnvoyes: 1 });
    mockElements.push(element);
    const chemins: string[] = [];
    mockEnvoyerRequeteAuthentifiee.mockImplementation(async (chemin: string) => {
      chemins.push(chemin);
      if (chemin === "/api/m/items") return { itemId: "item-1" };
      return { ok: true };
    });

    await envoyerElement(element);

    expect(chemins.some((c) => c.includes("/chunks/"))).toBe(false);
    expect(mockTrouver(element.clientId).statut).toBe("envoye");
  });

  it("échec permanent (appareil révoqué) : statut en_erreur, jamais retenté automatiquement", async () => {
    const element = nouvelElementAudio();
    mockElements.push(element);
    mockEnvoyerRequeteAuthentifiee.mockRejectedValue(new AppareilRevoqueError());

    // envoyerElement propage l'erreur (envoyerElementsEnAttente, lui,
    // l'avale pour ne pas bloquer les autres elements - voir plus bas).
    await expect(envoyerElement(element)).rejects.toThrow(AppareilRevoqueError);
    const apres = mockTrouver(element.clientId);
    expect(apres.statut).toBe("en_erreur");
    expect(apres.echecPermanent).toBe(true);
    expect(apres.derniereErreurEnvoi).toContain("révoqué");

    // Un nouveau passage de la file ne doit PAS retenter cet element.
    mockEnvoyerRequeteAuthentifiee.mockClear();
    await envoyerElementsEnAttente();
    expect(mockEnvoyerRequeteAuthentifiee).not.toHaveBeenCalled();
  });

  it("échec transitoire : statut en_erreur avec délai, puis retenté automatiquement une fois l'échéance passée", async () => {
    const element = nouvelElementAudio();
    mockElements.push(element);
    mockEnvoyerRequeteAuthentifiee.mockRejectedValueOnce(new Error("Aurore injoignable"));

    await envoyerElementsEnAttente();
    const apresEchec = mockTrouver(element.clientId);
    expect(apresEchec.statut).toBe("en_erreur");
    expect(apresEchec.echecPermanent).toBeFalsy();
    expect(apresEchec.prochaineTentativeAt).not.toBeNull();

    // Pas encore l'heure de retenter : aucun nouvel appel.
    mockEnvoyerRequeteAuthentifiee.mockClear();
    await envoyerElementsEnAttente();
    expect(mockEnvoyerRequeteAuthentifiee).not.toHaveBeenCalled();

    // L'echeance est passee : retente automatiquement, et reussit cette fois.
    mockTrouver(element.clientId).prochaineTentativeAt = new Date(Date.now() - 1000).toISOString();
    mockEnvoyerRequeteAuthentifiee.mockImplementation(async (chemin: string) =>
      chemin === "/api/m/items" ? { itemId: "item-1" } : { ok: true }
    );
    await envoyerElementsEnAttente();
    expect(mockTrouver(element.clientId).statut).toBe("envoye");
  });

  it("un enregistrement vide est un échec permanent, jamais retenté", async () => {
    const element = nouvelElementAudio({ nombreSegments: 0 });
    mockElements.push(element);
    mockReconstituerAudioClair.mockResolvedValueOnce(new Uint8Array(0));

    await envoyerElementsEnAttente();
    const apres = mockTrouver(element.clientId);
    expect(apres.statut).toBe("en_erreur");
    expect(apres.echecPermanent).toBe(true);
    expect(() => new EnregistrementVideError()).not.toThrow();
  });

  it("compterElementsEnAttente compte tout sauf confirme", () => {
    const liste: ElementLocal[] = [
      nouvelElementAudio({ statut: "en_attente" }),
      nouvelElementAudio({ statut: "en_cours" }),
      nouvelElementAudio({ statut: "en_erreur" }),
      nouvelElementAudio({ statut: "envoye" }),
      nouvelElementAudio({ statut: "confirme" }),
    ];
    expect(compterElementsEnAttente(liste)).toBe(4);
  });
});
