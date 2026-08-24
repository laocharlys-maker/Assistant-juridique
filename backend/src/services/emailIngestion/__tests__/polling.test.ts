import { describe, expect, it, vi, beforeEach } from "vitest";
import type { ConnexionEmailExterne } from "@prisma/client";

/**
 * imapflow annote certaines erreurs de connexion (NoConnection) avec
 * `error.reason` : la raison EXPLICITE donnee par le serveur avant de
 * fermer la connexion (ex: "Too many simultaneous connections"). Avant ce
 * correctif, ce champ etait ignore et seul le message generique "Connection
 * not available" apparaissait dans derniereErreur (affiche a l'utilisateur
 * sur la page "Boîte mail externe") - aucune piste exploitable. Ce test
 * verifie que la raison, quand fournie, est desormais incluse.
 */

const prismaMock = vi.hoisted(() => ({
  connexionEmailExterne: { findMany: vi.fn(), update: vi.fn() },
  emailImporte: { upsert: vi.fn() },
}));
vi.mock("../../../lib/prisma", () => ({ prisma: prismaMock }));

const imapListerMock = vi.hoisted(() => vi.fn());
vi.mock("../imapClient", () => ({ listerEmailsRecents: imapListerMock }));
vi.mock("../gmailClient", () => ({ listerEmailsRecents: vi.fn() }));

function connexionImap(): ConnexionEmailExterne {
  return { id: "conn-1", provider: "imap" } as ConnexionEmailExterne;
}

beforeEach(() => {
  vi.clearAllMocks();
  prismaMock.connexionEmailExterne.update.mockResolvedValue({});
});

describe("verifierConnexionMaintenant / traiterConnexion", () => {
  it("inclut la raison serveur (BYE) dans derniereErreur quand imapflow la fournit", async () => {
    const { verifierConnexionMaintenant } = await import("../polling");
    const erreur = Object.assign(new Error("Connection not available"), {
      code: "NoConnection",
      reason: "Too many simultaneous connections",
    });
    imapListerMock.mockRejectedValue(erreur);

    await verifierConnexionMaintenant(connexionImap(), "cabinet-1");

    expect(prismaMock.connexionEmailExterne.update).toHaveBeenCalledWith({
      where: { id: "conn-1" },
      data: { derniereErreur: "Connection not available — Too many simultaneous connections" },
    });
  });

  it("inclut le texte serveur (responseText, reponse NO/BAD a une commande) dans derniereErreur quand imapflow le fournit", async () => {
    const { verifierConnexionMaintenant } = await import("../polling");
    const erreur = Object.assign(new Error("Command failed"), {
      responseStatus: "NO",
      responseText: "[AUTHENTICATIONFAILED] Authentication failed.",
    });
    imapListerMock.mockRejectedValue(erreur);

    await verifierConnexionMaintenant(connexionImap(), "cabinet-1");

    expect(prismaMock.connexionEmailExterne.update).toHaveBeenCalledWith({
      where: { id: "conn-1" },
      data: { derniereErreur: "Command failed — [AUTHENTICATIONFAILED] Authentication failed." },
    });
  });

  it("garde le message tel quel quand aucune raison serveur n'est fournie", async () => {
    const { verifierConnexionMaintenant } = await import("../polling");
    imapListerMock.mockRejectedValue(new Error("Connection not available"));

    await verifierConnexionMaintenant(connexionImap(), "cabinet-1");

    expect(prismaMock.connexionEmailExterne.update).toHaveBeenCalledWith({
      where: { id: "conn-1" },
      data: { derniereErreur: "Connection not available" },
    });
  });
});
