// Script ponctuel (pas execute en CI) pour regenerer les vecteurs de test
// fixes de src/crypto/protocol.test.ts si jamais necessaire - ecrit
// directement le fichier de test pour eviter toute retranscription manuelle
// d'un hex genere a la main (source d'erreur deja rencontree une fois).
const fs = require("fs");
const path = require("path");
const crypto = require("crypto");

const pc = crypto.generateKeyPairSync("x25519");
const pcPubDer = pc.publicKey.export({ type: "spki", format: "der" });
const pcPubRaw = pcPubDer.subarray(pcPubDer.length - 32);

const telPrivRaw = crypto.randomBytes(32);
const enTetePkcs8 = Buffer.from("302e020100300506032b656e04220420", "hex");
const telPrivKeyObject = crypto.createPrivateKey({
  key: Buffer.concat([enTetePkcs8, telPrivRaw]),
  format: "der",
  type: "pkcs8",
});
const telPubKeyObject = crypto.createPublicKey(telPrivKeyObject);
const telPubDer = telPubKeyObject.export({ type: "spki", format: "der" });
const telPubRaw = telPubDer.subarray(telPubDer.length - 32);

const sk = crypto.diffieHellman({ privateKey: pc.privateKey, publicKey: telPubKeyObject });
const deviceId = "device-fixe-pour-tests";
const hkdfOut = Buffer.from(crypto.hkdfSync("sha256", sk, Buffer.from("aurore-mobile-v1"), Buffer.from(deviceId), 32));

const vecteurs = {
  PC_PUB_RAW_HEX: pcPubRaw.toString("hex"),
  TEL_PRIV_RAW_HEX: telPrivRaw.toString("hex"),
  TEL_PUB_RAW_HEX: telPubRaw.toString("hex"),
  DEVICE_ID: deviceId,
  SK_DERIVEE_HEX: hkdfOut.toString("hex"),
};

for (const [k, v] of Object.entries(vecteurs)) {
  if (k !== "DEVICE_ID" && v.length !== 64) {
    throw new Error(`Vecteur ${k} de longueur inattendue : ${v.length}`);
  }
}

const sortie = path.join(__dirname, "..", "src", "crypto", "__fixtures__", "vecteurs-fixes.json");
fs.mkdirSync(path.dirname(sortie), { recursive: true });
fs.writeFileSync(sortie, JSON.stringify(vecteurs, null, 2) + "\n");
console.log("Écrit :", sortie);
console.log(vecteurs);
