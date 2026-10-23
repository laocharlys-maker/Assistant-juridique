import { describe, expect, it, vi } from "vitest";

const networkInterfacesMock = vi.hoisted(() => vi.fn());
vi.mock("node:os", () => ({ default: { networkInterfaces: networkInterfacesMock } }));

describe("listerAdressesLocales - adresses du QR d'appairage", () => {
  const interfaces = {
    "vEthernet (Default Switch)": [{ family: "IPv4", internal: false, address: "172.17.208.1" }],
    "Wi-Fi": [{ family: "IPv4", internal: false, address: "192.168.100.5" }],
    Ethernet: [{ family: "IPv4", internal: false, address: "169.254.82.65" }],
    Tailscale: [{ family: "IPv4", internal: false, address: "100.79.7.27" }],
  };

  it("sans interface choisie : uniquement les cartes reelles (ni virtuelles, ni APIPA, ni Tailscale)", async () => {
    networkInterfacesMock.mockReturnValue(interfaces);
    const { listerAdressesLocales } = await import("../reseauMobile");
    expect(listerAdressesLocales(null)).toEqual(["192.168.100.5"]);
  });

  it("avec une interface choisie : respecte le choix explicite de l'utilisateur", async () => {
    networkInterfacesMock.mockReturnValue(interfaces);
    const { listerAdressesLocales } = await import("../reseauMobile");
    expect(listerAdressesLocales("vEthernet (Default Switch)")).toEqual(["172.17.208.1"]);
  });
});
