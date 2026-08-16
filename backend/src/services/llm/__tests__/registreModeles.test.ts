import { afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

/**
 * Lot 22 : registre centralise des modeles LLM (registreModeles.ts).
 * Isole du vrai profil utilisateur via APPDATA (meme convention que
 * stockageDocuments.test.ts) - le cache distant persiste sur disque dans
 * secretsDir(), jamais dans le vrai %APPDATA%/Aurore en test.
 */

let fakeAppData: string;
let registreModeles: typeof import("../registreModeles");

beforeAll(async () => {
  fakeAppData = fs.mkdtempSync(path.join(os.tmpdir(), "aurore-test-registre-modeles-"));
  process.env.APPDATA = fakeAppData;
  registreModeles = await import("../registreModeles");
});

afterEach(() => {
  registreModeles._reinitialiserCachePourTests();
  // userDataDir() = APPDATA/Aurore (voir database/portablePaths.ts) - le
  // cache distant vit dans son sous-dossier secrets/.
  const fichier = path.join(fakeAppData, "Aurore", "secrets", "registre-modeles-distant.json");
  if (fs.existsSync(fichier)) fs.rmSync(fichier);
});

describe("getModelePrincipal / getModeleRepli - valeurs par defaut", () => {
  it("renvoie les modeles codes en dur tant qu'aucune configuration distante n'a ete appliquee", () => {
    expect(registreModeles.getModelePrincipal("gemini")).toBe("gemini-3.6-flash");
    expect(registreModeles.getModeleRepli("gemini")).toBe("gemini-2.5-flash");
    expect(registreModeles.getModelePrincipal("anthropic")).toBe("claude-sonnet-5");
    expect(registreModeles.getModeleRepli("anthropic")).toBe("claude-haiku-4-5-20251001");
    expect(registreModeles.getModelePrincipal("groq")).toBe("llama-3.3-70b-versatile");
    expect(registreModeles.getModeleRepli("groq")).toBe("llama-3.1-8b-instant");
  });
});

describe("appliquerConfigurationDistante", () => {
  it("met a jour le modele principal d'un fournisseur sans toucher aux autres ni au modele de repli", () => {
    registreModeles.appliquerConfigurationDistante({ gemini: "gemini-4.0-flash" });

    expect(registreModeles.getModelePrincipal("gemini")).toBe("gemini-4.0-flash");
    expect(registreModeles.getModeleRepli("gemini")).toBe("gemini-2.5-flash");
    expect(registreModeles.getModelePrincipal("anthropic")).toBe("claude-sonnet-5");
  });

  it("ignore silencieusement les cles de fournisseurs inconnus (schema client plus recent que ce build)", () => {
    expect(() => registreModeles.appliquerConfigurationDistante({ mistral: "un-modele" })).not.toThrow();
    expect(registreModeles.getModelePrincipal("gemini")).toBe("gemini-3.6-flash");
  });

  it("ignore les valeurs vides/non-chaines", () => {
    registreModeles.appliquerConfigurationDistante({ gemini: "" });
    expect(registreModeles.getModelePrincipal("gemini")).toBe("gemini-3.6-flash");
  });

  it("persiste sur disque et survit a une reinitialisation du cache memoire (redemarrage simule)", () => {
    registreModeles.appliquerConfigurationDistante({ groq: "un-nouveau-modele-groq" });
    registreModeles._reinitialiserCachePourTests();

    expect(registreModeles.getModelePrincipal("groq")).toBe("un-nouveau-modele-groq");
  });
});

describe("isErreurModeleIndisponible", () => {
  it("reconnait une erreur Gemini caracteristique (404, message 'is not found for API version')", () => {
    const erreur = Object.assign(new Error("[GoogleGenerativeAI Error]: models/x is not found for API version v1beta, or is not supported for GenerateContent"), {
      status: 404,
    });
    expect(registreModeles.isErreurModeleIndisponible(erreur)).toBe(true);
  });

  it("reconnait une erreur Anthropic caracteristique (404, not_found_error)", () => {
    const erreur = Object.assign(new Error('404 {"type":"error","error":{"type":"not_found_error","message":"model: claude-x not_found"}}'), {
      status: 404,
    });
    expect(registreModeles.isErreurModeleIndisponible(erreur)).toBe(true);
  });

  it("reconnait une erreur Groq caracteristique (400, model_decommissioned)", () => {
    const erreur = Object.assign(
      new Error('Groq a repondu 400: {"error":{"message":"The model has been decommissioned","code":"model_decommissioned"}}'),
      { status: 400 }
    );
    expect(registreModeles.isErreurModeleIndisponible(erreur)).toBe(true);
  });

  it("reconnait une erreur Groq caracteristique ('does not exist')", () => {
    const erreur = Object.assign(new Error("Groq a repondu 404: The model `x` does not exist or you do not have access to it."), {
      status: 404,
    });
    expect(registreModeles.isErreurModeleIndisponible(erreur)).toBe(true);
  });

  it("NE reconnait JAMAIS une erreur de cle API invalide (401)", () => {
    const erreur = Object.assign(new Error("401 authentication_error: invalid x-api-key"), { status: 401 });
    expect(registreModeles.isErreurModeleIndisponible(erreur)).toBe(false);
  });

  it("NE reconnait JAMAIS une erreur de quota epuise (429)", () => {
    const erreur = Object.assign(new Error("429 rate_limit_exceeded: quota depasse"), { status: 429 });
    expect(registreModeles.isErreurModeleIndisponible(erreur)).toBe(false);
  });

  it("NE reconnait PAS un 400 generique sans rapport avec le nom du modele (ex: schema d'outil invalide)", () => {
    const erreur = Object.assign(new Error("400 invalid_request_error: tools.0.input_schema is invalid"), { status: 400 });
    expect(registreModeles.isErreurModeleIndisponible(erreur)).toBe(false);
  });

  it("renvoie false pour une erreur sans statut HTTP (panne reseau, timeout...)", () => {
    expect(registreModeles.isErreurModeleIndisponible(new Error("fetch failed"))).toBe(false);
  });
});

describe("appelerAvecRepli", () => {
  beforeEach(() => {
    registreModeles._reinitialiserCachePourTests();
  });

  it("appelle directement le modele principal quand tout va bien (pas de repli)", async () => {
    const appelsRecus: string[] = [];
    const resultat = await registreModeles.appelerAvecRepli("anthropic", async (nomModele) => {
      appelsRecus.push(nomModele);
      return "ok";
    });

    expect(resultat).toBe("ok");
    expect(appelsRecus).toEqual(["claude-sonnet-5"]);
  });

  it("retente automatiquement UNE FOIS avec le modele de repli si le principal est indisponible", async () => {
    const appelsRecus: string[] = [];
    const erreurModeleIndisponible = Object.assign(new Error("404 not_found_error: model not found"), { status: 404 });

    const resultat = await registreModeles.appelerAvecRepli("anthropic", async (nomModele) => {
      appelsRecus.push(nomModele);
      if (nomModele === "claude-sonnet-5") throw erreurModeleIndisponible;
      return "reponse-du-repli";
    });

    expect(resultat).toBe("reponse-du-repli");
    expect(appelsRecus).toEqual(["claude-sonnet-5", "claude-haiku-4-5-20251001"]);
  });

  it("propage l'erreur si le repli echoue aussi (jamais de deuxieme repli)", async () => {
    const appelsRecus: string[] = [];
    const erreurModeleIndisponible = Object.assign(new Error("404 not_found_error"), { status: 404 });
    const erreurRepli = new Error("le repli a echoue aussi");

    await expect(
      registreModeles.appelerAvecRepli("anthropic", async (nomModele) => {
        appelsRecus.push(nomModele);
        throw nomModele === "claude-sonnet-5" ? erreurModeleIndisponible : erreurRepli;
      })
    ).rejects.toThrow(erreurRepli);
    expect(appelsRecus).toEqual(["claude-sonnet-5", "claude-haiku-4-5-20251001"]);
  });

  it("ne declenche JAMAIS de repli sur une cle API invalide (401) - propage immediatement", async () => {
    const appelsRecus: string[] = [];
    const erreurCleInvalide = Object.assign(new Error("401 authentication_error"), { status: 401 });

    await expect(
      registreModeles.appelerAvecRepli("groq", async (nomModele) => {
        appelsRecus.push(nomModele);
        throw erreurCleInvalide;
      })
    ).rejects.toThrow(erreurCleInvalide);
    expect(appelsRecus).toEqual(["llama-3.3-70b-versatile"]);
  });

  it("ne declenche JAMAIS de repli sur un quota epuise (429) - propage immediatement", async () => {
    const appelsRecus: string[] = [];
    const erreurQuota = Object.assign(new Error("429 rate_limit_exceeded"), { status: 429 });

    await expect(
      registreModeles.appelerAvecRepli("groq", async (nomModele) => {
        appelsRecus.push(nomModele);
        throw erreurQuota;
      })
    ).rejects.toThrow(erreurQuota);
    expect(appelsRecus).toEqual(["llama-3.3-70b-versatile"]);
  });

  it("utilise le modele principal eventuellement mis a jour a distance, pas seulement la valeur par defaut", async () => {
    registreModeles.appliquerConfigurationDistante({ groq: "nouveau-modele-groq-distant" });
    const appelsRecus: string[] = [];

    await registreModeles.appelerAvecRepli("groq", async (nomModele) => {
      appelsRecus.push(nomModele);
      return "ok";
    });

    expect(appelsRecus).toEqual(["nouveau-modele-groq-distant"]);
  });
});
