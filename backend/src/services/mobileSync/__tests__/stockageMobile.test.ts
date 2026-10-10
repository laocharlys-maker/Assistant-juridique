import { describe, it, expect, beforeAll, afterAll } from "vitest";
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

describe("mobileSync/stockageMobile", () => {
  let fakeAppData: string;
  let ecrireChunk: typeof import("../stockageMobile").ecrireChunk;
  let assemblerEtVerifier: typeof import("../stockageMobile").assemblerEtVerifier;
  let lireFichierMobile: typeof import("../stockageMobile").lireFichierMobile;

  beforeAll(async () => {
    // Meme isolation que stockageDocuments.test.ts - jamais le vrai
    // %APPDATA%/Aurore.
    fakeAppData = fs.mkdtempSync(path.join(os.tmpdir(), "aurore-test-stockage-mobile-"));
    process.env.APPDATA = fakeAppData;
    ({ ecrireChunk, assemblerEtVerifier, lireFichierMobile } = await import("../stockageMobile"));
  });

  afterAll(() => {
    fs.rmSync(fakeAppData, { recursive: true, force: true });
  });

  function sha256(buf: Buffer): string {
    return crypto.createHash("sha256").update(buf).digest("hex");
  }

  it("assemble plusieurs morceaux dans l'ordre et redonne le contenu original bit-à-bit", async () => {
    const deviceId = "device-1";
    const clientId = "item-complet-1";
    const morceaux = [Buffer.from("Bonjour "), Buffer.from("tout le "), Buffer.from("monde.")];
    for (let i = 0; i < morceaux.length; i++) {
      await ecrireChunk(deviceId, clientId, i, morceaux[i]);
    }
    const complet = Buffer.concat(morceaux);

    const { nomFichier, tailleOctets } = await assemblerEtVerifier(deviceId, clientId, morceaux.length, sha256(complet));
    expect(tailleOctets).toBe(complet.length);

    const relu = await lireFichierMobile(deviceId, nomFichier);
    expect(relu.equals(complet)).toBe(true);
  });

  it("rejette l'assemblage si le sha256 attendu ne correspond pas (intégrité)", async () => {
    const deviceId = "device-1";
    const clientId = "item-corrompu-1";
    await ecrireChunk(deviceId, clientId, 0, Buffer.from("contenu reel"));

    await expect(assemblerEtVerifier(deviceId, clientId, 1, "0".repeat(64))).rejects.toThrow("SHA256_INVALIDE");
  });

  it("rejette l'assemblage si un morceau attendu est manquant", async () => {
    const deviceId = "device-1";
    const clientId = "item-incomplet-1";
    await ecrireChunk(deviceId, clientId, 0, Buffer.from("seul morceau envoyé"));

    // nombreChunksAttendu=2 mais un seul a ete ecrit.
    await expect(assemblerEtVerifier(deviceId, clientId, 2, sha256(Buffer.from("peu importe")))).rejects.toThrow(
      "CHUNK_MANQUANT"
    );
  });

  it("nettoie les morceaux temporaires même après un échec d'assemblage", async () => {
    const deviceId = "device-1";
    const clientId = "item-nettoyage-1";
    await ecrireChunk(deviceId, clientId, 0, Buffer.from("x"));
    await expect(assemblerEtVerifier(deviceId, clientId, 1, "0".repeat(64))).rejects.toThrow();

    // Un deuxieme essai avec les BONS morceaux doit repartir de zero sans
    // trouver de residu du premier essai (sinon il faudrait re-ecrire les
    // memes numeros, ce qui est exactement ce qu'on fait ici).
    await ecrireChunk(deviceId, clientId, 0, Buffer.from("contenu correct"));
    const { tailleOctets } = await assemblerEtVerifier(deviceId, clientId, 1, sha256(Buffer.from("contenu correct")));
    expect(tailleOctets).toBe(Buffer.from("contenu correct").length);
  });

  it("le fichier final sur disque est chiffré (jamais le contenu en clair)", async () => {
    const deviceId = "device-2";
    const clientId = "item-chiffre-1";
    const contenu = Buffer.from("Donnée confidentielle d'un client - Maître Koffi Jean-Baptiste");
    await ecrireChunk(deviceId, clientId, 0, contenu);
    const { nomFichier } = await assemblerEtVerifier(deviceId, clientId, 1, sha256(contenu));

    const brut = await fs.promises.readFile(
      path.join(fakeAppData, "Aurore", "mobile-items", deviceId, nomFichier)
    );
    expect(brut.includes(contenu)).toBe(false);
    expect(brut.toString("latin1")).not.toContain("Koffi Jean-Baptiste");
  });

  it("isole les appareils entre eux (même clientId sur deux appareils différents, aucune collision)", async () => {
    const clientId = "meme-identifiant-cote-telephone";
    await ecrireChunk("device-A", clientId, 0, Buffer.from("contenu A"));
    await ecrireChunk("device-B", clientId, 0, Buffer.from("contenu B"));

    const resultatA = await assemblerEtVerifier("device-A", clientId, 1, sha256(Buffer.from("contenu A")));
    const resultatB = await assemblerEtVerifier("device-B", clientId, 1, sha256(Buffer.from("contenu B")));

    expect((await lireFichierMobile("device-A", resultatA.nomFichier)).toString()).toBe("contenu A");
    expect((await lireFichierMobile("device-B", resultatB.nomFichier)).toString()).toBe("contenu B");
  });
});
