import { prisma } from "../lib/prisma";
import { LlmProvider } from "./llm/types";
import { searchWeb } from "./tavily";
import { sendEmail } from "./mailer";
import { logAuditStep } from "./audit";
import { splitSujets, periodeLabel, filtrerResultatsRecents, formatSourcesVeillePourPrompt } from "./veilleJuridiqueUtils";
import { buildVeilleEmailHtml } from "./veilleJuridiqueEmail";
import {
  VEILLE_JURIDIQUE_SYSTEM_PROMPT,
  buildVeilleJuridiqueUserPrompt,
} from "../prompts/webRedaction";

export { splitSujets, periodeLabel };

// Nombre de jours en arriere couverts par la veille - transmis a la fois a
// Tavily (days, avec topic "news") et au filtrage programmatique cote
// serveur (jamais uniquement l'un ou l'autre : Tavily peut renvoyer un
// resultat sans date exploitable, filtre localement en plus).
const JOURS_COUVERTS = 7;

export async function runVeilleForCabinet(cabinetId: string, llm: LlmProvider, maintenant = new Date()): Promise<void> {
  const cabinet = await prisma.cabinet.findUnique({ where: { id: cabinetId } });
  if (!cabinet || !cabinet.actif || !cabinet.veilleActive || !cabinet.veilleSujets?.trim()) return;
  // Module desactive par la plateforme (formule ne l'incluant pas) : prime
  // sur l'activation propre au cabinet.
  if (cabinet.modulesDesactives.includes("veille_juridique")) return;

  const themes = splitSujets(cabinet.veilleSujets);
  if (themes.length === 0) return;

  const titulaire = await prisma.user.findFirst({ where: { cabinetId, role: "titulaire" } });
  if (!titulaire) return;

  const periode = periodeLabel(maintenant);
  const themeResultats = [];
  for (const theme of themes) {
    // topic "news" + days (plutot que time_range sur le topic "general"
    // implicite) : bien plus susceptible de renvoyer une date de
    // publication exploitable par theme - voir services/tavily.ts.
    const resultatsBruts = await searchWeb(`actualite juridique ${theme} Benin`, 8, undefined, undefined, {
      topic: "news",
      days: JOURS_COUVERTS,
    });
    // Filtrage programmatique en plus du parametre Tavily : un resultat
    // sans published_date exploitable, ou hors des JOURS_COUVERTS derniers
    // jours, n'atteint jamais le prompt - jamais laisse au LLM le soin de
    // deviner la fraicheur depuis le texte brut. Applique INDEPENDAMMENT
    // par theme (jamais mele aux autres themes).
    const { retenus, recus, apresFiltrage } = filtrerResultatsRecents(resultatsBruts, maintenant, JOURS_COUVERTS);
    // Jamais de donnee client sensible : uniquement le cabinet (id opaque),
    // le theme suivi (deja connu du cabinet lui-meme) et des comptes - pour
    // detecter un theme qui ne remonte quasiment jamais de resultats
    // recents (formulation ou theme a ajuster cote cabinet).
    console.log(
      `[veille-juridique] cabinet=${cabinetId} theme="${theme}" reçus=${recus} retenus=${apresFiltrage}`
    );
    themeResultats.push({ theme, resultatsRecherche: formatSourcesVeillePourPrompt(retenus) });
  }

  const digest = await llm.redact(
    VEILLE_JURIDIQUE_SYSTEM_PROMPT,
    buildVeilleJuridiqueUserPrompt({ periode, themes: themeResultats })
  );

  const dossier = await prisma.dossier.create({
    data: {
      cabinetId,
      numeroDossier: `VEILLE-${Date.now()}`,
      nomAffaire: `Veille juridique - ${periode}`,
      nomClient: "Non applicable",
      createdBy: titulaire.id,
      estRecherche: true,
    },
  });

  const action = await prisma.action.create({
    data: {
      dossierId: dossier.id,
      typeAction: "veille_juridique",
      canal: "web",
      contenuGenere: digest,
      createdBy: titulaire.id,
    },
  });

  await logAuditStep(action.id, "redaction_ia", "succes", "Veille juridique");

  const destinataires = await prisma.user.findMany({
    where: { cabinetId, role: { in: ["titulaire", "avocat"] }, recoitVeille: true },
  });

  const replyToEmail = cabinet.emailContact ?? titulaire.email;

  for (const destinataire of destinataires) {
    const contenuHtml = buildVeilleEmailHtml({
      cabinetNom: cabinet.nom,
      periode,
      destinataireNom: destinataire.nom,
      digestMarkdown: digest,
    });
    const mailResult = await sendEmail({
      destinataireEmail: destinataire.email,
      cabinetNom: cabinet.nom,
      replyToEmail,
      subject: `Veille juridique - ${cabinet.nom} - ${periode}`,
      html: contenuHtml,
    });
    await logAuditStep(
      action.id,
      "envoi_email",
      mailResult.ok ? "succes" : "erreur",
      mailResult.ok ? destinataire.email : mailResult.error
    );
  }
}

export async function runVeillePourTousLesCabinets(llm: LlmProvider): Promise<void> {
  const cabinets = await prisma.cabinet.findMany({ where: { veilleActive: true } });
  for (const cabinet of cabinets) {
    try {
      await runVeilleForCabinet(cabinet.id, llm);
    } catch (error) {
      console.error(`Erreur veille juridique pour le cabinet ${cabinet.id} :`, error);
    }
  }
}
