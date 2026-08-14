import { describe, it, expect, beforeAll, afterAll } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

describe("stockageDocuments", () => {
  let fakeAppData: string;
  let enregistrerFichier: typeof import("../stockageDocuments").enregistrerFichier;
  let lireFichier: typeof import("../stockageDocuments").lireFichier;
  let supprimerFichier: typeof import("../stockageDocuments").supprimerFichier;
  let existeFichier: typeof import("../stockageDocuments").existeFichier;
  let _lireFichierBrutPourTests: typeof import("../stockageDocuments")._lireFichierBrutPourTests;

  beforeAll(async () => {
    // Isole entierement ce test du vrai profil utilisateur (meme
    // raisonnement que les suites e2e du projet) - une cle de chiffrement
    // dediee est generee dans ce dossier temporaire, jamais dans le vrai
    // %APPDATA%/Aurore.
    fakeAppData = fs.mkdtempSync(path.join(os.tmpdir(), "aurore-test-stockage-documents-"));
    process.env.APPDATA = fakeAppData;
    ({ enregistrerFichier, lireFichier, supprimerFichier, existeFichier, _lireFichierBrutPourTests } = await import(
      "../stockageDocuments"
    ));
  });

  afterAll(() => {
    fs.rmSync(fakeAppData, { recursive: true, force: true });
  });

  it("chiffre le contenu avant écriture : le fichier sur disque ne contient jamais le texte en clair", async () => {
    const dossierId = "dossier-test-1";
    const contenuOriginal = Buffer.from("Contenu confidentiel du client Jean Kokou Dupont-N'Da", "utf8");

    const { nomFichier, tailleOctets } = await enregistrerFichier(dossierId, contenuOriginal);
    expect(tailleOctets).toBe(contenuOriginal.length);

    const brut = _lireFichierBrutPourTests(dossierId, nomFichier);
    expect(brut.includes(contenuOriginal)).toBe(false);
    expect(brut.toString("latin1")).not.toContain("Jean Kokou");
    // Chiffre = IV (12) + AuthTag (16) + ciphertext (taille identique au clair) ; jamais 0 octet.
    expect(brut.length).toBeGreaterThan(contenuOriginal.length);
  });

  it("le nom de fichier sur disque n'est jamais prévisible ni dérivé du contenu (UUID)", async () => {
    const dossierId = "dossier-test-1";
    const { nomFichier } = await enregistrerFichier(dossierId, Buffer.from("test"));
    expect(nomFichier).toMatch(/^[0-9a-f-]{36}\.enc$/);
  });

  it("déchiffre correctement : le contenu relu est bit-à-bit identique à l'original", async () => {
    const dossierId = "dossier-test-2";
    const contenuOriginal = Buffer.from([0x25, 0x50, 0x44, 0x46, 0x00, 0xff, 0x10, 0x20]); // octets binaires arbitraires (simule un PDF)

    const { nomFichier } = await enregistrerFichier(dossierId, contenuOriginal);
    const relu = await lireFichier(dossierId, nomFichier);

    expect(relu.equals(contenuOriginal)).toBe(true);
  });

  it("supprime le fichier physique, et reste tolérant si déjà absent", async () => {
    const dossierId = "dossier-test-3";
    const { nomFichier } = await enregistrerFichier(dossierId, Buffer.from("à supprimer"));

    await supprimerFichier(dossierId, nomFichier);
    await expect(lireFichier(dossierId, nomFichier)).rejects.toThrow();

    // Deuxieme suppression (fichier deja absent) - ne doit jamais lever.
    await expect(supprimerFichier(dossierId, nomFichier)).resolves.toBeUndefined();
  });

  it("existeFichier : reflète l'écriture et la suppression sans lire/déchiffrer le contenu", async () => {
    const dossierId = "dossier-test-existe";
    await expect(existeFichier(dossierId, "jamais-ecrit.enc")).resolves.toBe(false);

    const { nomFichier } = await enregistrerFichier(dossierId, Buffer.from("présent"));
    await expect(existeFichier(dossierId, nomFichier)).resolves.toBe(true);

    await supprimerFichier(dossierId, nomFichier);
    await expect(existeFichier(dossierId, nomFichier)).resolves.toBe(false);
  });

  it("isole les fichiers par dossier (deux dossiers différents, aucune collision)", async () => {
    const { nomFichier: nomA } = await enregistrerFichier("dossier-a", Buffer.from("contenu A"));
    const { nomFichier: nomB } = await enregistrerFichier("dossier-b", Buffer.from("contenu B"));

    const relu_A = await lireFichier("dossier-a", nomA);
    const relu_B = await lireFichier("dossier-b", nomB);
    expect(relu_A.toString()).toBe("contenu A");
    expect(relu_B.toString()).toBe("contenu B");
  });
});
