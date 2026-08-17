import { EventEmitter } from "node:events";
import { describe, expect, it, vi } from "vitest";

/**
 * ImapFlow est un EventEmitter Node : toute erreur de connexion survenant
 * apres la connexion initiale (ex: ECONNRESET) est emise via
 * `emit("error", ...)`. Sans ecouteur "error" attache, Node fait planter
 * tout le PROCESS (comportement standard des EventEmitter, pas seulement
 * un rejet de promesse) - constate en usage reel : crash complet et repete
 * du backend. Ce test verifie qu'un ecouteur est bien attache par
 * ouvrirClient(), et que l'emission d'une erreur de connexion ne fait donc
 * jamais planter le process.
 */

class FakeImapFlow extends EventEmitter {
  static lastInstance: FakeImapFlow | undefined;
  mailbox = { exists: 0 };

  constructor() {
    super();
    FakeImapFlow.lastInstance = this;
  }

  async connect() {
    return undefined;
  }

  async logout() {
    return undefined;
  }

  async getMailboxLock() {
    return { release: () => undefined };
  }
}

vi.mock("imapflow", () => ({ ImapFlow: FakeImapFlow }));

const identifiants = {
  imapHost: "imap.exemple.test",
  imapPort: 993,
  imapSecure: true,
  imapUsername: "user@exemple.test",
  imapPassword: "secret",
};

describe("imapClient - resilience aux erreurs de connexion async", () => {
  it("attache un ecouteur 'error' au client ImapFlow (testerConnexion)", async () => {
    const { testerConnexion } = await import("../imapClient");
    await testerConnexion(identifiants);

    const instance = FakeImapFlow.lastInstance;
    expect(instance).toBeDefined();
    expect(instance!.listenerCount("error")).toBeGreaterThan(0);
  });

  it("n'emet jamais d'exception process quand ImapFlow emet 'error' apres coup (ex: ECONNRESET)", async () => {
    const { testerConnexion } = await import("../imapClient");
    await testerConnexion(identifiants);

    const instance = FakeImapFlow.lastInstance!;
    expect(() => instance.emit("error", Object.assign(new Error("read ECONNRESET"), { code: "ECONNRESET" }))).not.toThrow();
  });
});
