import { describe, expect, it, vi } from "vitest";

/**
 * getTailscaleAddress() (accès distant via Tailscale, voir
 * security/localTlsCertificate.ts) - verifie qu'elle detecte bien
 * l'interface Tailscale par son nom, contrairement a getLocalNetworkAddress()
 * qui l'exclut deliberement. Verifie empiriquement en conditions reelles
 * (Tailscale installe et connecte) le 2026-09-02 - ce test verrouille ce
 * comportement.
 */

const networkInterfacesMock = vi.hoisted(() => vi.fn());
vi.mock("node:os", () => ({ default: { networkInterfaces: networkInterfacesMock } }));

describe("getTailscaleAddress", () => {
  it("renvoie l'adresse IPv4 de l'interface Tailscale, meme parmi d'autres interfaces", async () => {
    networkInterfacesMock.mockReturnValue({
      "Wi-Fi": [{ family: "IPv4", internal: false, address: "192.168.1.199" }],
      Tailscale: [{ family: "IPv4", internal: false, address: "100.79.7.27" }],
      "vEthernet (Default Switch)": [{ family: "IPv4", internal: false, address: "172.21.0.1" }],
    });

    const { getTailscaleAddress } = await import("../deploymentMode");
    expect(getTailscaleAddress()).toBe("100.79.7.27");
  });

  it("renvoie null si aucune interface Tailscale n'est presente", async () => {
    networkInterfacesMock.mockReturnValue({
      "Wi-Fi": [{ family: "IPv4", internal: false, address: "192.168.1.199" }],
    });

    const { getTailscaleAddress } = await import("../deploymentMode");
    expect(getTailscaleAddress()).toBeNull();
  });

  it("ignore une interface Tailscale sans adresse IPv4 externe (deconnectee)", async () => {
    networkInterfacesMock.mockReturnValue({
      Tailscale: [{ family: "IPv6", internal: false, address: "fd7a:115c:a1e0::1" }],
    });

    const { getTailscaleAddress } = await import("../deploymentMode");
    expect(getTailscaleAddress()).toBeNull();
  });
});

describe("getAllPrivateIPv4Addresses", () => {
  it("ignore les cartes virtuelles (Hyper-V/WSL), APIPA et Tailscale ; ordre deterministe", async () => {
    networkInterfacesMock.mockReturnValue({
      "vEthernet (Default Switch)": [{ family: "IPv4", internal: false, address: "172.17.208.1" }],
      "Wi-Fi": [{ family: "IPv4", internal: false, address: "192.168.1.200" }],
      Ethernet: [{ family: "IPv4", internal: false, address: "169.254.82.65" }],
      Tailscale: [{ family: "IPv4", internal: false, address: "100.79.7.27" }],
      "Connexion au reseau local": [{ family: "IPv4", internal: false, address: "10.0.0.5" }],
    });

    const { getAllPrivateIPv4Addresses } = await import("../deploymentMode");
    expect(getAllPrivateIPv4Addresses()).toEqual(["10.0.0.5", "192.168.1.200"]);
  });

  it("se replie sur les cartes virtuelles s'il n'y a rien d'autre", async () => {
    networkInterfacesMock.mockReturnValue({
      "vEthernet (Default Switch)": [{ family: "IPv4", internal: false, address: "172.17.208.1" }],
    });

    const { getAllPrivateIPv4Addresses } = await import("../deploymentMode");
    expect(getAllPrivateIPv4Addresses()).toEqual(["172.17.208.1"]);
  });
});
