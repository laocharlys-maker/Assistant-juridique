import {
  genererPaireClesTelephone,
  clePubliqueVersBase64,
  clePubliqueDepuisBase64,
  calculerCleParGesee,
  chiffrerEnveloppe,
  dechiffrerEnveloppe,
  construireAad,
  EnveloppeInvalideError,
} from "./protocol";

/**
 * Vecteurs FIXES generes une fois avec le module `crypto` natif de Node
 * (cote PC, voir backend/src/services/mobileSync/crypto.ts et
 * scripts/generate-test-vectors.cjs) - verifient que ce module cote
 * telephone (pure JS, @noble/*) produit EXACTEMENT les memes resultats que
 * le serveur, condition necessaire a l'appairage reel (voir docs/lot10/
 * 01-protocole.md, "vecteurs de test partages avec le serveur du Prompt 1").
 */
import vecteurs from "./__fixtures__/vecteurs-fixes.json";
const { PC_PUB_RAW_HEX, TEL_PRIV_RAW_HEX, TEL_PUB_RAW_HEX, DEVICE_ID, SK_DERIVEE_HEX } = vecteurs;

function hexToBytes(hex: string): Uint8Array {
  const bytes = new Uint8Array(hex.length / 2);
  for (let i = 0; i < bytes.length; i++) bytes[i] = parseInt(hex.slice(i * 2, i * 2 + 2), 16);
  return bytes;
}

function bytesToHex(bytes: Uint8Array): string {
  return Array.from(bytes).map((b) => b.toString(16).padStart(2, "0")).join("");
}

describe("crypto/protocol - interopérabilité avec le serveur (Node natif)", () => {
  it("calcule EXACTEMENT la même clé partagée que le serveur, à partir des mêmes clés brutes", () => {
    const telPriv = hexToBytes(TEL_PRIV_RAW_HEX);
    const pcPub = hexToBytes(PC_PUB_RAW_HEX);
    const sk = calculerCleParGesee(telPriv, pcPub, DEVICE_ID);
    expect(bytesToHex(sk)).toBe(SK_DERIVEE_HEX);
  });

  it("round-trip base64 de la clé publique du téléphone (vecteur fixe)", () => {
    const telPub = hexToBytes(TEL_PUB_RAW_HEX);
    const base64 = clePubliqueVersBase64(telPub);
    const reimportee = clePubliqueDepuisBase64(base64);
    expect(bytesToHex(reimportee)).toBe(TEL_PUB_RAW_HEX);
  });
});

describe("crypto/protocol - génération et chiffrement (auto-cohérence)", () => {
  it("génère une paire de clés de 32 octets chacune", () => {
    const paire = genererPaireClesTelephone();
    expect(paire.clePriveeRaw.length).toBe(32);
    expect(paire.clePubliqueRaw.length).toBe(32);
  });

  it("deux parties calculent la même clé partagée à partir de leurs paires respectives", () => {
    const pc = genererPaireClesTelephone(); // reutilise le meme generateur pour simuler le PC ici
    const tel = genererPaireClesTelephone();
    const deviceId = "device-xyz";
    const skTel = calculerCleParGesee(tel.clePriveeRaw, pc.clePubliqueRaw, deviceId);
    const skPc = calculerCleParGesee(pc.clePriveeRaw, tel.clePubliqueRaw, deviceId);
    expect(bytesToHex(skTel)).toBe(bytesToHex(skPc));
  });

  it("chiffre puis déchiffre une enveloppe correctement", () => {
    const sk = new Uint8Array(32).fill(7);
    const aad = construireAad("device-1", 1, 1000);
    const plaintext = new TextEncoder().encode(JSON.stringify({ bonjour: "monde" }));
    const enveloppe = chiffrerEnveloppe(sk, plaintext, aad);
    const dechiffre = dechiffrerEnveloppe(sk, enveloppe, aad);
    expect(new TextDecoder().decode(dechiffre)).toBe(new TextDecoder().decode(plaintext));
  });

  it("rejette le déchiffrement si l'AAD a été modifié (anti-tampering)", () => {
    const sk = new Uint8Array(32).fill(7);
    const enveloppe = chiffrerEnveloppe(sk, new TextEncoder().encode("secret"), construireAad("d1", 1, 1000));
    expect(() => dechiffrerEnveloppe(sk, enveloppe, construireAad("d1", 2, 1000))).toThrow(EnveloppeInvalideError);
  });

  it("rejette le déchiffrement avec une clé différente", () => {
    const sk1 = new Uint8Array(32).fill(1);
    const sk2 = new Uint8Array(32).fill(2);
    const aad = construireAad("d1", 1, 1000);
    const enveloppe = chiffrerEnveloppe(sk1, new TextEncoder().encode("secret"), aad);
    expect(() => dechiffrerEnveloppe(sk2, enveloppe, aad)).toThrow(EnveloppeInvalideError);
  });

  it("rejette une enveloppe corrompue sans jamais lever une exception non typée", () => {
    const sk = new Uint8Array(32).fill(7);
    expect(() => dechiffrerEnveloppe(sk, "!!! pas du base64 valide !!!", construireAad("d1", 1, 1000))).toThrow(
      EnveloppeInvalideError
    );
  });
});
