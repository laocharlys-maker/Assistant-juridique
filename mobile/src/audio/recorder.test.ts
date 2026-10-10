// Systeme de fichiers en memoire - expo-file-system est un module natif
// (aucun binaire sous Jest). N'implemente que le sous-ensemble de l'API
// Directory/File reellement utilise par recorder.ts. Tout est declare a
// l'interieur de la factory jest.mock() (hoistee au-dessus des imports) -
// seuls les noms prefixes par "mock" peuvent en sortir, voir
// db.test.ts pour le meme principe avec expo-sqlite.
const mockMagasinFichiers = new Map<string, Uint8Array>();

jest.mock("expo-file-system", () => {
  function cheminDepuisUri(uri: string): string {
    return uri.replace(/^file:\/\//, "");
  }

  class MockDirectory {
    uri: string;
    constructor(...parties: Array<string | MockDirectory | MockFile>) {
      this.uri = parties.map((p) => (typeof p === "string" ? p : p.uri)).join("/");
    }
    get exists() {
      return Array.from(mockMagasinFichiers.keys()).some((c) => c.startsWith(this.uri));
    }
    create() {
      /* no-op pour le faux systeme de fichiers - les ecritures de File suffisent */
    }
    delete() {
      for (const cle of Array.from(mockMagasinFichiers.keys())) {
        if (cle.startsWith(this.uri)) mockMagasinFichiers.delete(cle);
      }
    }
  }

  class MockFile {
    uri: string;
    constructor(...parties: Array<string | MockDirectory | MockFile>) {
      this.uri = parties.map((p) => (typeof p === "string" ? p : p.uri)).join("/");
    }
    get exists() {
      return mockMagasinFichiers.has(cheminDepuisUri(this.uri));
    }
    get size() {
      return mockMagasinFichiers.get(cheminDepuisUri(this.uri))?.length ?? 0;
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

// Module natif - aucun enregistrement reel sous Jest. Les segments
// "termines" sont injectes manuellement par chaque test via
// mockSegmentsEnAttente.
let mockSegmentsEnAttente: { chemin: string; dureeMs: number; numero: number }[] = [];
const mockDemarrer = jest.fn();
const mockMettreEnPause = jest.fn();
const mockReprendre = jest.fn();
const mockArreter = jest.fn();
jest.mock("../../modules/audio-recorder/src/AudioRecorderModule", () => ({
  __esModule: true,
  default: {
    demarrer: (...args: unknown[]) => mockDemarrer(...args),
    mettreEnPause: (...args: unknown[]) => mockMettreEnPause(...args),
    reprendre: (...args: unknown[]) => mockReprendre(...args),
    arreter: (...args: unknown[]) => mockArreter(...args),
    niveauSonore: () => 1234,
    recupererSegmentsTermines: () => {
      const copie = mockSegmentsEnAttente;
      mockSegmentsEnAttente = [];
      return copie;
    },
    etat: () => ({ enCours: true, enPause: false, derniereErreur: null }),
  },
}));

jest.mock("expo-crypto", () => ({
  randomUUID: () => "11111111-1111-1111-1111-111111111111",
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

jest.mock("../storage/db", () => ({
  enregistrerElementLocal: jest.fn(async () => undefined),
}));

import {
  demarrerEnregistrement,
  mettreEnPause,
  reprendre,
  dureeEcouleeMs,
  ajouterMarqueur,
  definirDateProchaineAudience,
  marqueursActuels,
  arreterEtEnregistrer,
  reconstituerAudioClair,
  _reinitialiserSessionPourTests,
} from "./recorder";
import { enregistrerElementLocal } from "../storage/db";

function ajouterSegmentFictif(numero: number, dureeMs: number, octets: Uint8Array) {
  const chemin = `/cache/audio-tmp/11111111-1111-1111-1111-111111111111/segment-${numero}.aac`;
  mockMagasinFichiers.set(chemin, octets);
  mockSegmentsEnAttente.push({ chemin: chemin, dureeMs, numero });
}

beforeEach(() => {
  mockMagasinFichiers.clear();
  mockSegmentsEnAttente = [];
  jest.clearAllMocks();
  _reinitialiserSessionPourTests();
});

describe("audio/recorder - repères et chronologie", () => {
  it("un repère posé juste après le départ a une position proche de zéro", async () => {
    jest.spyOn(Date, "now").mockReturnValue(1_000_000);
    await demarrerEnregistrement();
    jest.spyOn(Date, "now").mockReturnValue(1_000_500);
    ajouterMarqueur("decision");
    expect(marqueursActuels()[0]).toEqual({ type: "decision", positionMs: 500, dateAudience: null });
  });

  it("la pause n'avance pas le chrono", async () => {
    jest.spyOn(Date, "now").mockReturnValue(2_000_000);
    await demarrerEnregistrement();
    jest.spyOn(Date, "now").mockReturnValue(2_010_000);
    // En reel, le service natif finalise le segment en cours des la mise en
    // pause (voir EnregistrementService.ACTION_PAUSE) - on simule ici le
    // segment de 10s qu'il aurait signale a ce moment-la.
    ajouterSegmentFictif(0, 10000, new TextEncoder().encode("segment"));
    await mettreEnPause();
    expect(dureeEcouleeMs()).toBe(10000);

    // Pendant la pause, le temps qui passe ne doit jamais etre compte.
    jest.spyOn(Date, "now").mockReturnValue(2_999_999);
    expect(dureeEcouleeMs()).toBe(10000);

    jest.spyOn(Date, "now").mockReturnValue(3_000_000);
    reprendre();
    jest.spyOn(Date, "now").mockReturnValue(3_005_000);
    expect(dureeEcouleeMs()).toBe(15000);
  });

  it("attache une date au dernier repère 'Prochaine audience' posé", async () => {
    jest.spyOn(Date, "now").mockReturnValue(5_000_000);
    await demarrerEnregistrement();
    ajouterMarqueur("prochaine_audience");
    definirDateProchaineAudience("2026-11-05T09:00:00.000Z");
    expect(marqueursActuels()[0].dateAudience).toBe("2026-11-05T09:00:00.000Z");
  });
});

describe("audio/recorder - file de segments", () => {
  it("chiffre chaque segment dès qu'il est signalé et supprime le fichier en clair", async () => {
    jest.spyOn(Date, "now").mockReturnValue(10_000_000);
    await demarrerEnregistrement();

    ajouterSegmentFictif(0, 20000, new TextEncoder().encode("segment-zero"));
    // La pompe de segments tourne sur un setInterval (2s) - on la declenche
    // manuellement ici via mettreEnPause, qui draine toujours en attendant.
    await mettreEnPause();

    expect(mockMagasinFichiers.has("/cache/audio-tmp/11111111-1111-1111-1111-111111111111/segment-0.aac")).toBe(false);
    expect(
      mockMagasinFichiers.has("/document/audio-enc/11111111-1111-1111-1111-111111111111/segment-0.enc")
    ).toBe(true);
  });

  it("reconstitue l'audio en clair dans le bon ordre à partir des segments chiffrés", async () => {
    jest.spyOn(Date, "now").mockReturnValue(20_000_000);
    await demarrerEnregistrement();

    ajouterSegmentFictif(0, 20000, new TextEncoder().encode("AAA"));
    await mettreEnPause();
    reprendre();
    ajouterSegmentFictif(1, 20000, new TextEncoder().encode("BBB"));
    await mettreEnPause();

    const element = await arreterEtEnregistrer({ dossierId: null, noteTexte: null });
    expect(element.nombreSegments).toBe(2);
    expect(enregistrerElementLocal).toHaveBeenCalled();

    const audio = await reconstituerAudioClair(element.clientId, element.nombreSegments);
    expect(new TextDecoder().decode(audio)).toBe("AAABBB");
  });
});
