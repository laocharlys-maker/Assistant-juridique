import { prisma } from "../lib/prisma";
import { callN8nWebhook } from "./n8n";
import { buildRoleSemaineRecapEmailHtml } from "./roleSemaineRecapEmail";
import { formatDateLongue } from "../utils/dateFormat";
import { resolveCabinetEmailIdentite } from "./cabinetContact";

// Lundi de la semaine contenant la date donnee (UTC). Duplique volontairement
// de roleAudiences.ts pour ne pas faire dependre un service planifie d'un
// fichier de routes.
function lundiDeLaSemaine(date: Date): Date {
  const d = new Date(Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate()));
  const jour = d.getUTCDay();
  const decalage = jour === 0 ? -6 : 1 - jour;
  d.setUTCDate(d.getUTCDate() + decalage);
  return d;
}

// Recapitulatif hebdomadaire du role : le greffe communique en general le
// role environ 10 jours avant la semaine concernee, donc chaque vendredi on
// envoie par mail les audiences deja saisies pour la semaine qui commence
// 10 jours plus tard - ce qui laisse au cabinet la semaine intermediaire
// pour se preparer.
export async function runRoleSemaineRecapPourCabinet(cabinetId: string): Promise<void> {
  const dansDixJours = new Date(Date.now() + 10 * 24 * 60 * 60 * 1000);
  const debut = lundiDeLaSemaine(dansDixJours);
  const fin = new Date(debut);
  fin.setUTCDate(fin.getUTCDate() + 7);

  const audiences = await prisma.roleAudience.findMany({
    where: { cabinetId, dateAudience: { gte: debut, lt: fin } },
    include: { dossier: { select: { numeroDossier: true, nomAffaire: true } } },
    orderBy: { dateAudience: "asc" },
  });

  // Rien saisi pour cette semaine-la : pas de mail (evite un envoi vide
  // chaque vendredi meme quand le role n'a pas encore ete depouille).
  if (audiences.length === 0) return;

  const cabinet = await prisma.cabinet.findUnique({ where: { id: cabinetId } });
  if (!cabinet || !cabinet.actif) return;

  const destinataires = await prisma.user.findMany({
    where: { cabinetId, role: { in: ["titulaire", "avocat"] } },
  });

  const vendredi = new Date(debut);
  vendredi.setUTCDate(vendredi.getUTCDate() + 4);
  const periode = `${formatDateLongue(debut, "UTC")} au ${formatDateLongue(vendredi, "UTC")}`;

  const { replyToEmail } = await resolveCabinetEmailIdentite(cabinetId);

  for (const destinataire of destinataires) {
    const contenuHtml = buildRoleSemaineRecapEmailHtml({
      cabinetNom: cabinet.nom,
      periode,
      destinataireNom: destinataire.nom,
      audiences,
    });
    await callN8nWebhook("role-semaine-recap", {
      cabinetNom: cabinet.nom,
      periode,
      contenuHtml,
      destinataireEmail: destinataire.email,
      destinataireNom: destinataire.nom,
      replyToEmail,
    });
  }
}

export async function runRoleSemaineRecapPourTousLesCabinets(): Promise<void> {
  const cabinets = await prisma.cabinet.findMany();
  for (const cabinet of cabinets) {
    try {
      await runRoleSemaineRecapPourCabinet(cabinet.id);
    } catch (error) {
      console.error(`Erreur recapitulatif du role de la semaine pour le cabinet ${cabinet.id} :`, error);
    }
  }
}
