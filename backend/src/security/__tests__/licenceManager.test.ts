import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

/**
 * Lot 22 : verifie le branchement registreModeles.ts <-> phone-home dans
 * runPhoneHomeCheck (licenceManager.ts) - PAS une re-verification du cycle
 * de vie de la licence lui-meme (deja couvert par tests/e2e/
 * licence-expiry-flow.test.ts). Isole du vrai profil utilisateur via APPDATA
 * (meme convention que stockageDocuments.test.ts) et utilise la vraie
 * empreinte machine + la cle Ed25519 de TEST (tests/setup.ts substitue
 * config/licencePublicKey.ts, voir ce fichier) plutot que des mocks, pour
 * exercer le vrai chemin de verification de signature de bout en bout.
 *
 * signTestLicence() est duplique localement (plutot qu'importe depuis
 * tests/e2e/helpers/testLicence.ts) : ce fichier vit sous src/ (rootDir du
 * tsconfig backend, `include: ["src"]`), qui ne peut pas importer un module
 * .ts situe sous tests/ (TS6059). La cle privee de test (test-keys/, un
 * fichier de donnees, pas un module TS) reste en revanche lisible sans
 * probleme via fs.readFileSync.
 */

interface TestLicencePayload {
  cabinetId: string;
  nomCabinet: string;
  dateExpiration: string;
  empreinteMachine: string;
  modulesActifs: string[];
  modeVerification: "auto" | "manuel";
  limiteComptes?: number | null;
}

const TEST_PRIVATE_KEY_PATH = path.join(__dirname, "..", "..", "..", "test-keys", "licence-test-private.pem");

function canonicalizeTestPayload(payload: TestLicencePayload): Buffer {
  const ordered = {
    cabinetId: payload.cabinetId,
    nomCabinet: payload.nomCabinet,
    dateExpiration: payload.dateExpiration,
    empreinteMachine: payload.empreinteMachine,
    modulesActifs: payload.modulesActifs,
    modeVerification: payload.modeVerification,
    // Omis (undefined) sur tout appelant qui ne le renseigne pas - reproduit
    // volontairement une licence emise AVANT ce champ (voir describe
    // "limiteComptes" plus bas).
    limiteComptes: payload.limiteComptes,
  };
  return Buffer.from(JSON.stringify(ordered), "utf8");
}

function signTestLicence(payload: TestLicencePayload): { payload: TestLicencePayload; signature: string } {
  const privateKey = crypto.createPrivateKey({ key: fs.readFileSync(TEST_PRIVATE_KEY_PATH, "utf8"), format: "pem" });
  const signature = crypto.sign(null, canonicalizeTestPayload(payload), privateKey).toString("base64");
  return { payload, signature };
}

let fakeAppData: string;
let activateLicence: typeof import("../licenceManager").activateLicence;
let runPhoneHomeCheck: typeof import("../licenceManager").runPhoneHomeCheck;
let getCurrentLicenceStatus: typeof import("../licenceManager").getCurrentLicenceStatus;
let calculerModulesDesactives: typeof import("../licenceManager").calculerModulesDesactives;
let getMachineFingerprint: typeof import("../machineFingerprint").getMachineFingerprint;
let registreModeles: typeof import("../../services/llm/registreModeles");

const fetchMock = vi.fn();
const CABINET_ID = "22222222-2222-2222-2222-222222222222";

beforeAll(async () => {
  fakeAppData = fs.mkdtempSync(path.join(os.tmpdir(), "aurore-test-licencemanager-"));
  process.env.APPDATA = fakeAppData;
  process.env.LICENCE_PHONE_HOME_URL = "https://licence.test/phone-home";

  ({ activateLicence, runPhoneHomeCheck, getCurrentLicenceStatus, calculerModulesDesactives } = await import(
    "../licenceManager"
  ));
  ({ getMachineFingerprint } = await import("../machineFingerprint"));
  registreModeles = await import("../../services/llm/registreModeles");
});

afterAll(() => {
  fs.rmSync(fakeAppData, { recursive: true, force: true });
});

afterEach(() => {
  vi.unstubAllGlobals();
  fetchMock.mockReset();
  registreModeles._reinitialiserCachePourTests();
  const fichierCache = path.join(fakeAppData, "Aurore", "secrets", "registre-modeles-distant.json");
  if (fs.existsSync(fichierCache)) fs.rmSync(fichierCache);
});

function reponseHttpOk(body: unknown) {
  return { ok: true, status: 200, json: async () => body };
}

async function activerLicence(modeVerification: "auto" | "manuel") {
  const empreinteMachine = await getMachineFingerprint();
  const licence = signTestLicence({
    cabinetId: CABINET_ID,
    nomCabinet: "Cabinet Test Lot22",
    dateExpiration: new Date(Date.now() + 365 * 24 * 60 * 60 * 1000).toISOString(),
    empreinteMachine,
    modulesActifs: ["all"],
    modeVerification,
  });
  await activateLicence(JSON.stringify(licence));
  return { empreinteMachine };
}

function licenceRenouveleeSignee(empreinteMachine: string) {
  return signTestLicence({
    cabinetId: CABINET_ID,
    nomCabinet: "Cabinet Test Lot22",
    dateExpiration: new Date(Date.now() + 400 * 24 * 60 * 60 * 1000).toISOString(),
    empreinteMachine,
    modulesActifs: ["all"],
    modeVerification: "auto",
  });
}

describe("runPhoneHomeCheck - modelesLlmActifs (Lot22)", () => {
  it("met a jour le registre local des modeles quand le champ est present dans une reponse reussie", async () => {
    const { empreinteMachine } = await activerLicence("auto");
    vi.stubGlobal("fetch", fetchMock);
    fetchMock.mockResolvedValueOnce(
      reponseHttpOk({ licence: licenceRenouveleeSignee(empreinteMachine), modelesLlmActifs: { groq: "modele-distant-test" } })
    );

    const resultat = await runPhoneHomeCheck();

    expect(resultat.action).toBe("renouvelee");
    expect(registreModeles.getModelePrincipal("groq")).toBe("modele-distant-test");
  });

  it("ignore un serveur qui ne renvoie pas modelesLlmActifs (compatibilite avec un ancien aurore-licence-service) - garde la config locale", async () => {
    const { empreinteMachine } = await activerLicence("auto");
    vi.stubGlobal("fetch", fetchMock);
    fetchMock.mockResolvedValueOnce(reponseHttpOk({ licence: licenceRenouveleeSignee(empreinteMachine) }));

    const resultat = await runPhoneHomeCheck();

    expect(resultat.action).toBe("renouvelee");
    expect(registreModeles.getModelePrincipal("groq")).toBe("llama-3.3-70b-versatile");
  });

  it("n'echoue pas le parsing si la reponse contient un champ totalement inconnu en plus de modelesLlmActifs", async () => {
    const { empreinteMachine } = await activerLicence("auto");
    vi.stubGlobal("fetch", fetchMock);
    fetchMock.mockResolvedValueOnce(
      reponseHttpOk({
        licence: licenceRenouveleeSignee(empreinteMachine),
        modelesLlmActifs: { anthropic: "modele-distant-anthropic" },
        champInconnuFutur: "valeur-non-prevue-par-ce-client",
      })
    );

    const resultat = await runPhoneHomeCheck();

    expect(resultat.action).toBe("renouvelee");
    expect(registreModeles.getModelePrincipal("anthropic")).toBe("modele-distant-anthropic");
  });

  it("mode manuel : aucun appel reseau et registre inchange, meme si une mise a jour serait disponible cote serveur", async () => {
    await activerLicence("manuel");
    vi.stubGlobal("fetch", fetchMock);

    const resultat = await runPhoneHomeCheck();

    expect(resultat.action).toBe("ignore");
    expect(fetchMock).not.toHaveBeenCalled();
    expect(registreModeles.getModelePrincipal("groq")).toBe("llama-3.3-70b-versatile");
  });
});

describe("limiteComptes (Lot 20bis) - retrocompatibilite de la signature", () => {
  it("active sans erreur une licence signee AVANT l'introduction de ce champ (absent du payload)", async () => {
    const empreinteMachine = await getMachineFingerprint();
    const licence = signTestLicence({
      cabinetId: CABINET_ID,
      nomCabinet: "Cabinet Test Lot22",
      dateExpiration: new Date(Date.now() + 365 * 24 * 60 * 60 * 1000).toISOString(),
      empreinteMachine,
      modulesActifs: ["all"],
      modeVerification: "manuel",
      // limiteComptes volontairement absent - reproduit une licence emise
      // avant ce champ.
    });

    const status = await activateLicence(JSON.stringify(licence));

    expect(status.etat).toBe("valide");
    expect(status.payload?.limiteComptes).toBeUndefined();
  });

  it("active et restitue une licence signee AVEC limiteComptes", async () => {
    const empreinteMachine = await getMachineFingerprint();
    const licence = signTestLicence({
      cabinetId: CABINET_ID,
      nomCabinet: "Cabinet Test Lot22",
      dateExpiration: new Date(Date.now() + 365 * 24 * 60 * 60 * 1000).toISOString(),
      empreinteMachine,
      modulesActifs: ["all"],
      modeVerification: "manuel",
      limiteComptes: 3,
    });

    await activateLicence(JSON.stringify(licence));
    const status = await getCurrentLicenceStatus();

    expect(status.etat).toBe("valide");
    expect(status.payload?.limiteComptes).toBe(3);
  });
});

describe("calculerModulesDesactives (Lot 20ter) - controle fin par action, dashboard de licence", () => {
  it("ne desactive rien pour la convention historique [\"all\"]", () => {
    expect(calculerModulesDesactives(["all"])).toEqual([]);
  });

  it("desactive tous les modules connus quand la liste blanche est vide", () => {
    const desactives = calculerModulesDesactives([]);
    expect(desactives).toContain("action_rediger");
    expect(desactives).toContain("action_recherche_juridique");
    expect(desactives).toContain("action_transcription");
    expect(desactives).toContain("nouvelle_action");
  });

  it("ne desactive que les modules absents de la liste blanche", () => {
    const desactives = calculerModulesDesactives(["nouvelle_action", "action_rediger", "action_traduction"]);
    expect(desactives).not.toContain("action_rediger");
    expect(desactives).not.toContain("action_traduction");
    expect(desactives).toContain("action_recherche_juridique");
    expect(desactives).toContain("action_transcription");
    expect(desactives).toContain("facturation");
  });

  it("ignore silencieusement une cle inconnue dans la liste blanche (jamais une erreur)", () => {
    expect(() => calculerModulesDesactives(["cle_future_inconnue"])).not.toThrow();
  });
});
