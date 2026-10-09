import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import express from "express";
import type { Server } from "node:http";
import crypto from "node:crypto";
import {
  genererPaireClesX25519,
  importerClePubliqueBase64,
  calculerCleParGesee,
  chiffrerEnveloppe,
  genererSecretAppairage,
} from "../../services/mobileSync/crypto";

const prismaMock = vi.hoisted(() => ({
  mobilePairingSecret: { findUnique: vi.fn(), update: vi.fn() },
  mobileDevice: { create: vi.fn(), findUnique: vi.fn(), findFirst: vi.fn(), update: vi.fn() },
  mobileItem: { findUnique: vi.fn(), findFirst: vi.fn(), create: vi.fn(), update: vi.fn() },
  mobileAuditLog: { create: vi.fn() },
  dossier: { findFirst: vi.fn(), findMany: vi.fn() },
  roleAudience: { findMany: vi.fn() },
  user: { findUnique: vi.fn() },
  $transaction: vi.fn(),
}));
vi.mock("../../lib/prisma", () => ({ prisma: prismaMock }));

// Cle PC fixe pour tout le fichier - resoudreClesCabinet() ne touche jamais
// la vraie base/le vrai disque dans ce test (isole de mobileKeys.ts).
const pc = genererPaireClesX25519();
const resoudreClesCabinetMock = vi.hoisted(() => vi.fn());
vi.mock("../../services/mobileSync/mobileKeys", () => ({
  resoudreClesCabinet: resoudreClesCabinetMock,
}));

const getAccessibleAvocatIdsMock = vi.hoisted(() => vi.fn());
vi.mock("../../services/access", () => ({ getAccessibleAvocatIds: getAccessibleAvocatIdsMock }));

vi.mock("../../services/mobileSync/stockageMobile", () => ({
  ecrireChunk: vi.fn(),
  assemblerEtVerifier: vi.fn().mockResolvedValue({ nomFichier: "fichier-test.enc", tailleOctets: 42 }),
}));

let server: Server;
let baseUrl: string;

async function api(path: string, body?: unknown) {
  return fetch(`${baseUrl}${path}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: body !== undefined ? JSON.stringify(body) : undefined,
  });
}

/** Construit le corps d'une requete authentifiee par enveloppe, exactement
 * comme le ferait le telephone (voir docs/lot10/01-protocole.md section 4). */
function construireRequeteAppareil(
  telPrivee: crypto.KeyObject,
  deviceId: string,
  compteur: number,
  payload: unknown
) {
  const sk = calculerCleParGesee(telPrivee, importerClePubliqueBase64(pc.clePubliqueBase64), deviceId);
  const horodatage = Date.now();
  const aad = Buffer.from(JSON.stringify({ deviceId, compteur, horodatage }));
  const enveloppe = chiffrerEnveloppe(sk, Buffer.from(JSON.stringify(payload ?? {})), aad);
  return { deviceId, compteur, horodatage, enveloppe };
}

beforeEach(() => {
  vi.clearAllMocks();
  resoudreClesCabinetMock.mockResolvedValue({
    clePubliqueBase64: pc.clePubliqueBase64,
    clePriveeKeyObject: pc.clePriveeKeyObject,
  });
  prismaMock.$transaction.mockImplementation(async (ops: unknown[]) => Promise.all(ops));
});

beforeAll(async () => {
  const { mobileSyncRouter } = await import("../mobileSync");
  const app = express();
  app.use(express.json());
  app.use(mobileSyncRouter);
  server = app.listen(0);
  await new Promise((resolve) => server.once("listening", resolve));
  const port = (server.address() as { port: number }).port;
  baseUrl = `http://127.0.0.1:${port}`;
});

afterAll(() => {
  server?.close();
});

describe("POST /api/m/appairage/demander", () => {
  it("crée l'appareil (en_attente) quand le secret correspond au hash stocké", async () => {
    const { secretBase64, secretHash } = genererSecretAppairage();
    const tel = genererPaireClesX25519();
    prismaMock.mobilePairingSecret.findUnique.mockResolvedValue({
      id: "pairing-1",
      cabinetId: "cabinet-1",
      userId: "user-1",
      secretHash,
      utilise: false,
      expireAt: new Date(Date.now() + 5 * 60 * 1000),
    });
    prismaMock.mobileDevice.create.mockResolvedValue({ id: "device-1", statut: "en_attente" });
    prismaMock.mobilePairingSecret.update.mockResolvedValue({});

    const res = await api("/api/m/appairage/demander", {
      pairingId: "11111111-1111-1111-1111-111111111111",
      secret: secretBase64,
      clePubliqueTelephone: tel.clePubliqueBase64,
      nomAppareil: "Pixel de test",
    });

    expect(res.status).toBe(201);
    const body = await res.json();
    expect(body).toEqual({ deviceId: "device-1", statut: "en_attente" });
  });

  it("rejette (410) un appairage déjà utilisé", async () => {
    const { secretBase64, secretHash } = genererSecretAppairage();
    prismaMock.mobilePairingSecret.findUnique.mockResolvedValue({
      id: "pairing-2",
      cabinetId: "cabinet-1",
      userId: "user-1",
      secretHash,
      utilise: true,
      expireAt: new Date(Date.now() + 5 * 60 * 1000),
    });

    const res = await api("/api/m/appairage/demander", {
      pairingId: "22222222-2222-2222-2222-222222222222",
      secret: secretBase64,
      clePubliqueTelephone: genererPaireClesX25519().clePubliqueBase64,
      nomAppareil: "Test",
    });
    expect(res.status).toBe(410);
  });

  it("rejette (410) un appairage expiré", async () => {
    const { secretBase64, secretHash } = genererSecretAppairage();
    prismaMock.mobilePairingSecret.findUnique.mockResolvedValue({
      id: "pairing-3",
      cabinetId: "cabinet-1",
      userId: "user-1",
      secretHash,
      utilise: false,
      expireAt: new Date(Date.now() - 1000),
    });

    const res = await api("/api/m/appairage/demander", {
      pairingId: "33333333-3333-3333-3333-333333333333",
      secret: secretBase64,
      clePubliqueTelephone: genererPaireClesX25519().clePubliqueBase64,
      nomAppareil: "Test",
    });
    expect(res.status).toBe(410);
  });

  it("rejette (401) un secret qui ne correspond pas au hash stocké", async () => {
    const { secretHash } = genererSecretAppairage();
    const { secretBase64: autreSecret } = genererSecretAppairage();
    prismaMock.mobilePairingSecret.findUnique.mockResolvedValue({
      id: "pairing-4",
      cabinetId: "cabinet-1",
      userId: "user-1",
      secretHash,
      utilise: false,
      expireAt: new Date(Date.now() + 5 * 60 * 1000),
    });

    const res = await api("/api/m/appairage/demander", {
      pairingId: "44444444-4444-4444-4444-444444444444",
      secret: autreSecret,
      clePubliqueTelephone: genererPaireClesX25519().clePubliqueBase64,
      nomAppareil: "Test",
    });
    expect(res.status).toBe(401);
  });
});

describe("authentification par enveloppe (POST /api/m/ping)", () => {
  it("accepte une requête correctement chiffrée et renvoie le cabinetId de l'appareil", async () => {
    const tel = genererPaireClesX25519();
    const deviceId = "8d0998df-6c2e-4d67-90f0-0a33226f4991";
    prismaMock.mobileDevice.findUnique.mockResolvedValue({
      id: deviceId,
      cabinetId: "cabinet-1",
      userId: "user-1",
      statut: "autorise",
      clePublique: tel.clePubliqueBase64,
      dernierCompteur: null,
    });
    prismaMock.mobileDevice.update.mockResolvedValue({});

    const res = await api("/api/m/ping", construireRequeteAppareil(tel.clePriveeKeyObject, deviceId, 1, {}));
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body).toEqual({ ok: true, cabinetId: "cabinet-1" });
  });

  it("rejette (401) une enveloppe chiffrée avec la mauvaise clé privée (imposteur)", async () => {
    const tel = genererPaireClesX25519();
    const imposteur = genererPaireClesX25519();
    const deviceId = "bbe46473-1962-4873-82d5-28b4fa4f4228";
    prismaMock.mobileDevice.findUnique.mockResolvedValue({
      id: deviceId,
      cabinetId: "cabinet-1",
      userId: "user-1",
      statut: "autorise",
      clePublique: tel.clePubliqueBase64, // la cle ENREGISTREE est celle du vrai telephone
      dernierCompteur: null,
    });

    // L'imposteur chiffre avec SA PROPRE cle privee, pas celle du vrai
    // telephone associe a ce deviceId - le serveur recalcule SK a partir de
    // la cle publique ENREGISTREE (celle du vrai telephone), donc la
    // verification echoue.
    const res = await api("/api/m/ping", construireRequeteAppareil(imposteur.clePriveeKeyObject, deviceId, 1, {}));
    expect(res.status).toBe(401);
  });

  it("rejette (409) une requête rejouée (même compteur, ou inférieur, qu'une requête déjà acceptée)", async () => {
    const tel = genererPaireClesX25519();
    const deviceId = "c262544c-d51c-493f-bbb8-ba134a39a374";
    prismaMock.mobileDevice.findUnique.mockResolvedValue({
      id: deviceId,
      cabinetId: "cabinet-1",
      userId: "user-1",
      statut: "autorise",
      clePublique: tel.clePubliqueBase64,
      dernierCompteur: 5, // une requete avec compteur=5 ou moins a deja ete acceptee
    });

    const res = await api("/api/m/ping", construireRequeteAppareil(tel.clePriveeKeyObject, deviceId, 5, {}));
    expect(res.status).toBe(409);
  });

  it("rejette (401) un appareil inconnu", async () => {
    const tel = genererPaireClesX25519();
    prismaMock.mobileDevice.findUnique.mockResolvedValue(null);
    const res = await api(
      "/api/m/ping",
      construireRequeteAppareil(tel.clePriveeKeyObject, "d3163c40-02ef-49bd-bb48-0d3bb47f2600", 1, {})
    );
    expect(res.status).toBe(401);
  });

  it("rejette (401) un horodatage trop décalé de l'horloge serveur", async () => {
    const tel = genererPaireClesX25519();
    const deviceId = "db593512-e40d-43fa-ad29-d15cc0241095";
    prismaMock.mobileDevice.findUnique.mockResolvedValue({
      id: deviceId,
      cabinetId: "cabinet-1",
      userId: "user-1",
      statut: "autorise",
      clePublique: tel.clePubliqueBase64,
      dernierCompteur: null,
    });

    const sk = calculerCleParGesee(tel.clePriveeKeyObject, importerClePubliqueBase64(pc.clePubliqueBase64), deviceId);
    const horodatageDecale = Date.now() - 10 * 60 * 1000; // 10 minutes dans le passe
    const aad = Buffer.from(JSON.stringify({ deviceId, compteur: 1, horodatage: horodatageDecale }));
    const enveloppe = chiffrerEnveloppe(sk, Buffer.from("{}"), aad);

    const res = await api("/api/m/ping", { deviceId, compteur: 1, horodatage: horodatageDecale, enveloppe });
    expect(res.status).toBe(401);
  });
});

describe("accès réservé aux appareils autorisés (POST /api/m/dossiers)", () => {
  it("refuse (403) un appareil encore en_attente", async () => {
    const tel = genererPaireClesX25519();
    const deviceId = "6e947d4d-2fbd-43e5-943f-6d6021a02145";
    prismaMock.mobileDevice.findUnique.mockResolvedValue({
      id: deviceId,
      cabinetId: "cabinet-1",
      userId: "user-1",
      statut: "en_attente",
      clePublique: tel.clePubliqueBase64,
      dernierCompteur: null,
    });

    const res = await api("/api/m/dossiers", construireRequeteAppareil(tel.clePriveeKeyObject, deviceId, 1, {}));
    expect(res.status).toBe(403);
  });

  it("refuse (403) un appareil révoqué", async () => {
    const tel = genererPaireClesX25519();
    const deviceId = "36aff66f-cb34-4ee4-9547-1a0c62a15437";
    prismaMock.mobileDevice.findUnique.mockResolvedValue({
      id: deviceId,
      cabinetId: "cabinet-1",
      userId: "user-1",
      statut: "revoque",
      clePublique: tel.clePubliqueBase64,
      dernierCompteur: null,
    });

    const res = await api("/api/m/dossiers", construireRequeteAppareil(tel.clePriveeKeyObject, deviceId, 1, {}));
    expect(res.status).toBe(403);
  });

  it("renvoie les dossiers accessibles à l'utilisateur lié, avec la prochaine audience", async () => {
    const tel = genererPaireClesX25519();
    const deviceId = "a9adfa22-2cbf-4567-a5da-ce54450e5e49";
    prismaMock.mobileDevice.findUnique.mockResolvedValue({
      id: deviceId,
      cabinetId: "cabinet-1",
      userId: "user-1",
      statut: "autorise",
      clePublique: tel.clePubliqueBase64,
      dernierCompteur: null,
    });
    prismaMock.mobileDevice.update.mockResolvedValue({});
    prismaMock.user.findUnique.mockResolvedValue({ id: "user-1", cabinetId: "cabinet-1", role: "avocat" });
    getAccessibleAvocatIdsMock.mockResolvedValue(["user-1"]);
    prismaMock.dossier.findMany.mockResolvedValue([
      { id: "dossier-1", numeroDossier: "2026-001", nomAffaire: "Affaire X", nomClient: "Client X" },
    ]);
    prismaMock.roleAudience.findMany.mockResolvedValue([
      { dossierId: "dossier-1", dateAudience: new Date("2026-12-01T09:00:00.000Z") },
    ]);

    const res = await api("/api/m/dossiers", construireRequeteAppareil(tel.clePriveeKeyObject, deviceId, 1, {}));
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body).toEqual([
      {
        id: "dossier-1",
        numeroDossier: "2026-001",
        nomAffaire: "Affaire X",
        nomClient: "Client X",
        prochaineAudience: "2026-12-01T09:00:00.000Z",
      },
    ]);
  });
});

describe("POST /api/m/items (idempotence)", () => {
  it("renvoie l'item existant (dejaExistant: true) si le même clientId est renvoyé", async () => {
    const tel = genererPaireClesX25519();
    const deviceId = "cb3c160b-959f-4851-add9-f14bb0401c6c";
    prismaMock.mobileDevice.findUnique.mockResolvedValue({
      id: deviceId,
      cabinetId: "cabinet-1",
      userId: "user-1",
      statut: "autorise",
      clePublique: tel.clePubliqueBase64,
      dernierCompteur: null,
    });
    prismaMock.mobileDevice.update.mockResolvedValue({});
    prismaMock.mobileItem.findUnique.mockResolvedValue({ id: "item-existant-1" });

    const payload = {
      clientId: "55555555-5555-5555-5555-555555555555",
      type: "audio",
      nombreChunksAttendu: 3,
      sha256Attendu: "a".repeat(64),
    };
    const res = await api("/api/m/items", construireRequeteAppareil(tel.clePriveeKeyObject, deviceId, 1, payload));
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body).toEqual({ itemId: "item-existant-1", dejaExistant: true });
    expect(prismaMock.mobileItem.create).not.toHaveBeenCalled();
  });
});
