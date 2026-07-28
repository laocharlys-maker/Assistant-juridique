import { prisma } from "../lib/prisma";
import { LlmProvider } from "./llm/types";
import { searchWeb, formatWebSearchContext } from "./tavily";
import { callN8nWebhook } from "./n8n";
import { logAuditStep } from "./audit";
import { splitSujets, periodeLabel } from "./veilleJuridiqueUtils";
import { buildVeilleEmailHtml } from "./veilleJuridiqueEmail";
import {
  VEILLE_JURIDIQUE_SYSTEM_PROMPT,
  buildVeilleJuridiqueUserPrompt,
} from "../prompts/webRedaction";

export { splitSujets, periodeLabel };

export async function runVeilleForCabinet(cabinetId: string, llm: LlmProvider): Promise<void> {
  const cabinet = await prisma.cabinet.findUnique({ where: { id: cabinetId } });
  if (!cabinet || !cabinet.actif || !cabinet.veilleActive || !cabinet.veilleSujets?.trim()) return;
  // Module desactive par la plateforme (formule ne l'incluant pas) : prime
  // sur l'activation propre au cabinet.
  if (cabinet.modulesDesactives.includes("veille_juridique")) return;

  const themes = splitSujets(cabinet.veilleSujets);
  if (themes.length === 0) return;

  const titulaire = await prisma.user.findFirst({ where: { cabinetId, role: "titulaire" } });
  if (!titulaire) return;

  const periode = periodeLabel();
  const themeResultats = [];
  for (const theme of themes) {
    const resultats = await searchWeb(`actualite juridique ${theme} Benin cette semaine`, 5, undefined, "week");
    themeResultats.push({ theme, resultatsRecherche: formatWebSearchContext(resultats) });
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
    const n8nResult = await callN8nWebhook("veille-juridique", {
      actionId: action.id,
      dossierId: dossier.id,
      cabinetNom: cabinet.nom,
      periode,
      contenu: digest,
      contenuHtml,
      destinataireEmail: destinataire.email,
      destinataireNom: destinataire.nom,
      replyToEmail,
    });
    await logAuditStep(
      action.id,
      "envoi_email",
      n8nResult.ok ? "succes" : "erreur",
      n8nResult.ok ? destinataire.email : n8nResult.error
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
