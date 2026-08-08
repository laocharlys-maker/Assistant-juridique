import { describe, expect, it } from "vitest";
import { suggererDossiersPourExpediteur } from "../suggestionDossier";

const dossierA = { id: "dossier-a", numeroDossier: "DOS-001", nomAffaire: "Affaire A" };
const dossierB = { id: "dossier-b", numeroDossier: "DOS-002", nomAffaire: "Affaire B" };

describe("suggestionDossier (Lot 16)", () => {
  it("suggère les dossiers d'un client dont l'email correspond EXACTEMENT", () => {
    const clients = [{ nom: "Koffi Jean", email: "koffi.jean@exemple.test", dossiers: [dossierA, dossierB] }];
    const res = suggererDossiersPourExpediteur(clients, "koffi.jean@exemple.test");
    expect(res).toHaveLength(2);
    expect(res.map((d) => d.id).sort()).toEqual(["dossier-a", "dossier-b"]);
    expect(res[0].clientNom).toBe("Koffi Jean");
  });

  it("normalise la casse et les espaces avant comparaison", () => {
    const clients = [{ nom: "Koffi Jean", email: "  Koffi.Jean@Exemple.TEST  ", dossiers: [dossierA] }];
    const res = suggererDossiersPourExpediteur(clients, "koffi.jean@exemple.test");
    expect(res).toHaveLength(1);
  });

  it("ne suggère RIEN pour un expéditeur inconnu (aucune correspondance approximative)", () => {
    const clients = [{ nom: "Koffi Jean", email: "koffi.jean@exemple.test", dossiers: [dossierA] }];
    const res = suggererDossiersPourExpediteur(clients, "quelquun.dautre@exemple.test");
    expect(res).toEqual([]);
  });

  it("ne suggère rien pour un email proche mais pas identique (pas d'approximation)", () => {
    const clients = [{ nom: "Koffi Jean", email: "koffi.jean@exemple.test", dossiers: [dossierA] }];
    // Meme nom de domaine, adresse locale differente - ne doit JAMAIS suggerer.
    const res = suggererDossiersPourExpediteur(clients, "koffi.jean2@exemple.test");
    expect(res).toEqual([]);
  });

  it("ignore les clients sans email renseigné", () => {
    const clients = [{ nom: "Client Sans Email", email: null, dossiers: [dossierA] }];
    const res = suggererDossiersPourExpediteur(clients, "koffi.jean@exemple.test");
    expect(res).toEqual([]);
  });

  it("renvoie [] si l'expéditeur est vide", () => {
    const clients = [{ nom: "Koffi Jean", email: "koffi.jean@exemple.test", dossiers: [dossierA] }];
    expect(suggererDossiersPourExpediteur(clients, "")).toEqual([]);
  });

  it("dédoublonne un dossier partagé par deux fiches Client ayant le même email", () => {
    const clients = [
      { nom: "Koffi Jean (fiche 1)", email: "koffi.jean@exemple.test", dossiers: [dossierA] },
      { nom: "Koffi Jean (fiche 2)", email: "koffi.jean@exemple.test", dossiers: [dossierA, dossierB] },
    ];
    const res = suggererDossiersPourExpediteur(clients, "koffi.jean@exemple.test");
    expect(res.map((d) => d.id).sort()).toEqual(["dossier-a", "dossier-b"]);
  });

  it("un client sans dossier ne produit aucune suggestion", () => {
    const clients = [{ nom: "Koffi Jean", email: "koffi.jean@exemple.test", dossiers: [] }];
    const res = suggererDossiersPourExpediteur(clients, "koffi.jean@exemple.test");
    expect(res).toEqual([]);
  });
});
