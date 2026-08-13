import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

// mailer.ts importe config/env.ts, qui exige DATABASE_URL/SESSION_SECRET au
// chargement du module (voir env.ts) - jamais utilise par les fonctions
// testees ici (pures, aucun acces DB), mais l'import doit neanmoins pouvoir
// se resoudre. Valeurs factices, import dynamique APRES leur affectation
// (un import statique serait hisse avant ces lignes).
process.env.DATABASE_URL ??= "postgresql://user:pass@localhost:5432/test";
process.env.SESSION_SECRET ??= "0123456789abcdef0123456789abcdef";

let texteAvecContact: typeof import("../mailer").texteAvecContact;
let htmlAvecContact: typeof import("../mailer").htmlAvecContact;
let sendEmail: typeof import("../mailer").sendEmail;
let sendDocumentEmail: typeof import("../mailer").sendDocumentEmail;

beforeAll(async () => {
  ({ texteAvecContact, htmlAvecContact, sendEmail, sendDocumentEmail } = await import("../mailer"));
});

// Certains clients mail (Gmail notamment) ignorent parfois l'en-tete
// Reply-To et renvoient une reponse vers l'adresse technique partagee - la
// ligne de contact ajoutee au corps du message est le filet de securite en
// attendant un mecanisme de renvoi automatique fiable (voir mailer.ts).
describe("mailer - ligne de contact dans le corps du message", () => {
  it("texteAvecContact ajoute l'adresse en clair quand un Reply-To existe", () => {
    const resultat = texteAvecContact("Veuillez trouver ci-joint le document.", "cabinet@example.com");
    expect(resultat).toBe("Veuillez trouver ci-joint le document.\n\nPour nous contacter directement : cabinet@example.com");
  });

  it("texteAvecContact laisse le texte inchangé si aucun Reply-To n'est résolu", () => {
    const resultat = texteAvecContact("Veuillez trouver ci-joint le document.", null);
    expect(resultat).toBe("Veuillez trouver ci-joint le document.");
  });

  it("htmlAvecContact insère le paragraphe juste avant </body>", () => {
    const resultat = htmlAvecContact("<html><body><p>Bonjour</p></body></html>", "cabinet@example.com");
    expect(resultat).toBe(
      "<html><body><p>Bonjour</p><p>Pour nous contacter directement : cabinet@example.com</p></body></html>"
    );
  });

  it("htmlAvecContact ajoute le paragraphe à la fin si le HTML n'a pas de balise </body>", () => {
    const resultat = htmlAvecContact("<p>Bonjour</p>", "cabinet@example.com");
    expect(resultat).toBe("<p>Bonjour</p><p>Pour nous contacter directement : cabinet@example.com</p>");
  });

  it("htmlAvecContact laisse le HTML inchangé si aucun Reply-To n'est résolu", () => {
    const resultat = htmlAvecContact("<html><body><p>Bonjour</p></body></html>", null);
    expect(resultat).toBe("<html><body><p>Bonjour</p></body></html>");
  });
});

// Lot 19 - envoi via l'API REST Brevo (POST /v3/smtp/email), plus SMTP. Le
// vrai reseau n'est jamais sollicite : `fetch` est remplace par un mock
// pour chaque test (voir vi.stubGlobal ci-dessous).
describe("mailer - envoi via l'API REST Brevo (Lot 19)", () => {
  const ancienBrevoApiKey = process.env.BREVO_API_KEY;
  const ancienFromEmail = process.env.SMTP_FROM_EMAIL;

  beforeEach(() => {
    process.env.BREVO_API_KEY = "test-cle-brevo";
    process.env.SMTP_FROM_EMAIL = "notifications@aurore.test";
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllGlobals();
    if (ancienBrevoApiKey === undefined) delete process.env.BREVO_API_KEY;
    else process.env.BREVO_API_KEY = ancienBrevoApiKey;
    if (ancienFromEmail === undefined) delete process.env.SMTP_FROM_EMAIL;
    else process.env.SMTP_FROM_EMAIL = ancienFromEmail;
  });

  function mockerFetch(reponses: { status: number; body: unknown }[]) {
    const fetchMock = vi.fn();
    for (const { status, body } of reponses) {
      fetchMock.mockResolvedValueOnce({
        ok: status >= 200 && status < 300,
        status,
        json: async () => body,
        text: async () => JSON.stringify(body),
      });
    }
    vi.stubGlobal("fetch", fetchMock);
    return fetchMock;
  }

  it("envoi réussi : appelle l'API REST Brevo et renvoie le vrai messageId", async () => {
    const fetchMock = mockerFetch([{ status: 201, body: { messageId: "<abc123@relay.brevo.com>" } }]);

    const resultat = await sendEmail({
      destinataireEmail: "client@example.com",
      cabinetNom: "Cabinet Test",
      replyToEmail: "cabinet@example.com",
      subject: "Sujet de test",
      text: "Corps du message.",
    });

    expect(resultat).toEqual({ ok: true, messageId: "<abc123@relay.brevo.com>" });
    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, options] = fetchMock.mock.calls[0];
    expect(url).toBe("https://api.brevo.com/v3/smtp/email");
    expect(options.headers["api-key"]).toBe("test-cle-brevo");
    const corps = JSON.parse(options.body);
    expect(corps.sender).toEqual({ name: "Cabinet Test", email: "notifications@aurore.test" });
    expect(corps.to).toEqual([{ email: "client@example.com" }]);
    expect(corps.replyTo).toEqual({ email: "cabinet@example.com" });
    expect(corps.textContent).toContain("Pour nous contacter directement : cabinet@example.com");
  });

  it("envoi de document : encode la pièce jointe en base64 dans le tableau attachment", async () => {
    const fetchMock = mockerFetch([{ status: 201, body: { messageId: "<doc1@relay.brevo.com>" } }]);

    const resultat = await sendDocumentEmail({
      destinataireEmail: "client@example.com",
      cabinetNom: "Cabinet Test",
      replyToEmail: null,
      nomAffaire: "Affaire X",
      attachment: { filename: "acte.pdf", content: Buffer.from("contenu-pdf"), contentType: "application/pdf" },
    });

    expect(resultat.ok).toBe(true);
    const corps = JSON.parse(fetchMock.mock.calls[0][1].body);
    expect(corps.attachment).toEqual([{ name: "acte.pdf", content: Buffer.from("contenu-pdf").toString("base64") }]);
  });

  it("clé API absente : échoue proprement sans appeler le réseau", async () => {
    delete process.env.BREVO_API_KEY;
    const fetchMock = mockerFetch([]);

    const resultat = await sendEmail({
      destinataireEmail: "client@example.com",
      cabinetNom: "Cabinet Test",
      replyToEmail: null,
      subject: "Sujet",
      text: "Corps",
    });

    expect(resultat.ok).toBe(false);
    expect(resultat.error).toMatch(/configuration brevo manquante/i);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("clé API invalide (401) : échec immédiat et clair, sans nouvelle tentative", async () => {
    const fetchMock = mockerFetch([{ status: 401, body: { message: "Key not found" } }]);

    const resultat = await sendEmail({
      destinataireEmail: "client@example.com",
      cabinetNom: "Cabinet Test",
      replyToEmail: null,
      subject: "Sujet",
      text: "Corps",
    });

    expect(resultat.ok).toBe(false);
    expect(resultat.error).toContain("HTTP 401");
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("erreur transitoire (429) suivie d'un succès : réessaie puis renvoie le messageId", async () => {
    const fetchMock = mockerFetch([
      { status: 429, body: { message: "rate limit" } },
      { status: 201, body: { messageId: "<retry-ok@relay.brevo.com>" } },
    ]);

    const promesse = sendEmail({
      destinataireEmail: "client@example.com",
      cabinetNom: "Cabinet Test",
      replyToEmail: null,
      subject: "Sujet",
      text: "Corps",
    });
    await vi.advanceTimersByTimeAsync(2000);
    const resultat = await promesse;

    expect(resultat).toEqual({ ok: true, messageId: "<retry-ok@relay.brevo.com>" });
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it("erreur serveur (5xx) persistante : échoue après épuisement des tentatives", async () => {
    const fetchMock = mockerFetch([
      { status: 503, body: { message: "unavailable" } },
      { status: 503, body: { message: "unavailable" } },
      { status: 503, body: { message: "unavailable" } },
    ]);

    const promesse = sendEmail({
      destinataireEmail: "client@example.com",
      cabinetNom: "Cabinet Test",
      replyToEmail: null,
      subject: "Sujet",
      text: "Corps",
    });
    await vi.advanceTimersByTimeAsync(5000);
    const resultat = await promesse;

    expect(resultat.ok).toBe(false);
    expect(resultat.error).toContain("503");
    expect(fetchMock).toHaveBeenCalledTimes(3);
  });

  it("pièce jointe individuelle dépassant 4 Mo : échoue proprement sans appeler le réseau", async () => {
    const fetchMock = mockerFetch([]);
    const grosFichier = Buffer.alloc(4 * 1024 * 1024 + 1);

    const resultat = await sendDocumentEmail({
      destinataireEmail: "client@example.com",
      cabinetNom: "Cabinet Test",
      replyToEmail: null,
      nomAffaire: "Affaire X",
      attachment: { filename: "gros.pdf", content: grosFichier, contentType: "application/pdf" },
    });

    expect(resultat.ok).toBe(false);
    expect(resultat.error).toContain("gros.pdf");
    expect(resultat.error).toMatch(/4 Mo/);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("total des pièces jointes dépassant 20 Mo : échoue proprement sans appeler le réseau", async () => {
    const fetchMock = mockerFetch([]);
    const pieceMoyenne = Buffer.alloc(3 * 1024 * 1024); // 3 Mo, sous la limite individuelle

    const resultat = await sendEmail({
      destinataireEmail: "client@example.com",
      cabinetNom: "Cabinet Test",
      replyToEmail: null,
      subject: "Sujet",
      text: "Corps",
      attachments: Array.from({ length: 7 }, (_, i) => ({
        filename: `piece-${i}.pdf`,
        content: pieceMoyenne,
        contentType: "application/pdf",
      })), // 7 x 3 Mo = 21 Mo > 20 Mo
    });

    expect(resultat.ok).toBe(false);
    expect(resultat.error).toMatch(/20 Mo/);
    expect(fetchMock).not.toHaveBeenCalled();
  });
});
