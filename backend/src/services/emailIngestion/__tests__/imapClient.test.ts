import { EventEmitter } from "node:events";
import { Readable } from "node:stream";
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
  // Configurable AVANT l'appel de la fonction testee (l'instance n'existe
  // pas encore a ce moment-la - voir ouvrirClient) : la valeur statique est
  // recopiee a la construction, comme un mock de "prochaine reponse".
  static prochaineBodyStructure: unknown = null;
  static prochainContenuParPart: Record<string, string> = {};

  mailbox = { exists: 0 };
  private bodyStructure: unknown;
  private contenuParPart: Record<string, string>;

  constructor() {
    super();
    FakeImapFlow.lastInstance = this;
    this.bodyStructure = FakeImapFlow.prochaineBodyStructure;
    this.contenuParPart = FakeImapFlow.prochainContenuParPart;
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

  async fetchOne() {
    return { bodyStructure: this.bodyStructure };
  }

  async download(_uid: number, partId: string) {
    return { content: Readable.from([Buffer.from(this.contenuParPart[partId] || "", "utf8")]) };
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

describe("obtenirContenuComplet - priorite HTML sur texte brut", () => {
  it("priorise le HTML sur le texte brut quand les deux existent (comme Gmail et tout client mail)", async () => {
    // Meme raisonnement que gmailClient.ts : un texte/plain "genere" par
    // l'outil d'envoi est souvent illisible tel quel (URLs de tracking
    // imbriquees entre parentheses) - le HTML, plus fidele, doit toujours
    // etre preferee quand il existe.
    FakeImapFlow.prochaineBodyStructure = {
      type: "multipart/alternative",
      childNodes: [
        { type: "text/plain", part: "1", size: 10 },
        { type: "text/html", part: "2", size: 10 },
      ],
    };
    FakeImapFlow.prochainContenuParPart = {
      "1": "Google ( https://tracker.example/click )",
      "2": "<p>Corps en HTML</p>",
    };

    const { obtenirContenuComplet } = await import("../imapClient");
    const resultat = await obtenirContenuComplet(identifiants as never, "42");

    expect(resultat.html).toContain("Corps en HTML");
    expect(resultat.texte).toContain("Corps en HTML");
    expect(resultat.texte).not.toContain("tracker.example");
  });

  it("garde ce comportement quelle que soit l'ordre des parties dans l'arbre MIME (HTML avant le texte brut)", async () => {
    FakeImapFlow.prochaineBodyStructure = {
      type: "multipart/alternative",
      childNodes: [
        { type: "text/html", part: "1", size: 10 },
        { type: "text/plain", part: "2", size: 10 },
      ],
    };
    FakeImapFlow.prochainContenuParPart = {
      "1": "<p>Corps en HTML</p>",
      "2": "Texte brut de repli.",
    };

    const { obtenirContenuComplet } = await import("../imapClient");
    const resultat = await obtenirContenuComplet(identifiants as never, "43");

    expect(resultat.html).toContain("Corps en HTML");
  });

  it("se replie sur le texte brut si aucune partie HTML n'existe", async () => {
    FakeImapFlow.prochaineBodyStructure = {
      type: "text/plain",
      part: "1",
      size: 10,
    };
    FakeImapFlow.prochainContenuParPart = { "1": "Corps en texte brut." };

    const { obtenirContenuComplet } = await import("../imapClient");
    const resultat = await obtenirContenuComplet(identifiants as never, "44");

    expect(resultat).toEqual({ html: null, texte: "Corps en texte brut." });
  });
});
