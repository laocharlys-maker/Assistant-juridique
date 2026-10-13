import cron from "node-cron";
import { prisma } from "../lib/prisma";
import { sendEmail } from "../services/mailer";
import { resolveCabinetEmailIdentite } from "../services/cabinetContact";
import { creerNotification } from "../services/notifications";

/**
 * Module RH Cabinet, RH-2 - rappels de fin de stage au responsable (cloche
 * + email), aux echeances J-30/J-15/J-7/J-0, puis une alerte repetee tant
 * que le stage n'est pas cloture (voir docs/rh/, decision du 13/10/2026 :
 * UN ENREGISTREMENT PAR ECHEANCE dans StageRappelEnvoye, pas un horodatage
 * unique - chaque palier est verifie et marque independamment).
 *
 * Idempotence : une echeance deja marquee (StageRappelEnvoye) n'est plus
 * jamais renvoyee, meme si l'app redemarre plusieurs fois le meme jour.
 * Rattrapage : si l'app etait fermee au moment theorique d'une echeance,
 * le prochain demarrage (ou le prochain passage du cron quotidien) la
 * detecte toujours comme "en retard sur le seuil" et l'envoie une seule
 * fois - jamais silencieusement perdue, jamais dupliquee.
 */

const PALIERS: { cle: string; joursAvant: number }[] = [
  { cle: "j30", joursAvant: 30 },
  { cle: "j15", joursAvant: 15 },
  { cle: "j7", joursAvant: 7 },
  { cle: "j0", joursAvant: 0 },
];

function joursRestants(dateFinPrevue: Date, maintenant: Date): number {
  const msParJour = 24 * 60 * 60 * 1000;
  return Math.ceil((dateFinPrevue.getTime() - maintenant.getTime()) / msParJour);
}

async function envoyerRappel(
  stage: {
    id: string;
    cabinetId: string;
    dateFinPrevue: Date;
    fichePersonnel: { nom: string; prenoms: string | null };
    responsable: { id: string; nom: string; email: string };
  },
  palier: string,
  titre: string,
  message: string
): Promise<void> {
  try {
    await prisma.stageRappelEnvoye.create({ data: { stageId: stage.id, palier } });
  } catch {
    // Contrainte unique (stageId, palier) deja prise par un run concurrent
    // ou precedent - jamais de double envoi, on s'arrete la pour ce palier.
    return;
  }

  await creerNotification({
    cabinetId: stage.cabinetId,
    destinataireId: stage.responsable.id,
    type: "stage_echeance",
    titre,
    message,
    lienUrl: `/personnel-fiche.html?id=${stage.id}`,
  });

  const { cabinetNom, replyToEmail } = await resolveCabinetEmailIdentite(stage.cabinetId);
  const mailResult = await sendEmail({
    destinataireEmail: stage.responsable.email,
    cabinetNom,
    replyToEmail,
    subject: `${cabinetNom} - ${titre}`,
    text: `${message}\n\nConnecte-toi à Aurore pour consulter la fiche.`,
  });
  if (!mailResult.ok) {
    console.error(`[stage-rappels] échec de l'envoi de l'email à ${stage.responsable.email} :`, mailResult.error);
  }
}

export async function runRappelsStage(): Promise<void> {
  const maintenant = new Date();
  const stagesActifs = await prisma.stage.findMany({
    where: { statut: "en_cours" },
    select: {
      id: true,
      cabinetId: true,
      dateFinPrevue: true,
      fichePersonnel: { select: { nom: true, prenoms: true } },
      responsable: { select: { id: true, nom: true, email: true } },
      rappelsEnvoyes: { select: { palier: true } },
    },
  });

  for (const stage of stagesActifs) {
    const dejaEnvoyes = new Set(stage.rappelsEnvoyes.map((r) => r.palier));
    const nomComplet = `${stage.fichePersonnel.nom}${stage.fichePersonnel.prenoms ? " " + stage.fichePersonnel.prenoms : ""}`;
    const reste = joursRestants(stage.dateFinPrevue, maintenant);

    for (const { cle, joursAvant } of PALIERS) {
      if (dejaEnvoyes.has(cle)) continue;
      if (reste > joursAvant) continue;

      const titre =
        joursAvant === 0
          ? `Stage de ${nomComplet} : échéance aujourd'hui`
          : `Stage de ${nomComplet} : échéance dans ${joursAvant} jour${joursAvant > 1 ? "s" : ""}`;
      const message = `Le stage se termine le ${stage.dateFinPrevue.toLocaleDateString("fr-FR")}.`;
      await envoyerRappel(stage, cle, titre, message);
    }

    // Alerte repetee (une fois par jour calendaire) tant que l'echeance est
    // depassee et le stage pas encore cloture - cle de palier datee, donc
    // naturellement un nouvel enregistrement chaque jour sans jamais
    // redoubler le meme jour.
    if (reste < 0) {
      const cleJour = `en_retard_${maintenant.toISOString().slice(0, 10)}`;
      if (!dejaEnvoyes.has(cleJour)) {
        await envoyerRappel(
          stage,
          cleJour,
          `Stage de ${nomComplet} : terminé et non clôturé`,
          `Le stage de ${nomComplet} est arrivé à échéance le ${stage.dateFinPrevue.toLocaleDateString("fr-FR")} et n'a pas encore été clôturé.`
        );
      }
    }
  }
}

export function scheduleRappelsStage(): void {
  cron.schedule(
    "0 7 * * *",
    () => {
      runRappelsStage().catch((error) => {
        console.error("Erreur lors de l'exécution des rappels de fin de stage :", error);
      });
    },
    { timezone: "Africa/Porto-Novo" }
  );
  console.log("[rh-stages] rappels de fin de stage planifiés chaque jour à 7h (J-30/J-15/J-7/J-0 + alerte si non clôturé).");
}
