import { describe, it, expect } from "vitest";
import {
  genererPaireClesX25519,
  exporterClePubliqueBase64,
  importerClePubliqueBase64,
  exporterClePriveeBase64,
  importerClePriveeBase64,
  calculerCleParGesee,
  chiffrerEnveloppe,
  dechiffrerEnveloppe,
  EnveloppeInvalideError,
  genererSecretAppairage,
  hacherSecret,
  secretsEgaux,
} from "../crypto";

describe("mobileSync/crypto", () => {
  it("round-trip clé publique X25519 (export 32 octets bruts -> réimport)", () => {
    const paire = genererPaireClesX25519();
    const reimportee = importerClePubliqueBase64(paire.clePubliqueBase64);
    expect(reimportee.asymmetricKeyType).toBe("x25519");
    // Reexport doit redonner exactement la meme chaine base64.
    expect(exporterClePubliqueBase64(reimportee)).toBe(paire.clePubliqueBase64);
  });

  it("rejette une clé publique dont la longueur décodée n'est pas 32 octets", () => {
    expect(() => importerClePubliqueBase64(Buffer.from("trop court").toString("base64"))).toThrow(
      "CLE_PUBLIQUE_INVALIDE"
    );
  });

  it("round-trip clé privée (export PKCS8 base64 -> réimport) produit la même clé partagée", () => {
    const pc = genererPaireClesX25519();
    const pcPriveeReimportee = importerClePriveeBase64(exporterClePriveeBase64(pc.clePriveeKeyObject));
    const tel = genererPaireClesX25519();

    const skAvecOriginale = calculerCleParGesee(pc.clePriveeKeyObject, importerClePubliqueBase64(tel.clePubliqueBase64), "device-1");
    const skAvecReimportee = calculerCleParGesee(pcPriveeReimportee, importerClePubliqueBase64(tel.clePubliqueBase64), "device-1");
    expect(skAvecReimportee.equals(skAvecOriginale)).toBe(true);
  });

  it("ECDH : les deux parties calculent indépendamment la même clé partagée, sans jamais la transmettre", () => {
    const pc = genererPaireClesX25519();
    const tel = genererPaireClesX25519();
    const deviceId = "device-abc";

    const skCotePc = calculerCleParGesee(pc.clePriveeKeyObject, importerClePubliqueBase64(tel.clePubliqueBase64), deviceId);
    const skCoteTel = calculerCleParGesee(tel.clePriveeKeyObject, importerClePubliqueBase64(pc.clePubliqueBase64), deviceId);
    expect(skCotePc.equals(skCoteTel)).toBe(true);
    expect(skCotePc.length).toBe(32);
  });

  it("deviceId différent -> clé partagée différente (la dérivation HKDF lie bien la clé à l'appareil)", () => {
    const pc = genererPaireClesX25519();
    const tel = genererPaireClesX25519();
    const skA = calculerCleParGesee(pc.clePriveeKeyObject, importerClePubliqueBase64(tel.clePubliqueBase64), "device-A");
    const skB = calculerCleParGesee(pc.clePriveeKeyObject, importerClePubliqueBase64(tel.clePubliqueBase64), "device-B");
    expect(skA.equals(skB)).toBe(false);
  });

  it("chiffre puis déchiffre une enveloppe correctement (round-trip)", () => {
    const sk = Buffer.alloc(32, 7);
    const aad = Buffer.from(JSON.stringify({ deviceId: "d1", compteur: 1, horodatage: 1000 }));
    const plaintext = Buffer.from(JSON.stringify({ bonjour: "monde" }));

    const enveloppe = chiffrerEnveloppe(sk, plaintext, aad);
    const dechiffre = dechiffrerEnveloppe(sk, enveloppe, aad);
    expect(dechiffre.toString("utf8")).toBe(plaintext.toString("utf8"));
  });

  it("rejette le déchiffrement si l'AAD (deviceId/compteur/horodatage) a été modifié", () => {
    const sk = Buffer.alloc(32, 7);
    const aadOrigine = Buffer.from(JSON.stringify({ deviceId: "d1", compteur: 1 }));
    const enveloppe = chiffrerEnveloppe(sk, Buffer.from("secret"), aadOrigine);

    const aadModifie = Buffer.from(JSON.stringify({ deviceId: "d1", compteur: 2 }));
    expect(() => dechiffrerEnveloppe(sk, enveloppe, aadModifie)).toThrow(EnveloppeInvalideError);
  });

  it("rejette le déchiffrement avec une clé partagée différente", () => {
    const sk1 = Buffer.alloc(32, 1);
    const sk2 = Buffer.alloc(32, 2);
    const aad = Buffer.from("aad");
    const enveloppe = chiffrerEnveloppe(sk1, Buffer.from("secret"), aad);
    expect(() => dechiffrerEnveloppe(sk2, enveloppe, aad)).toThrow(EnveloppeInvalideError);
  });

  it("rejette une enveloppe tronquée/corrompue sans jamais lever une exception non typée", () => {
    const sk = Buffer.alloc(32, 7);
    expect(() => dechiffrerEnveloppe(sk, "dHJvcCBjb3VydA==", Buffer.from("aad"))).toThrow(EnveloppeInvalideError);
    expect(() => dechiffrerEnveloppe(sk, "!!!pas du base64 valide!!!", Buffer.from("aad"))).toThrow(
      EnveloppeInvalideError
    );
  });

  it("secret d'appairage : le hash est stable et vérifiable sans jamais stocker le secret en clair", () => {
    const { secretBase64, secretHash } = genererSecretAppairage();
    const secretBrut = Buffer.from(secretBase64, "base64");
    expect(secretBrut.length).toBe(32);
    expect(secretsEgaux(hacherSecret(secretBrut), secretHash)).toBe(true);
  });

  it("secretsEgaux : comparaison en temps constant, rejette un secret incorrect", () => {
    const { secretHash } = genererSecretAppairage();
    const autreSecret = Buffer.alloc(32, 9);
    expect(secretsEgaux(hacherSecret(autreSecret), secretHash)).toBe(false);
  });
});
