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
    prismaMock.user.findUnique.mockResolvedValue({ nom: "Jean Kokou", role: "avocat" });

    const res = await api("/api/m/ping", construireRequeteAppareil(tel.clePriveeKeyObject, deviceId, 1, {}));
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body).toEqual({ ok: true, cabinetId: "cabinet-1", nomUtilisateur: "Jean Kokou", role: "avocat" });
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

  // Prompt 7, objectif D - "la revocation coupe IMMEDIATEMENT l'acces" :
  // pas seulement un cas statique (appareil deja revoque des le depart),
  // mais la transition elle-meme entre deux requetes consecutives, sans
  // aucun cache serveur du statut de l'appareil.
  it("coupe l'accès dès la requête suivant une révocation, sans aucun délai ni cache", async () => {
    const tel = genererPaireClesX25519();
    const deviceId = "a1b2c3d4-0000-4000-8000-000000000001";
    const appareilAutorise = {
      id: deviceId,
      cabinetId: "cabinet-1",
      userId: "user-1",
      statut: "autorise",
      clePublique: tel.clePubliqueBase64,
      dernierCompteur: null,
    };
    prismaMock.mobileDevice.findUnique.mockResolvedValueOnce(appareilAutorise);
    prismaMock.mobileDevice.update.mockResolvedValue({});
    const res1 = await api("/api/m/ping", construireRequeteAppareil(tel.clePriveeKeyObject, deviceId, 1, {}));
    expect(res1.status).toBe(200);

    // Revocation simulee entre les deux requetes (ce que
    // PATCH /api/mobile/appareils/:id/revoquer fait reellement, voir
    // routes/mobileAppareils.ts:128-133) - le mock Prisma renvoie
    // maintenant le statut mis a jour, EXACTEMENT comme le ferait un vrai
    // SELECT apres l'UPDATE.
    prismaMock.mobileDevice.findUnique.mockResolvedValueOnce({ ...appareilAutorise, statut: "revoque" });
    const res2 = await api(
      "/api/m/dossiers",
      construireRequeteAppareil(tel.clePriveeKeyObject, deviceId, 2, {})
    );
    expect(res2.status).toBe(403);
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

// Prompt 6, objectif C - script d'integration bout-en-bout : cree un item,
// envoie ses morceaux, commit, et verifie les deux garanties du critere
// d'acceptation ("coupure au milieu d'un envoi : reprise sans perte ni
// doublon") directement contre les vraies routes Express (pas de mock de
// la logique applicative elle-meme, seulement de Prisma/du stockage
// disque - voir le haut de ce fichier).
describe("flux complet morceaux + commit (Prompt 6, objectif C)", () => {
  const deviceId = "7f8e5c4a-1234-4a5a-9a1a-abcdef123456";

  function appareilAutorise(tel: ReturnType<typeof genererPaireClesX25519>) {
    prismaMock.mobileDevice.findUnique.mockResolvedValue({
      id: deviceId,
      cabinetId: "cabinet-1",
      userId: "user-1",
      statut: "autorise",
      clePublique: tel.clePubliqueBase64,
      dernierCompteur: null,
    });
    prismaMock.mobileDevice.update.mockResolvedValue({});
  }

  it("cree l'item, accepte 2 morceaux puis le commit - reçu final cohérent", async () => {
    const tel = genererPaireClesX25519();
    appareilAutorise(tel);
    prismaMock.mobileItem.findUnique.mockResolvedValue(null);
    prismaMock.mobileItem.create.mockResolvedValue({ id: "item-flux-1" });
    prismaMock.mobileItem.findFirst.mockResolvedValue({
      id: "item-flux-1",
      clientId: "66666666-6666-6666-6666-666666666666",
      statut: "recu",
      cheminFichier: null,
    });

    const { ecrireChunk, assemblerEtVerifier } = await import("../../services/mobileSync/stockageMobile");

    let compteur = 0;
    const creerItem = async () =>
      api(
        "/api/m/items",
        construireRequeteAppareil(tel.clePriveeKeyObject, deviceId, ++compteur, {
          clientId: "66666666-6666-6666-6666-666666666666",
          type: "audio",
          nombreChunksAttendu: 2,
          sha256Attendu: "b".repeat(64),
        })
      );
    const resCreation = await creerItem();
    expect(resCreation.status).toBe(201);
    const { itemId } = (await resCreation.json()) as { itemId: string };

    for (const numero of [0, 1]) {
      const res = await api(
        `/api/m/items/${itemId}/chunks/${numero}`,
        construireRequeteAppareil(tel.clePriveeKeyObject, deviceId, ++compteur, {
          contenuBase64: Buffer.from(`morceau-${numero}`).toString("base64"),
        })
      );
      expect(res.status).toBe(200);
    }
    expect(ecrireChunk).toHaveBeenCalledTimes(2);

    const resCommit = await api(
      `/api/m/items/${itemId}/commit`,
      construireRequeteAppareil(tel.clePriveeKeyObject, deviceId, ++compteur, {
        nombreChunks: 2,
        sha256: "b".repeat(64),
      })
    );
    expect(resCommit.status).toBe(200);
    expect(await resCommit.json()).toEqual({ ok: true, itemId: "item-flux-1", dejaConfirme: false });
    expect(assemblerEtVerifier).toHaveBeenCalledTimes(1);
  });

  it("un morceau renvoyé après coupure (même numéro) ne crée jamais de doublon - juste réécrit", async () => {
    const tel = genererPaireClesX25519();
    appareilAutorise(tel);
    prismaMock.mobileItem.findFirst.mockResolvedValue({
      id: "item-flux-2",
      clientId: "77777777-7777-7777-7777-777777777777",
      statut: "recu",
      cheminFichier: null,
    });
    const { ecrireChunk } = await import("../../services/mobileSync/stockageMobile");

    const corpsChunk = { contenuBase64: Buffer.from("morceau-0").toString("base64") };
    const res1 = await api(
      "/api/m/items/item-flux-2/chunks/0",
      construireRequeteAppareil(tel.clePriveeKeyObject, deviceId, 1, corpsChunk)
    );
    // Coupure simulee : le telephone n'a jamais reçu cette reponse (peu
    // importe ici), et renvoie le MEME morceau avec un compteur superieur
    // (jamais le meme compteur - l'anti-rejeu l'interdirait, voir le test
    // "409" plus haut dans ce fichier).
    const res2 = await api(
      "/api/m/items/item-flux-2/chunks/0",
      construireRequeteAppareil(tel.clePriveeKeyObject, deviceId, 2, corpsChunk)
    );

    expect(res1.status).toBe(200);
    expect(res2.status).toBe(200);
    expect(ecrireChunk).toHaveBeenCalledTimes(2);
    // Meme numero de morceau (0) les deux fois - ecrireChunk (voir
    // services/mobileSync/stockageMobile.ts) ecrit toujours au MEME nom de
    // fichier pour un numero donne, donc la deuxieme ecriture remplace la
    // premiere plutot que de l'empiler - jamais de doublon sur disque.
    const appelsEcrireChunk = vi.mocked(ecrireChunk).mock.calls;
    expect(appelsEcrireChunk[0][2]).toBe(0);
    expect(appelsEcrireChunk[1][2]).toBe(0);
  });

  it("un commit rejoué après succès est idempotent (dejaConfirme), jamais réassemblé deux fois", async () => {
    const tel = genererPaireClesX25519();
    appareilAutorise(tel);
    const { assemblerEtVerifier } = await import("../../services/mobileSync/stockageMobile");

    // Premier commit : l'item n'a pas encore de cheminFichier.
    prismaMock.mobileItem.findFirst.mockResolvedValueOnce({
      id: "item-flux-3",
      clientId: "88888888-8888-8888-8888-888888888888",
      cheminFichier: null,
    });
    const corpsCommit = { nombreChunks: 1, sha256: "c".repeat(64) };
    const res1 = await api(
      "/api/m/items/item-flux-3/commit",
      construireRequeteAppareil(tel.clePriveeKeyObject, deviceId, 1, corpsCommit)
    );
    expect(res1.status).toBe(200);
    expect(await res1.json()).toMatchObject({ dejaConfirme: false });

    // Rejoue du MEME commit (ex. reponse perdue cote telephone) : l'item a
    // maintenant un cheminFichier (deja assemble) - jamais reassemble,
    // jamais d'erreur, juste le meme reçu.
    prismaMock.mobileItem.findFirst.mockResolvedValueOnce({
      id: "item-flux-3",
      clientId: "88888888-8888-8888-8888-888888888888",
      cheminFichier: "fichier-test.enc",
    });
    const res2 = await api(
      "/api/m/items/item-flux-3/commit",
      construireRequeteAppareil(tel.clePriveeKeyObject, deviceId, 2, corpsCommit)
    );
    expect(res2.status).toBe(200);
    expect(await res2.json()).toEqual({ ok: true, itemId: "item-flux-3", dejaConfirme: true });
    expect(assemblerEtVerifier).toHaveBeenCalledTimes(1); // pas 2.
  });

  it("refuse (409) un morceau envoyé après que l'item soit déjà finalisé", async () => {
    const tel = genererPaireClesX25519();
    appareilAutorise(tel);
    prismaMock.mobileItem.findFirst.mockResolvedValue({
      id: "item-flux-4",
      clientId: "99999999-9999-9999-9999-999999999999",
      statut: "a_traiter",
      cheminFichier: "fichier-test.enc",
    });

    const res = await api(
      "/api/m/items/item-flux-4/chunks/0",
      construireRequeteAppareil(tel.clePriveeKeyObject, deviceId, 1, {
        contenuBase64: Buffer.from("trop-tard").toString("base64"),
      })
    );
    expect(res.status).toBe(409);
  });
});
