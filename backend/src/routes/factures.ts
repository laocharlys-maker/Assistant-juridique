import { Router } from "express";
import { z } from "zod";
import { prisma } from "../lib/prisma";
import { requireAuth } from "../middleware/requireAuth";
import { requireAvocat, requireModule } from "../middleware/roles";
import { buildFacturePdf } from "../services/facturePdf";
import { resolveEntete } from "./documentExport";
import { sendEmail } from "../services/mailer";
import { resolveCabinetEmailIdentite } from "../services/cabinetContact";
import { calculerMontant, formatDuree } from "../services/feuillesTemps";
import { stockerFactureNormalisee, lireFactureNormalisee, supprimerFactureNormalisee } from "../services/factureNormaliseePdf";

export const facturesRouter = Router();

// Module payant : peut etre desactive par la plateforme pour un cabinet
// dont la formule ne l'inclut pas. Chemin explicite obligatoire : sans lui,
// ce middleware s'appliquerait a TOUTES les requetes de l'app (ce routeur
// est monte sans prefixe sur app), pas seulement a /api/factures*.
facturesRouter.use("/api/factures", requireAuth, requireModule("facturation"));

// Prefixe distinct pour les proforma - series de numerotation independantes,
// pour qu'une proforma ne "consomme" jamais un numero de facture definitive.
async function genererNumero(cabinetId: string, estProforma: boolean): Promise<string> {
  const prefixe = estProforma ? "PROF" : "FACT";
  const annee = new Date().getFullYear();
  const count = await prisma.facture.count({
    where: { cabinetId, numero: { startsWith: `${prefixe}-${annee}-` } },
  });
  return `${prefixe}-${annee}-${String(count + 1).padStart(4, "0")}`;
}

const createFactureSchema = z.object({
  clientNom: z.string().min(1),
  dossierId: z.string().uuid().optional(),
  description: z.string().min(1),
  montant: z.number().int().positive(),
  appliquerTva: z.boolean().optional().default(false),
  estProforma: z.boolean().optional().default(false),
  dateEcheance: z.string().optional(),
});

facturesRouter.post("/api/factures", requireAuth, requireAvocat, async (req, res) => {
  const parsed = createFactureSchema.safeParse(req.body);
  if (!parsed.success) {
    return res.status(400).json({ error: "Formulaire invalide", details: parsed.error.issues });
  }

  let dossier = null;
  if (parsed.data.dossierId) {
    dossier = await prisma.dossier.findFirst({
      where: { id: parsed.data.dossierId, cabinetId: req.auth!.cabinetId },
    });
    if (!dossier) {
      return res.status(404).json({ error: "Dossier introuvable" });
    }
  }

  const numero = await genererNumero(req.auth!.cabinetId, parsed.data.estProforma);

  const facture = await prisma.facture.create({
    data: {
      cabinetId: req.auth!.cabinetId,
      dossierId: dossier?.id,
      clientNom: parsed.data.clientNom,
      numero,
      description: parsed.data.description,
      montant: parsed.data.montant,
      appliquerTva: parsed.data.appliquerTva,
      estProforma: parsed.data.estProforma,
      dateEcheance: parsed.data.dateEcheance ? new Date(parsed.data.dateEcheance) : undefined,
      createdBy: req.auth!.userId,
    },
    include: {
      dossier: { select: { numeroDossier: true, nomAffaire: true, nomClient: true } },
      creePar: { select: { nom: true } },
    },
  });

  return res.status(201).json(facture);
});

const depuisTempsSchema = z.object({
  dossierId: z.string().uuid(),
  estProforma: z.boolean().optional().default(false),
});

// Lot 14 - "Facturer ce dossier" depuis le temps passe : pre-remplit une
// facture a partir des SaisieTemps non encore facturees du dossier (tout
// temps enregistre est facturable), montant calcule saisie par saisie
// (chacune garde son propre taux horaire snapshotte - voir calculerMontant,
// services/feuillesTemps.ts).
// Insertion ciblee : aucune autre route de ce fichier n'est modifiee.
facturesRouter.post("/api/factures/depuis-temps", requireAuth, requireAvocat, async (req, res) => {
  const parsed = depuisTempsSchema.safeParse(req.body);
  if (!parsed.success) {
    return res.status(400).json({ error: "Formulaire invalide", details: parsed.error.issues });
  }

  const dossier = await prisma.dossier.findFirst({
    where: { id: parsed.data.dossierId, cabinetId: req.auth!.cabinetId },
  });
  if (!dossier) {
    return res.status(404).json({ error: "Dossier introuvable" });
  }

  // Toute saisie de temps est facturable (aucune exception) - seules les
  // saisies terminees (dureeMinutes renseignee - un chronometre encore
  // actif n'est jamais inclus) et pas deja rattachees a une facture
  // (factureId null - evite tout double comptage) sont proposees ici.
  const saisies = await prisma.saisieTemps.findMany({
    where: {
      dossierId: dossier.id,
      dureeMinutes: { not: null },
      factureId: null,
    },
    include: { user: { select: { nom: true } } },
    orderBy: { date: "asc" },
  });

  if (saisies.length === 0) {
    return res.status(400).json({
      error: "Aucune saisie de temps non encore facturée pour ce dossier.",
    });
  }

  const parUtilisateur = new Map<string, { nom: string; dureeMinutes: number; montant: number }>();
  let montantTotal = 0;
  for (const s of saisies) {
    const montant = calculerMontant(s.dureeMinutes!, s.tauxHoraireApplique);
    montantTotal += montant;
    const cle = s.userId;
    if (!parUtilisateur.has(cle)) {
      parUtilisateur.set(cle, { nom: s.user.nom, dureeMinutes: 0, montant: 0 });
    }
    const ligne = parUtilisateur.get(cle)!;
    ligne.dureeMinutes += s.dureeMinutes!;
    ligne.montant += montant;
  }

  const lignesDescription = [...parUtilisateur.values()]
    .sort((a, b) => a.nom.localeCompare(b.nom, "fr"))
    .map((l) => `- ${l.nom} : ${formatDuree(l.dureeMinutes)} (${l.montant.toLocaleString("fr-FR")} F CFA)`);
  const description = `Temps passé sur le dossier ${dossier.numeroDossier} — ${dossier.nomAffaire} :\n${lignesDescription.join("\n")}`;

  const numero = await genererNumero(req.auth!.cabinetId, parsed.data.estProforma);

  const facture = await prisma.$transaction(async (tx) => {
    const nouvelleFacture = await tx.facture.create({
      data: {
        cabinetId: req.auth!.cabinetId,
        dossierId: dossier.id,
        clientNom: dossier.nomClient,
        numero,
        description,
        montant: montantTotal,
        estProforma: parsed.data.estProforma,
        createdBy: req.auth!.userId,
      },
      include: {
        dossier: { select: { numeroDossier: true, nomAffaire: true, nomClient: true } },
        creePar: { select: { nom: true } },
      },
    });

    // Rattache immediatement les saisies incluses - des cet instant, elles
    // n'apparaissent plus comme disponibles pour une facturation ulterieure
    // (contrainte explicite du prompt, verifiee par test).
    await tx.saisieTemps.updateMany({
      where: { id: { in: saisies.map((s) => s.id) } },
      data: { factureId: nouvelleFacture.id },
    });

    return nouvelleFacture;
  });

  return res.status(201).json({ ...facture, saisiesIncluses: saisies.length });
});

facturesRouter.get("/api/factures", requireAuth, requireAvocat, async (req, res) => {
  const dossierId = typeof req.query.dossierId === "string" ? req.query.dossierId : undefined;

  const factures = await prisma.facture.findMany({
    where: {
      cabinetId: req.auth!.cabinetId,
      ...(dossierId ? { dossierId } : {}),
    },
    include: {
      dossier: { select: { numeroDossier: true, nomAffaire: true, nomClient: true, client: true } },
      creePar: { select: { nom: true } },
    },
    orderBy: { createdAt: "desc" },
  });

  // Les factures non encore payees ("brouillon"/"envoyee") remontent toujours
  // au-dessus de celles deja payees - Array.prototype.sort est stable (Node),
  // donc l'ordre par date de creation (deja applique par Prisma ci-dessus)
  // est conserve A L'INTERIEUR de chacun des deux groupes, jamais recalcule.
  const facturesTriees = [...factures].sort(
    (a, b) => Number(a.statut === "payee") - Number(b.statut === "payee")
  );

  return res.json(facturesTriees);
});

// Suivi comptable : toute facture au statut interne "payee" apparait ICI
// automatiquement (simple filtre sur une donnee existante, jamais une
// duplication/copie) - c'est exactement ce qui permet a l'ecran
// "Factures payées" de rester a jour sans aucune action manuelle
// supplementaire au moment ou une facture est marquee payee (PATCH
// /api/factures/:id ci-dessous, inchange).
facturesRouter.get("/api/factures/payees", requireAuth, requireAvocat, async (req, res) => {
  const factures = await prisma.facture.findMany({
    where: { cabinetId: req.auth!.cabinetId, statut: "payee" },
    include: {
      dossier: { select: { numeroDossier: true, nomAffaire: true, nomClient: true } },
      creePar: { select: { nom: true } },
    },
    orderBy: { payeeAt: "desc" },
  });
  return res.json(factures);
});

// Pop-up "Factures en attente de paiement" (tableau de bord) : factures
// envoyees et non payees (hors proforma) que CET utilisateur n'a pas
// explicitement ecartees ("Ne plus me rappeler" - voir POST .../ignorer-rappel
// ci-dessous). Route distincte de GET /api/factures : /api/stats calcule
// deja le compteur affiche sur la carte du tableau de bord a partir des
// memes criteres - cette route ne sert que la liste effectivement affichee
// dans le pop-up.
facturesRouter.get("/api/factures/rappels", requireAuth, requireAvocat, async (req, res) => {
  const factures = await prisma.facture.findMany({
    where: {
      cabinetId: req.auth!.cabinetId,
      statut: "envoyee",
      estProforma: false,
      rappelsIgnores: { none: { userId: req.auth!.userId } },
    },
    select: { id: true, numero: true, clientNom: true, montant: true, dateEcheance: true },
    orderBy: { dateEcheance: "asc" },
  });
  return res.json(factures);
});

facturesRouter.post("/api/factures/:id/ignorer-rappel", requireAuth, requireAvocat, async (req, res) => {
  const facture = await prisma.facture.findFirst({
    where: { id: req.params.id, cabinetId: req.auth!.cabinetId },
  });
  if (!facture) {
    return res.status(404).json({ error: "Facture introuvable" });
  }

  await prisma.factureRappelIgnore.upsert({
    where: { factureId_userId: { factureId: facture.id, userId: req.auth!.userId } },
    create: { factureId: facture.id, userId: req.auth!.userId },
    update: {},
  });

  return res.json({ ok: true });
});

async function loadFacture(id: string, cabinetId: string) {
  return prisma.facture.findFirst({
    where: { id, cabinetId },
    include: {
      dossier: { select: { numeroDossier: true, nomAffaire: true, nomClient: true, client: true } },
      creePar: { select: { nom: true } },
    },
  });
}

const updateFactureSchema = z.object({
  statut: z.enum(["brouillon", "envoyee", "payee"]),
});

facturesRouter.patch("/api/factures/:id", requireAuth, requireAvocat, async (req, res) => {
  const parsed = updateFactureSchema.safeParse(req.body);
  if (!parsed.success) {
    return res.status(400).json({ error: "Statut invalide" });
  }

  const facture = await loadFacture(req.params.id, req.auth!.cabinetId);
  if (!facture) {
    return res.status(404).json({ error: "Facture introuvable" });
  }

  const updated = await prisma.facture.update({
    where: { id: facture.id },
    data: {
      statut: parsed.data.statut,
      payeeAt: parsed.data.statut === "payee" ? new Date() : facture.payeeAt,
    },
  });

  return res.json(updated);
});

facturesRouter.get("/api/factures/:id/pdf", requireAuth, requireAvocat, async (req, res) => {
  const facture = await loadFacture(req.params.id, req.auth!.cabinetId);
  if (!facture) {
    return res.status(404).json({ error: "Facture introuvable" });
  }

  const cabinet = await prisma.cabinet.findUnique({ where: { id: req.auth!.cabinetId } });
  // Pas de case "insérer l'en-tête" sur les factures : tentative silencieuse,
  // jamais bloquante.
  const enteteResolution = await resolveEntete(req.auth!.cabinetId, true);
  const entete = enteteResolution.ok ? enteteResolution.entete : undefined;

  const buffer = await buildFacturePdf({
    cabinetNom: cabinet?.nom ?? "",
    numero: facture.numero,
    dateEmission: facture.dateEmission,
    dateEcheance: facture.dateEcheance,
    nomClient: facture.clientNom ?? facture.dossier?.nomClient ?? "-",
    numeroDossier: facture.dossier?.numeroDossier ?? null,
    nomAffaire: facture.dossier?.nomAffaire ?? null,
    description: facture.description,
    montant: facture.montant,
    appliquerTva: facture.appliquerTva,
    estProforma: facture.estProforma,
    entete,
  });

  res.setHeader("Content-Type", "application/pdf");
  res.setHeader("Content-Disposition", `attachment; filename="${facture.numero}.pdf"`);
  return res.send(buffer);
});

const envoyerSchema = z.object({
  email: z.string().email(),
});

facturesRouter.post("/api/factures/:id/envoyer", requireAuth, requireAvocat, async (req, res) => {
  const parsed = envoyerSchema.safeParse(req.body);
  if (!parsed.success) {
    return res.status(400).json({ error: "Email invalide" });
  }

  const facture = await loadFacture(req.params.id, req.auth!.cabinetId);
  if (!facture) {
    return res.status(404).json({ error: "Facture introuvable" });
  }

  const cabinet = await prisma.cabinet.findUnique({ where: { id: req.auth!.cabinetId } });
  // Pas de case "insérer l'en-tête" sur les factures : tentative silencieuse,
  // jamais bloquante.
  const enteteResolution = await resolveEntete(req.auth!.cabinetId, true);
  const entete = enteteResolution.ok ? enteteResolution.entete : undefined;

  const buffer = await buildFacturePdf({
    cabinetNom: cabinet?.nom ?? "",
    numero: facture.numero,
    dateEmission: facture.dateEmission,
    dateEcheance: facture.dateEcheance,
    nomClient: facture.clientNom ?? facture.dossier?.nomClient ?? "-",
    numeroDossier: facture.dossier?.numeroDossier ?? null,
    nomAffaire: facture.dossier?.nomAffaire ?? null,
    description: facture.description,
    montant: facture.montant,
    appliquerTva: facture.appliquerTva,
    estProforma: facture.estProforma,
    entete,
  });

  const { cabinetNom, replyToEmail } = await resolveCabinetEmailIdentite(req.auth!.cabinetId);

  const mailResult = await sendEmail({
    destinataireEmail: parsed.data.email,
    cabinetNom,
    replyToEmail,
    subject: `Facture ${facture.numero} - ${cabinetNom}`,
    text: `Veuillez trouver ci-joint la facture n°${facture.numero} (${facture.montant.toLocaleString("fr-FR")} F CFA)${facture.description ? ` - ${facture.description}` : ""}.`,
    attachments: [{ filename: `${facture.numero}.pdf`, content: buffer, contentType: "application/pdf" }],
  });

  if (!mailResult.ok) {
    return res.status(502).json({ error: "Échec de l'envoi de la facture", detail: mailResult.error });
  }

  const updated = await prisma.facture.update({
    where: { id: facture.id },
    data: { statut: "envoyee", destinataireEmail: parsed.data.email, envoyeAt: new Date() },
  });

  return res.json(updated);
});

// --- Facture normalisee (SYGMEF) : attachee UNIQUEMENT a une facture deja
// payee (statut interne) - c'est le sens meme de l'ecran "Factures payées",
// pas une piece jointe generique de dossier. Meme transport Data URL que
// documentsDossier.ts (Lot 15), jamais multer - voir README-LOT15.md.

const DATA_URL_PATTERN = /^data:([a-zA-Z0-9.+-]+\/[a-zA-Z0-9.+-]+);base64,(.+)$/;
const TAILLE_MAX_FACTURE_NORMALISEE_OCTETS = 15 * 1024 * 1024;

const factureNormaliseeSchema = z.object({
  numero: z.string().trim().min(1).optional(),
  datePaiement: z.string().min(1),
  fichierDataUrl: z.string().min(1),
});

facturesRouter.post("/api/factures/:id/facture-normalisee", requireAuth, requireAvocat, async (req, res) => {
  const facture = await loadFacture(req.params.id, req.auth!.cabinetId);
  if (!facture) {
    return res.status(404).json({ error: "Facture introuvable" });
  }
  // Contrainte du prompt : le suivi comptable ne concerne que les factures
  // deja marquees payees en interne - attacher un PDF SYGMEF a une facture
  // encore en brouillon/envoyee n'aurait pas de sens (la page "Factures
  // payées" ne l'afficherait de toute facon jamais).
  if (facture.statut !== "payee") {
    return res.status(400).json({
      error: "Cette facture n'est pas encore marquée payée — marque-la payée avant d'y attacher la facture normalisée.",
    });
  }

  const parsed = factureNormaliseeSchema.safeParse(req.body);
  if (!parsed.success) {
    return res.status(400).json({ error: "Formulaire invalide", details: parsed.error.issues });
  }

  const datePaiement = new Date(parsed.data.datePaiement);
  if (Number.isNaN(datePaiement.getTime())) {
    return res.status(400).json({ error: "Date de paiement invalide" });
  }

  const match = parsed.data.fichierDataUrl.match(DATA_URL_PATTERN);
  if (!match) {
    return res.status(400).json({ error: "Fichier invalide (format inattendu)." });
  }
  const [, typeMime, base64Data] = match;
  if (typeMime !== "application/pdf") {
    return res.status(415).json({ error: `Type de fichier non autorisé (${typeMime}) — seul le PDF est accepté.` });
  }

  const contenu = Buffer.from(base64Data, "base64");
  if (contenu.length === 0) {
    return res.status(400).json({ error: "Fichier vide." });
  }
  if (contenu.length > TAILLE_MAX_FACTURE_NORMALISEE_OCTETS) {
    return res.status(413).json({
      error: `Fichier trop volumineux (${(contenu.length / (1024 * 1024)).toFixed(1)} Mo) — la taille maximale autorisée est de 15 Mo.`,
    });
  }

  // Remplace un eventuel PDF deja attache (correction d'une erreur) - jamais
  // d'accumulation silencieuse de fichiers orphelins sur disque.
  if (facture.factureNormaliseeNomFichier) {
    await supprimerFactureNormalisee(facture.id, facture.factureNormaliseeNomFichier).catch((error) => {
      console.error(
        `[factures] échec de suppression de l'ancien PDF normalisé (facture ${facture.id}, ignoré) :`,
        error instanceof Error ? error.message : error
      );
    });
  }

  const { nomFichier, tailleOctets } = await stockerFactureNormalisee(facture.id, contenu);

  const updated = await prisma.facture.update({
    where: { id: facture.id },
    data: {
      factureNormaliseeNumero: parsed.data.numero || null,
      factureNormaliseeDatePaiement: datePaiement,
      factureNormaliseeNomFichier: nomFichier,
      factureNormaliseeNomOriginal: `facture-normalisee-${facture.numero}.pdf`,
      factureNormaliseeTailleOctets: tailleOctets,
      factureNormaliseeAjouteeAt: new Date(),
    },
  });

  console.log(`[factures] facture normalisée attachée : ${req.auth!.userId} -> facture ${facture.id}`);

  return res.status(201).json(updated);
});

facturesRouter.get("/api/factures/:id/facture-normalisee", requireAuth, requireAvocat, async (req, res) => {
  const facture = await loadFacture(req.params.id, req.auth!.cabinetId);
  if (!facture || !facture.factureNormaliseeNomFichier) {
    return res.status(404).json({ error: "Aucune facture normalisée attachée." });
  }

  let contenu: Buffer;
  try {
    contenu = await lireFactureNormalisee(facture.id, facture.factureNormaliseeNomFichier);
  } catch (error) {
    console.error(
      `[factures] échec de lecture du PDF normalisé (facture ${facture.id}) :`,
      error instanceof Error ? error.message : error
    );
    return res.status(500).json({ error: "Impossible de lire ce fichier (voir logs serveur)." });
  }

  const inline = req.query.inline === "1";
  res.setHeader("Content-Type", "application/pdf");
  res.setHeader(
    "Content-Disposition",
    `${inline ? "inline" : "attachment"}; filename="${encodeURIComponent(facture.factureNormaliseeNomOriginal || "facture-normalisee.pdf")}"`
  );
  return res.send(contenu);
});

facturesRouter.delete("/api/factures/:id/facture-normalisee", requireAuth, requireAvocat, async (req, res) => {
  const facture = await loadFacture(req.params.id, req.auth!.cabinetId);
  if (!facture) {
    return res.status(404).json({ error: "Facture introuvable" });
  }

  if (facture.factureNormaliseeNomFichier) {
    await supprimerFactureNormalisee(facture.id, facture.factureNormaliseeNomFichier).catch((error) => {
      console.error(
        `[factures] échec de suppression du PDF normalisé (facture ${facture.id}, ignoré) :`,
        error instanceof Error ? error.message : error
      );
    });
  }

  await prisma.facture.update({
    where: { id: facture.id },
    data: {
      factureNormaliseeNumero: null,
      factureNormaliseeDatePaiement: null,
      factureNormaliseeNomFichier: null,
      factureNormaliseeNomOriginal: null,
      factureNormaliseeTailleOctets: null,
      factureNormaliseeAjouteeAt: null,
    },
  });

  return res.json({ ok: true });
});
