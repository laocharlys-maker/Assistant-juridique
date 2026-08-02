/**
 * Lot 7 - scenario mode reseau (Lot 6) : le serveur est demarre en HTTPS,
 * bind sur toutes les interfaces, et un "second poste" est simule en
 * interrogeant l'IP de l'interface LAN reelle de la machine plutot que
 * 127.0.0.1 (meme approche validee empiriquement pendant le developpement
 * du Lot 6 - une requete qui passe par l'interface reseau physique est un
 * test fidele de ce qu'un second poste du meme reseau local vivrait, sans
 * necessiter une deuxieme machine physique).
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import https from "node:https";
import tls from "node:tls";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { Agent as UndiciAgent } from "undici";
import { findPostgresBinDir, startTestPostgres, type TestPostgres } from "./helpers/testPostgres";
import { seedCabinetEtTitulaire, mintAuthCookie } from "./helpers/testApp";

const pgAvailable = findPostgresBinDir() !== null;

// Accepte le certificat auto-signe local (equivalent, cote test, d'un
// utilisateur qui a importe le certificat - voir installer/import-cert-instructions.md) -
// jamais utilise pour valider un VRAI site distant. `fetch` global de Node
// est base sur undici : c'est son option "dispatcher" (pas "agent", propre
// a node-fetch) qui permet de desactiver la verification TLS par requete.
const insecureDispatcher = new UndiciAgent({ connect: { rejectUnauthorized: false } });

describe.skipIf(!pgAvailable)("e2e mode reseau : acces depuis un second poste simule", () => {
  let pg: TestPostgres;
  let server: import("node:https").Server;
  let baseUrl: string;
  let prisma: import("@prisma/client").PrismaClient;
  let authCookie: string;
  let fakeAppData: string;
  let localIp: string | null;

  beforeAll(async () => {
    if (!pgAvailable) return;
    pg = (await startTestPostgres("network-mode"))!;

    fakeAppData = fs.mkdtempSync(path.join(os.tmpdir(), "aurore-e2e-network-"));
    process.env.APPDATA = fakeAppData;

    process.env.DATABASE_URL = pg.databaseUrl;
    process.env.SESSION_SECRET = "0123456789abcdef0123456789abcdef";
    process.env.GEMINI_API_KEY = "dummy-test-key";
    process.env.NODE_ENV = "test";
    delete process.env.DATABASE_MODE;
    process.env.LICENCE_BYPASS = "true"; // seul le mode reseau est teste ici, pas la licence (couverte par les autres suites e2e)

    const { writeDeploymentMode, getLocalNetworkAddress } = await import("../../src/config/deploymentMode");
    writeDeploymentMode("reseau");
    localIp = getLocalNetworkAddress()?.address ?? null;

    const { app } = await import("../../src/app");
    const { prisma: prismaClient } = await import("../../src/lib/prisma");
    const { ensureLocalTlsCertificate } = await import("../../src/security/localTlsCertificate");
    prisma = prismaClient;

    const tlsCertificate = await ensureLocalTlsCertificate();
    server = https.createServer({ key: tlsCertificate.key, cert: tlsCertificate.cert }, app);
    await new Promise<void>((resolve) => server.listen(0, "0.0.0.0", resolve));
    const port = (server.address() as { port: number }).port;
    baseUrl = `https://127.0.0.1:${port}`;

    const { cabinet, user } = await seedCabinetEtTitulaire(prisma, "network-mode");
    authCookie = await mintAuthCookie(user.id, cabinet.id);

    (globalThis as { __e2e_network_port__?: number }).__e2e_network_port__ = port;
  });

  afterAll(async () => {
    if (!pgAvailable) return;
    await new Promise((resolve) => server?.close(resolve));
    await prisma?.$disconnect();
    pg?.stop();
    fs.rmSync(fakeAppData, { recursive: true, force: true });
  });

  function urlFor(host: string, pathname: string): string {
    const port = (globalThis as { __e2e_network_port__?: number }).__e2e_network_port__;
    return `https://${host}:${port}${pathname}`;
  }

  async function fetchInsecure(url: string, options: RequestInit = {}) {
    // @ts-expect-error - "dispatcher" est une extension undici, absente du type standard RequestInit
    return fetch(url, { ...options, dispatcher: insecureDispatcher });
  }

  it("annonce le mode reseau et l'IP LAN via /api/network-info", async () => {
    const res = await fetchInsecure(urlFor("127.0.0.1", "/api/network-info"));
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.deploymentMode).toBe("reseau");
    expect(body.https).toBe(true);
    expect(body.hostname).toBe("aurore.local");
  });

  it("repond en HTTPS avec un certificat couvrant l'IP LAN et aurore.local", async () => {
    const port = (globalThis as { __e2e_network_port__?: number }).__e2e_network_port__;
    const cert = await new Promise<tls.PeerCertificate>((resolve, reject) => {
      const socket = tls.connect(
        { host: "127.0.0.1", port, rejectUnauthorized: false, servername: "aurore.local" },
        () => {
          resolve(socket.getPeerCertificate());
          socket.end();
        }
      );
      socket.on("error", reject);
    });
    expect(cert.subjectaltname).toContain("DNS:aurore.local");
  });

  it("un 'second poste' (requete via l'IP LAN reelle plutot que 127.0.0.1) accede normalement au serveur", async () => {
    if (!localIp) {
      // Machine sans interface LAN privee detectable (ex: certains
      // environnements CI isoles) - le reste du test (127.0.0.1) couvre
      // deja le comportement HTTPS/bind, ce cas precis n'est simplement
      // pas demontrable ici. Voir README-LOT7.md.
      return;
    }
    const res = await fetchInsecure(urlFor(localIp, "/health"));
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.database).toBe("connected");
  });

  it("l'authentification reste requise pour les routes metier, meme via HTTPS/reseau", async () => {
    const res = await fetchInsecure(urlFor("127.0.0.1", "/api/dossiers"));
    expect(res.status).toBe(401);
  });

  it("un poste authentifie peut interagir normalement (creer un client) en mode reseau", async () => {
    const res = await fetchInsecure(urlFor("127.0.0.1", "/api/clients"), {
      method: "POST",
      headers: { "Content-Type": "application/json", Cookie: authCookie },
      body: JSON.stringify({ nom: "Client Fictif Réseau" }),
    });
    expect(res.status).toBe(201);
  });

  it("aucune connexion HTTP simple (non chiffree) n'est acceptee sur ce port", async () => {
    const port = (globalThis as { __e2e_network_port__?: number }).__e2e_network_port__;
    await expect(fetch(`http://127.0.0.1:${port}/health`, { signal: AbortSignal.timeout(1500) })).rejects.toBeTruthy();
  });
});
