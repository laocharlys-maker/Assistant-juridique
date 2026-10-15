import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { X509Certificate } from "node:crypto";

/**
 * Certificat TLS local (mode Serveur reseau) - couverture de l'adresse
 * Tailscale (acces distant, en plus de l'IP LAN habituelle - voir
 * config/deploymentMode.ts, getTailscaleAddress). Verifie empiriquement
 * (vraie generation de certificat, jamais mockee - seule la detection
 * reseau sous-jacente est mockee, pour piloter le scenario) que :
 * - le certificat couvre bien l'IP Tailscale quand elle est detectee ;
 * - un certificat genere AVANT ce champ (retrocompatible, `tailscaleIp`
 *   absent du meta) n'est PAS regenere inutilement si Tailscale reste
 *   absent - seulement si Tailscale apparait/change.
 *
 * Comportement confirme en conditions reelles (Tailscale installe et
 * connecte sur la machine de developpement) le 2026-09-02 - ce test
 * verrouille ce comportement de facon reproductible, sans dependre d'un
 * vrai Tailscale installe.
 */

const getAllIpsMock = vi.hoisted(() => vi.fn());
const getTailscaleAddressMock = vi.hoisted(() => vi.fn());
vi.mock("../../config/deploymentMode", () => ({
  getAllPrivateIPv4Addresses: getAllIpsMock,
  getTailscaleAddress: getTailscaleAddressMock,
}));

let fakeAppData: string;
let ensureLocalTlsCertificate: typeof import("../localTlsCertificate").ensureLocalTlsCertificate;

beforeAll(async () => {
  fakeAppData = fs.mkdtempSync(path.join(os.tmpdir(), "aurore-test-tls-"));
  process.env.APPDATA = fakeAppData;
  ({ ensureLocalTlsCertificate } = await import("../localTlsCertificate"));
});

afterAll(() => {
  fs.rmSync(fakeAppData, { recursive: true, force: true });
});

beforeEach(() => {
  vi.clearAllMocks();
  // Isolation complete entre tests : chaque test part sans certificat
  // existant, jamais influence par celui laisse par le test precedent.
  fs.rmSync(path.join(fakeAppData, "Aurore", "secrets", "tls"), { recursive: true, force: true });
});

function sanDe(cert: string): string {
  return new X509Certificate(cert).subjectAltName ?? "";
}

describe("ensureLocalTlsCertificate - couverture Tailscale", () => {
  it("couvre l'adresse Tailscale quand elle est detectee", async () => {
    getAllIpsMock.mockReturnValue(["192.168.1.199"]);
    getTailscaleAddressMock.mockReturnValue("100.79.7.27");

    const { cert } = await ensureLocalTlsCertificate();
    const san = sanDe(cert);

    expect(san).toContain("192.168.1.199");
    expect(san).toContain("100.79.7.27");
    expect(san).toContain("aurore.local");
  });

  it("ne regenere pas si rien n'a change (Tailscale toujours present, meme adresse)", async () => {
    getAllIpsMock.mockReturnValue(["192.168.1.199"]);
    getTailscaleAddressMock.mockReturnValue("100.79.7.27");

    const premier = await ensureLocalTlsCertificate();
    const second = await ensureLocalTlsCertificate();

    expect(second.cert).toBe(premier.cert);
  });

  it("regenere si l'adresse Tailscale change", async () => {
    getAllIpsMock.mockReturnValue(["192.168.1.199"]);
    getTailscaleAddressMock.mockReturnValue("100.79.7.27");
    const avant = await ensureLocalTlsCertificate();

    getTailscaleAddressMock.mockReturnValue("100.79.7.28");
    const apres = await ensureLocalTlsCertificate();

    expect(apres.cert).not.toBe(avant.cert);
    expect(sanDe(apres.cert)).toContain("100.79.7.28");
    expect(sanDe(apres.cert)).not.toContain("100.79.7.27\n");
  });

  it("ne regenere PAS un certificat retrocompatible (tailscaleIp absent du meta) quand Tailscale reste absent", async () => {
    getAllIpsMock.mockReturnValue(["192.168.1.199"]);
    getTailscaleAddressMock.mockReturnValue(null);
    const genere = await ensureLocalTlsCertificate();

    // Simule un certificat genere AVANT l'ajout du champ tailscaleIp au
    // meta (fichiers ecrits par une version anterieure du code).
    const metaPath = path.join(fakeAppData, "Aurore", "secrets", "tls", "aurore-cert-meta.json");
    const meta = JSON.parse(fs.readFileSync(metaPath, "utf8"));
    delete meta.tailscaleIp;
    fs.writeFileSync(metaPath, JSON.stringify(meta, null, 2));

    const relu = await ensureLocalTlsCertificate();
    expect(relu.cert).toBe(genere.cert);
  });
});

describe("ensureLocalTlsCertificate - stabilite (plusieurs cartes reseau)", () => {
  it("couvre toutes les IP privees et Tailscale dans un seul certificat", async () => {
    getAllIpsMock.mockReturnValue(["172.21.33.132", "192.168.1.132"]);
    getTailscaleAddressMock.mockReturnValue("100.79.7.27");

    const { cert } = await ensureLocalTlsCertificate();
    const x509 = new X509Certificate(cert);

    for (const ip of ["172.21.33.132", "192.168.1.132", "100.79.7.27", "127.0.0.1"]) {
      expect(x509.checkIP(ip)).toBeTruthy();
    }
  });

  it("ne regenere PAS quand l'ordre des cartes reseau change", async () => {
    getTailscaleAddressMock.mockReturnValue("100.79.7.27");
    getAllIpsMock.mockReturnValue(["172.21.33.132", "192.168.1.132"]);
    const premier = await ensureLocalTlsCertificate();

    getAllIpsMock.mockReturnValue(["192.168.1.132", "172.21.33.132"]);
    const second = await ensureLocalTlsCertificate();

    expect(second.cert).toBe(premier.cert);
  });

  it("ne regenere PAS quand une carte disparait (hotspot deconnecte, Tailscale arrete)", async () => {
    getAllIpsMock.mockReturnValue(["172.21.33.132", "192.168.1.132"]);
    getTailscaleAddressMock.mockReturnValue("100.79.7.27");
    const premier = await ensureLocalTlsCertificate();

    getAllIpsMock.mockReturnValue(["192.168.1.132"]);
    getTailscaleAddressMock.mockReturnValue(null);
    const second = await ensureLocalTlsCertificate();

    expect(second.cert).toBe(premier.cert);
  });

  it("regenere (en gardant toutes les IP actuelles) quand une nouvelle IP apparait", async () => {
    getTailscaleAddressMock.mockReturnValue(null);
    getAllIpsMock.mockReturnValue(["192.168.1.132"]);
    const avant = await ensureLocalTlsCertificate();

    getAllIpsMock.mockReturnValue(["192.168.1.132", "192.168.1.50"]);
    const apres = await ensureLocalTlsCertificate();

    expect(apres.cert).not.toBe(avant.cert);
    expect(new X509Certificate(apres.cert).checkIP("192.168.1.50")).toBeTruthy();
    expect(new X509Certificate(apres.cert).checkIP("192.168.1.132")).toBeTruthy();
  });

  it("ne regenere pas hors ligne (aucune IP detectee) si le certificat reste valide", async () => {
    getTailscaleAddressMock.mockReturnValue(null);
    getAllIpsMock.mockReturnValue(["192.168.1.132"]);
    const avant = await ensureLocalTlsCertificate();

    getAllIpsMock.mockReturnValue([]);
    const apres = await ensureLocalTlsCertificate();

    expect(apres.cert).toBe(avant.cert);
  });
});
