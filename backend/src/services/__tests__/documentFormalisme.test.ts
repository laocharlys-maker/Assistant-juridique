import { describe, it, expect } from "vitest";
import { buildFormalisme, FormalismeContext } from "../documentFormalisme";

const CTX: FormalismeContext = {
  nomClient: "Marcelline Kodjo",
  nomAffaire: "Restitution de fonds de tontine",
  numeroDossier: "DOS-001",
  dateLongue: "lundi 3 août 2026",
  ville: "Cotonou",
};

const CHAMPS_MISE_EN_DEMEURE = {
  nom_cabinet: "Cabinet Test",
  adresse_cabinet: "30 rue de la Bétonière, Fidjrossè, Cotonou",
  destinataire: "MAL",
  civilite_appel_destinataire: "Monsieur",
  objet_mise_en_demeure: "Restituer les fonds de tontine",
  nom_avocat: "Sam",
};

const CHAMPS_NOTIFICATION = {
  nom_cabinet: "Cabinet Test AzoMedIA",
  adresse_cabinet: "30 rue de la Bétonière, Fidjrossè, Cotonou",
  destinataire: "MAL",
  objet: "Notification de date d'audience",
  nom_avocat: "Sam",
};

// La redaction libre (Lot 11 Partie B) n'appelle jamais l'IA : les phrases
// de liaison narratives ("J'agis en qualité de conseil de...", "Veuillez
// agréer... salutations distinguées") normalement ecrites par l'IA pour
// introduire/conclure son texte n'ont pas de sens ici - seules les donnees
// de base et les formules de mise en page fixes doivent rester generees
// (voir la demande explicite de l'utilisateur, captures Notification/Mise
// en demeure).
describe("buildFormalisme - redaction libre (mise_en_demeure)", () => {
  it("mode IA (par defaut) : conserve les phrases de liaison narratives", () => {
    const formalisme = buildFormalisme("mise_en_demeure", CHAMPS_MISE_EN_DEMEURE, CTX);
    expect(formalisme!.avant).toContain("J'agis par la présente en qualité de conseil de");
    expect(formalisme!.apres).toContain("Sous toutes réserves dont mon client entend se prévaloir en justice.");
    expect(formalisme!.apres).toContain("Veuillez agréer");
  });

  it("mode rédaction libre : retire les phrases de liaison narratives, garde l'identité et la signature", () => {
    const formalisme = buildFormalisme("mise_en_demeure", CHAMPS_MISE_EN_DEMEURE, CTX, true);
    expect(formalisme!.avant).not.toContain("J'agis par la présente en qualité de conseil de");
    expect(formalisme!.apres).not.toContain("Sous toutes réserves dont mon client entend se prévaloir en justice.");
    expect(formalisme!.apres).not.toContain("Veuillez agréer");

    // Donnees de base et formules standard toujours presentes.
    expect(formalisme!.avant).toContain("Cabinet Test");
    expect(formalisme!.avant).toContain("À l'attention de");
    expect(formalisme!.avant).toContain("OBJET : Restituer les fonds de tontine");
    expect(formalisme!.avant).toContain("Monsieur");
    expect(formalisme!.apres).toContain("Maître Sam");
    expect(formalisme!.apres).toContain("Avocat au Barreau du Bénin");
  });
});

describe("buildFormalisme - redaction libre (notification_date)", () => {
  it("mode IA (par defaut) : conserve les phrases de liaison narratives", () => {
    const formalisme = buildFormalisme("notification_date", CHAMPS_NOTIFICATION, CTX);
    expect(formalisme!.avant).toContain("J'agis en qualité de conseil de");
    expect(formalisme!.apres).toContain("Nous vous remercions de l'attention que vous porterez à cette notification.");
    expect(formalisme!.apres).toContain("Veuillez agréer");
  });

  it("mode rédaction libre : retire les phrases de liaison narratives, garde l'identité et la signature", () => {
    const formalisme = buildFormalisme("notification_date", CHAMPS_NOTIFICATION, CTX, true);
    expect(formalisme!.avant).not.toContain("J'agis en qualité de conseil de");
    expect(formalisme!.apres).not.toContain("Nous vous remercions de l'attention que vous porterez à cette notification.");
    expect(formalisme!.apres).not.toContain("Veuillez agréer");

    expect(formalisme!.avant).toContain("Cabinet Test AzoMedIA");
    expect(formalisme!.avant).toContain("À l'attention de");
    expect(formalisme!.avant).toContain("OBJET : Notification de date d'audience");
    expect(formalisme!.apres).toContain("Maître Sam");
    expect(formalisme!.apres).toContain("Avocat au Barreau du Bénin");
    expect(formalisme!.apres).toContain("(Sceau du Cabinet)");
  });
});
