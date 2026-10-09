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

import {
  parserQr,
  demanderAppairage,
  estAppaire,
  oublierAppairage,
  envoyerRequeteAuthentifiee,
  QrExpireError,
  SecretInvalideError,
  PcIntrouvableError,
} from "./appareil";
import {
  genererPaireClesTelephone,
  clePubliqueVersBase64,
  clePubliqueDepuisBase64,
  calculerCleParGesee,
  dechiffrerEnveloppe,
} from "../crypto/protocol";

const QR_VALIDE = {
  v: 1,
  pairingId: "pairing-1",
  secret: "c2VjcmV0LWRlLXRlc3Q=",
  clePubliquePC: clePubliqueVersBase64(genererPaireClesTelephone().clePubliqueRaw),
  adresses: ["192.168.1.10:3100", "192.168.1.11:3100"],
};

beforeEach(() => {
  mockMagasin.clear();
  (global as unknown as { fetch: jest.Mock }).fetch = jest.fn();
});

describe("parserQr", () => {
  it("accepte un contenu QR valide", () => {
    const parse = parserQr(JSON.stringify(QR_VALIDE));
    expect(parse.pairingId).toBe("pairing-1");
  });

  it("rejette un JSON illisible", () => {
    expect(() => parserQr("pas du json")).toThrow("QR_ILLISIBLE");
  });

  it("rejette un contenu auquel il manque un champ obligatoire", () => {
    expect(() => parserQr(JSON.stringify({ v: 1, pairingId: "x" }))).toThrow("QR_ILLISIBLE");
  });
});

describe("demanderAppairage", () => {
  it("réussit avec la première adresse qui répond, et stocke le contexte d'appairage", async () => {
    const fetchMock = global.fetch as jest.Mock;
    fetchMock.mockResolvedValueOnce({ ok: true, status: 201, json: async () => ({ deviceId: "device-1", statut: "en_attente" }) });

    const resultat = await demanderAppairage(QR_VALIDE, "Mon téléphone");
    expect(resultat).toEqual({ deviceId: "device-1", statut: "en_attente" });
    expect(await estAppaire()).toBe(true);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(fetchMock.mock.calls[0][0]).toBe("http://192.168.1.10:3100/api/m/appairage/demander");
  });

  it("essaie l'adresse suivante si la première est injoignable (réseau)", async () => {
    const fetchMock = global.fetch as jest.Mock;
    fetchMock.mockRejectedValueOnce(new Error("ECONNREFUSED"));
    fetchMock.mockResolvedValueOnce({ ok: true, status: 201, json: async () => ({ deviceId: "device-2", statut: "en_attente" }) });

    const resultat = await demanderAppairage(QR_VALIDE, "Mon téléphone");
    expect(resultat.deviceId).toBe("device-2");
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(fetchMock.mock.calls[1][0]).toBe("http://192.168.1.11:3100/api/m/appairage/demander");
  });

  it("lève PcIntrouvableError si aucune adresse ne répond", async () => {
    const fetchMock = global.fetch as jest.Mock;
    fetchMock.mockRejectedValue(new Error("ECONNREFUSED"));
    await expect(demanderAppairage(QR_VALIDE, "Mon téléphone")).rejects.toThrow(PcIntrouvableError);
  });

  it("lève QrExpireError sur une réponse 410 (jamais d'essai sur l'adresse suivante)", async () => {
    const fetchMock = global.fetch as jest.Mock;
    fetchMock.mockResolvedValueOnce({ ok: false, status: 410, json: async () => ({ error: "expiré" }) });
    await expect(demanderAppairage(QR_VALIDE, "Mon téléphone")).rejects.toThrow(QrExpireError);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("lève SecretInvalideError sur une réponse 401", async () => {
    const fetchMock = global.fetch as jest.Mock;
    fetchMock.mockResolvedValueOnce({ ok: false, status: 401, json: async () => ({ error: "secret invalide" }) });
    await expect(demanderAppairage(QR_VALIDE, "Mon téléphone")).rejects.toThrow(SecretInvalideError);
  });
});

describe("oublierAppairage", () => {
  it("efface tout le contexte d'appairage stocké", async () => {
    (global.fetch as jest.Mock).mockResolvedValueOnce({ ok: true, status: 201, json: async () => ({ deviceId: "device-1", statut: "en_attente" }) });
    await demanderAppairage(QR_VALIDE, "Mon téléphone");
    expect(await estAppaire()).toBe(true);
    await oublierAppairage();
    expect(await estAppaire()).toBe(false);
  });
});

describe("envoyerRequeteAuthentifiee", () => {
  async function appairer() {
    (global.fetch as jest.Mock).mockResolvedValueOnce({
      ok: true,
      status: 201,
      json: async () => ({ deviceId: "device-xyz", statut: "autorise" }),
    });
    await demanderAppairage(QR_VALIDE, "Mon téléphone");
  }

  it("chiffre correctement la requête - un « serveur » qui possède la vraie clé privée PC peut la déchiffrer", async () => {
    // Genere une VRAIE paire PC pour ce test precis (QR_VALIDE partage
    // utilise une cle publique flottante, sans cle privee correspondante -
    // insuffisant pour verifier un dechiffrement reel).
    const pc = genererPaireClesTelephone();
    const qrAvecVraiePc = { ...QR_VALIDE, clePubliquePC: clePubliqueVersBase64(pc.clePubliqueRaw) };
    (global.fetch as jest.Mock).mockResolvedValueOnce({
      ok: true,
      status: 201,
      json: async () => ({ deviceId: "device-xyz", statut: "autorise" }),
    });
    await demanderAppairage(qrAvecVraiePc, "Mon téléphone");

    const clePubliqueTelephoneB64 = mockMagasin.get("aurore_mobile_cle_publique_v1")!;
    const clePubliqueTelephone = clePubliqueDepuisBase64(clePubliqueTelephoneB64);

    let corpsIntercepte: { deviceId: string; compteur: number; horodatage: number; enveloppe: string } | null = null;
    (global.fetch as jest.Mock).mockImplementationOnce(async (_url: string, options: { body: string }) => {
      corpsIntercepte = JSON.parse(options.body);
      return { ok: true, json: async () => ({ ok: true }) };
    });

    await envoyerRequeteAuthentifiee("/api/m/ping", { test: true });
    expect(corpsIntercepte).not.toBeNull();
    const { deviceId, compteur, horodatage, enveloppe } = corpsIntercepte!;
    expect(deviceId).toBe("device-xyz");
    expect(compteur).toBe(1);

    // Le "serveur" (simule ici) recalcule SK depuis SA cle privee + la cle
    // publique du telephone - EXACTEMENT ce que fait
    // backend/src/middleware/mobileDeviceAuth.ts en realite.
    const skCoteServeur = calculerCleParGesee(pc.clePriveeRaw, clePubliqueTelephone, deviceId);
    const aad = new TextEncoder().encode(JSON.stringify({ deviceId, compteur, horodatage }));
    const plaintext = dechiffrerEnveloppe(skCoteServeur, enveloppe, aad);
    expect(JSON.parse(new TextDecoder().decode(plaintext))).toEqual({ test: true });
  });

  it("incrémente le compteur à chaque requête (jamais répété)", async () => {
    await appairer();
    const compteurs: number[] = [];
    (global.fetch as jest.Mock).mockImplementation(async (_url: string, options: { body: string }) => {
      compteurs.push(JSON.parse(options.body).compteur);
      return { ok: true, json: async () => ({ ok: true }) };
    });

    await envoyerRequeteAuthentifiee("/api/m/ping", {});
    await envoyerRequeteAuthentifiee("/api/m/ping", {});
    await envoyerRequeteAuthentifiee("/api/m/ping", {});
    expect(compteurs).toEqual([1, 2, 3]);
  });

  it("lève une erreur explicite si l'appareil n'est pas (encore) appairé", async () => {
    await expect(envoyerRequeteAuthentifiee("/api/m/ping", {})).rejects.toThrow("APPAREIL_NON_APPAIRE");
  });

  it("propage le message d'erreur du serveur quand la réponse n'est pas ok", async () => {
    await appairer();
    (global.fetch as jest.Mock).mockResolvedValueOnce({ ok: false, status: 403, json: async () => ({ error: "Appareil révoqué" }) });
    await expect(envoyerRequeteAuthentifiee("/api/m/dossiers", {})).rejects.toThrow("Appareil révoqué");
  });
});
