import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";

/**
 * Signe une licence de test avec la paire de cles Ed25519 TEST du Lot 3
 * (backend/test-keys/) - jamais la cle de production. Reproduit
 * EXACTEMENT canonicalizePayload() de security/licenceManager.ts (meme
 * ordre de cles) : toute divergence casserait la verification cote
 * application.
 */

const TEST_PRIVATE_KEY_PATH = path.join(__dirname, "..", "..", "..", "test-keys", "licence-test-private.pem");

export interface TestLicencePayload {
  cabinetId: string;
  nomCabinet: string;
  dateExpiration: string;
  empreinteMachine: string;
  modulesActifs: string[];
  modeVerification: "auto" | "manuel";
}

function canonicalizePayload(payload: TestLicencePayload): Buffer {
  const ordered = {
    cabinetId: payload.cabinetId,
    nomCabinet: payload.nomCabinet,
    dateExpiration: payload.dateExpiration,
    empreinteMachine: payload.empreinteMachine,
    modulesActifs: payload.modulesActifs,
    modeVerification: payload.modeVerification,
  };
  return Buffer.from(JSON.stringify(ordered), "utf8");
}

export function signTestLicence(payload: TestLicencePayload): { payload: TestLicencePayload; signature: string } {
  const privateKey = crypto.createPrivateKey({
    key: fs.readFileSync(TEST_PRIVATE_KEY_PATH, "utf8"),
    format: "pem",
  });
  const signature = crypto.sign(null, canonicalizePayload(payload), privateKey).toString("base64");
  return { payload, signature };
}
