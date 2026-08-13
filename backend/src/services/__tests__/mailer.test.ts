import { beforeAll, describe, expect, it } from "vitest";

// mailer.ts importe config/env.ts, qui exige DATABASE_URL/SESSION_SECRET au
// chargement du module (voir env.ts) - jamais utilise par les fonctions
// testees ici (pures, aucun acces DB), mais l'import doit neanmoins pouvoir
// se resoudre. Valeurs factices, import dynamique APRES leur affectation
// (un import statique serait hisse avant ces lignes).
process.env.DATABASE_URL ??= "postgresql://user:pass@localhost:5432/test";
process.env.SESSION_SECRET ??= "0123456789abcdef0123456789abcdef";

let texteAvecContact: typeof import("../mailer").texteAvecContact;
let htmlAvecContact: typeof import("../mailer").htmlAvecContact;

beforeAll(async () => {
  ({ texteAvecContact, htmlAvecContact } = await import("../mailer"));
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
