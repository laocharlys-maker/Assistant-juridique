import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import type { ConnexionEmailExterne } from "@prisma/client";

/**
 * Lot "lecture complete + reponse" (2026-08-16) : obtenirContenuComplet()
 * (extraction du corps complet, jamais persiste) et envoyerReponse()
 * (construction du message brut RFC822 + threading In-Reply-To/References,
 * repli 403 explicite si le scope gmail.send manque encore sur une
 * connexion plus ancienne).
 */

vi.mock("../../../lib/prisma", () => ({ prisma: { connexionEmailExterne: { update: vi.fn() } } }));

const fetchMock = vi.fn();

beforeEach(() => {
  vi.stubGlobal("fetch", fetchMock);
  fetchMock.mockReset();
});

afterEach(() => {
  vi.unstubAllGlobals();
});

function connexion(overrides: Partial<ConnexionEmailExterne> = {}): ConnexionEmailExterne {
  return {
    id: "conn-1",
    userId: "user-1",
    provider: "gmail",
    accessToken: "token-valide",
    refreshToken: "refresh",
    tokenExpiresAt: new Date(Date.now() + 60 * 60 * 1000),
    adresseEmail: "avocat@cabinet.fr",
    imapHost: null,
    imapPort: null,
    imapSecure: true,
    imapUsername: null,
    imapPassword: null,
    smtpHost: null,
    smtpPort: null,
    smtpSecure: false,
    dernierIdentifiantSynchronise: null,
    actif: true,
    derniereErreur: null,
    createdAt: new Date(),
    updatedAt: new Date(),
    ...overrides,
  } as ConnexionEmailExterne;
}

function reponseJson(body: unknown, status = 200) {
  return { ok: status < 400, status, json: async () => body, text: async () => JSON.stringify(body) };
}

describe("obtenirContenuComplet", () => {
  it("priorise le HTML sur le texte brut quand les deux existent (comme Gmail et tout client mail)", async () => {
    // Un email multipart (le plus courant pour newsletters/notifications)
    // fournit un texte/plain "genere" par l'outil d'envoi, souvent
    // illisible tel quel (URLs de tracking imbriquees entre parentheses) -
    // le HTML, plus fidele, doit toujours etre prefere quand il existe
    // (constate en usage reel : un email propre dans Gmail ressortait
    // brouillon ici, car le texte/plain brut etait affiche par defaut).
    const { obtenirContenuComplet } = await import("../gmailClient");
    fetchMock.mockResolvedValueOnce(
      reponseJson({
        internalDate: "1700000000000",
        payload: {
          mimeType: "multipart/alternative",
          body: {},
          parts: [
            {
              mimeType: "text/plain",
              body: { data: Buffer.from("Google ( https://tracker.example/click )", "utf8").toString("base64url") },
            },
            { mimeType: "text/html", body: { data: Buffer.from("<p>Corps en HTML</p>", "utf8").toString("base64url") } },
          ],
        },
      })
    );

    const resultat = await obtenirContenuComplet(connexion(), "msg-1");

    expect(resultat.html).toContain("Corps en HTML");
    expect(resultat.texte).toContain("Corps en HTML");
    expect(resultat.texte).not.toContain("tracker.example");
    expect(fetchMock).toHaveBeenCalledWith(expect.stringContaining("/messages/msg-1?format=full"), expect.anything());
  });

  it("se replie sur le texte brut si aucune partie HTML n'existe", async () => {
    const { obtenirContenuComplet } = await import("../gmailClient");
    fetchMock.mockResolvedValueOnce(
      reponseJson({
        internalDate: "1700000000000",
        payload: {
          mimeType: "text/plain",
          body: { data: Buffer.from("Corps en texte brut.", "utf8").toString("base64url") },
        },
      })
    );

    const resultat = await obtenirContenuComplet(connexion(), "msg-1b");

    expect(resultat).toEqual({ html: null, texte: "Corps en texte brut." });
  });

  it("se replie sur le HTML converti en texte si aucun text/plain n'existe", async () => {
    const { obtenirContenuComplet } = await import("../gmailClient");
    fetchMock.mockResolvedValueOnce(
      reponseJson({
        internalDate: "1700000000000",
        payload: {
          mimeType: "text/html",
          body: { data: Buffer.from("<p>Seulement du HTML</p>", "utf8").toString("base64url") },
        },
      })
    );

    const resultat = await obtenirContenuComplet(connexion(), "msg-2");

    // html : version nettoyee prete pour l'affichage fidele (iframe sandboxee
    // cote frontend), conserve les balises de mise en page autorisees.
    expect(resultat.html).toContain("Seulement du HTML");
    expect(resultat.html).toContain("<p>");
    // texte : repli brut (email vide/rendu HTML impossible), aucune balise.
    expect(resultat.texte).toContain("Seulement du HTML");
    expect(resultat.texte).not.toContain("<p>");
  });

  it("propage une erreur explicite si Gmail répond en échec", async () => {
    const { obtenirContenuComplet } = await import("../gmailClient");
    fetchMock.mockResolvedValueOnce({ ok: false, status: 404, text: async () => "" });

    await expect(obtenirContenuComplet(connexion(), "msg-3")).rejects.toThrow(/HTTP 404/);
  });

  it("préserve les paragraphes du HTML (jamais tout aplati sur une seule ligne comme l'extrait de contexte)", async () => {
    const { obtenirContenuComplet } = await import("../gmailClient");
    const html = "<p>Premier paragraphe.</p><p>Deuxième paragraphe.</p><p>Troisième.<br/>Suite sur une nouvelle ligne.</p>";
    fetchMock.mockResolvedValueOnce(
      reponseJson({
        internalDate: "1700000000000",
        payload: { mimeType: "text/html", body: { data: Buffer.from(html, "utf8").toString("base64url") } },
      })
    );

    const resultat = await obtenirContenuComplet(connexion(), "msg-4");

    expect(resultat.texte).toBe(
      "Premier paragraphe.\n\nDeuxième paragraphe.\n\nTroisième.\nSuite sur une nouvelle ligne."
    );
  });
});

describe("envoyerReponse", () => {
  it("construit le message avec threadId, In-Reply-To/References et Subject préfixé 'Re:'", async () => {
    fetchMock
      .mockResolvedValueOnce(
        reponseJson({
          threadId: "thread-abc",
          payload: {
            headers: [
              { name: "Message-ID", value: "<original@exemple.fr>" },
              { name: "Subject", value: "Question sur mon dossier" },
            ],
          },
        })
      )
      .mockResolvedValueOnce(reponseJson({ id: "sent-1" }));

    const { envoyerReponse } = await import("../gmailClient");
    await envoyerReponse(connexion(), {
      identifiantExterne: "msg-1",
      destinataire: "client@exemple.fr",
      sujet: "Question sur mon dossier",
      corps: "Bonjour, voici ma réponse.",
    });

    expect(fetchMock).toHaveBeenCalledTimes(2);
    const [, optionsEnvoi] = fetchMock.mock.calls[1]!;
    const corpsRequete = JSON.parse((optionsEnvoi as { body: string }).body);
    expect(corpsRequete.threadId).toBe("thread-abc");

    const messageDecode = Buffer.from(
      corpsRequete.raw.replace(/-/g, "+").replace(/_/g, "/"),
      "base64"
    ).toString("utf8");
    expect(messageDecode).toContain("In-Reply-To: <original@exemple.fr>");
    expect(messageDecode).toContain("References: <original@exemple.fr>");
    expect(messageDecode).toContain("To: client@exemple.fr");
    expect(messageDecode).toContain("Bonjour, voici ma réponse.");
  });

  it("ne double pas le préfixe 'Re:' si le sujet d'origine en a déjà un", async () => {
    fetchMock
      .mockResolvedValueOnce(
        reponseJson({
          threadId: "thread-abc",
          payload: { headers: [{ name: "Subject", value: "Re: Deja une reponse" }] },
        })
      )
      .mockResolvedValueOnce(reponseJson({ id: "sent-1" }));

    const { envoyerReponse } = await import("../gmailClient");
    await envoyerReponse(connexion(), {
      identifiantExterne: "msg-1",
      destinataire: "client@exemple.fr",
      sujet: "Deja une reponse",
      corps: "Suite.",
    });

    const [, optionsEnvoi] = fetchMock.mock.calls[1]!;
    const corpsRequete = JSON.parse((optionsEnvoi as { body: string }).body);
    const messageDecode = Buffer.from(corpsRequete.raw.replace(/-/g, "+").replace(/_/g, "/"), "base64").toString("utf8");
    expect(messageDecode).toContain("Subject: Re: Deja une reponse");
    expect(messageDecode).not.toContain("Re: Re:");
  });

  it("renvoie un message explicite (reconnexion nécessaire) sur un 403 - scope gmail.send absent", async () => {
    fetchMock
      .mockResolvedValueOnce(reponseJson({ threadId: "t", payload: { headers: [] } }))
      .mockResolvedValueOnce({ ok: false, status: 403, text: async () => "insufficient authentication scopes" });

    const { envoyerReponse } = await import("../gmailClient");

    await expect(
      envoyerReponse(connexion(), {
        identifiantExterne: "msg-1",
        destinataire: "client@exemple.fr",
        sujet: "Sujet",
        corps: "Corps",
      })
    ).rejects.toThrow(/reconnecte ton compte Gmail/);
  });
});
