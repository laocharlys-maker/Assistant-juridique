import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { z } from "zod";
import { userDataDir, secretsDir } from "../database/portablePaths";
import { appRoot } from "../lib/seaPaths";
import { LICENCE_PUBLIC_KEY_PEM } from "../config/licencePublicKey";
import { getMachineFingerprint } from "./machineFingerprint";
import { appliquerConfigurationDistante } from "../services/llm/registreModeles";
import { MODULES_DISPONIBLES } from "../config/modulesDisponibles";

/**
 * Module Licence (Lot 3) : verification cryptographique + gestion de
 * l'etat local d'une licence Aurore. Volontairement independant de Prisma
 * pour l'essentiel (testable sans base de donnees) - seule la
 * synchronisation optionnelle vers Cabinet (visibilite admin, jamais la
 * source de verite d'acces) importe `prisma` dynamiquement, en bas de ce
 * fichier. Voir README-LOT3.md pour la structure du fichier .lic, le choix
 * (b) d'empreinte machine, et comment generer une licence de test.
 */

export class LicenceError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "LicenceError";
  }
}

// ============================================================================
// Types & schema (structure exacte imposee par le prompt Lot 3 / Lot 4)
// ============================================================================

const licencePayloadSchema = z.object({
  cabinetId: z.string().min(1),
  nomCabinet: z.string().min(1),
  dateExpiration: z.string().min(1),
  empreinteMachine: z
    .string()
    .regex(/^[0-9a-f]{64}$/, "empreinteMachine doit etre un hash SHA-256 hexadecimal (64 caracteres)"),
  modulesActifs: z.array(z.string()),
  modeVerification: z.enum(["auto", "manuel"]),
  // Facultatif (retrocompatible) : absent sur toute licence emise avant ce
  // champ (aurore-licence-service) - un tel fichier reste verifiable, ce
  // champ vaut alors undefined et est traite comme "illimite" (voir
  // syncCabinetLicenceFields ci-dessous).
  limiteComptes: z.number().int().positive().nullable().optional(),
  // Quota mensuel de documents generables, par avocat/utilisateur precis du
  // cabinet (identifie par email, jamais un id - inconnu du service de
  // licence au moment de la generation). Meme retrocompatibilite que
  // limiteComptes ci-dessus. Voir syncCabinetLicenceFields ci-dessous.
  quotasDocumentsParUtilisateur: z
    .array(
      z.object({
        email: z.string().email(),
        limiteDocumentsParMois: z.number().int().positive(),
      })
    )
    .nullable()
    .optional(),
  // Plafonds separes par role, en PLUS de limiteComptes ci-dessus (le plus
  // restrictif des deux s'applique) - jamais pour titulaire/super_admin.
  // Meme retrocompatibilite que limiteComptes. Voir syncCabinetLicenceFields
  // ci-dessous et routes/users.ts (verifierLimiteComptes, enforcement reel).
  limiteAvocats: z.number().int().positive().nullable().optional(),
  limiteCollaborateurs: z.number().int().positive().nullable().optional(),
});
export type LicencePayload = z.infer<typeof licencePayloadSchema>;

const licenceFileSchema = z.object({
  payload: licencePayloadSchema,
  signature: z.string().min(1),
});
export type LicenceFile = z.infer<typeof licenceFileSchema>;

export type LicenceEtat = "valide" | "grace" | "bloquee" | "absente";

export interface LicenceStatus {
  etat: LicenceEtat;
  /** Identifiant court et stable de la licence active (derive localement du
   * fichier - PAS un champ du payload signe, voir README-LOT3.md), utilise
   * uniquement pour la visibilite support/admin. Null si aucune licence
   * exploitable. */
  licenceId: string | null;
  payload: LicencePayload | null;
  joursRestantsGrace: number | null;
  messageUtilisateur: string;
  /** Empreinte machine de CE poste (hash SHA-256, jamais l'identifiant
   * materiel brut - voir machineFingerprint.ts) - exposee y compris quand
   * aucune licence n'est encore active, pour que le cabinet puisse la
   * copier-coller depuis l'ecran d'activation et la transmettre a AzoMedIA
   * lors de la toute premiere demande de licence (voir public/licence.html
   * et README aurore-licence-service, "empreinte machine : quand est-elle
   * connue ?"). */
  empreinteMachine: string;
}

// ============================================================================
// Verification cryptographique (pure, sans effet de bord, testable isolement)
// ============================================================================

/** Serialisation deterministe du payload avant signature/verification -
 * ordre de champs fixe explicitement plutot que de dependre de l'ordre
 * d'insertion des cles JS, pour que la signature soit reproductible quelle
 * que soit la maniere dont le payload a ete construit cote signeur. */
export function canonicalizePayload(payload: LicencePayload): Buffer {
  const ordered = {
    cabinetId: payload.cabinetId,
    nomCabinet: payload.nomCabinet,
    dateExpiration: payload.dateExpiration,
    empreinteMachine: payload.empreinteMachine,
    modulesActifs: payload.modulesActifs,
    modeVerification: payload.modeVerification,
    // Ajoute en dernier, champ optionnel : quand absent (licence emise avant
    // son introduction), `payload.limiteComptes` vaut `undefined` et
    // JSON.stringify omet la cle - octets canoniques strictement identiques
    // a avant, donc signature d'une licence deja emise toujours verifiable
    // sans reemission. DOIT rester identique a canonicalizePayload() dans
    // aurore-licence-service/src/crypto/ed25519.ts.
    limiteComptes: payload.limiteComptes,
    // Meme logique de retrocompatibilite que limiteComptes ci-dessus, ajoute
    // ENCORE apres lui (ordre fige une fois publie) - DOIT rester identique
    // a canonicalizePayload() dans aurore-licence-service/src/crypto/ed25519.ts.
    quotasDocumentsParUtilisateur: payload.quotasDocumentsParUtilisateur,
    // Meme logique de retrocompatibilite que les champs precedents, ajoutes
    // ENCORE apres eux (ordre fige une fois publie) - DOIT rester identique
    // a canonicalizePayload() dans aurore-licence-service/src/crypto/ed25519.ts.
    limiteAvocats: payload.limiteAvocats,
    limiteCollaborateurs: payload.limiteCollaborateurs,
  };
  return Buffer.from(JSON.stringify(ordered), "utf8");
}

/** Verifie la signature Ed25519 d'un payload avec la cle publique embarquee
 * (config/licencePublicKey.ts). `node:crypto` natif, aucune dependance
 * tierce (Ed25519 supporte nativement depuis Node 12). Ne leve jamais -
 * retourne false pour toute entree malformee. */
export function verifyLicenceSignature(payload: LicencePayload, signatureBase64: string): boolean {
  try {
    const publicKey = crypto.createPublicKey({ key: LICENCE_PUBLIC_KEY_PEM, format: "pem" });
    const signature = Buffer.from(signatureBase64, "base64");
    return crypto.verify(null, canonicalizePayload(payload), publicKey, signature);
  } catch {
    return false;
  }
}

/** Identifiant court derive localement (hash du payload canonique + de la
 * signature) - sert uniquement a distinguer/afficher "quelle licence est
 * active" (ex: cote support), jamais a une decision d'acces. */
export function computeLicenceId(file: LicenceFile): string {
  return crypto
    .createHash("sha256")
    .update(canonicalizePayload(file.payload))
    .update(file.signature)
    .digest("hex")
    .slice(0, 24);
}

/** Parse le contenu brut d'un fichier .lic OU d'un "code" colle (le meme
 * JSON, eventuellement encode en base64 pour etre plus facilement
 * transmis/colle que le fichier complet). Ne verifie PAS la signature -
 * voir verifyLicenceSignature. Leve LicenceError avec un message
 * utilisateur clair si la structure est invalide. */
export function parseLicenceFileContent(raw: string): LicenceFile {
  const trimmed = raw.trim();
  if (!trimmed) {
    throw new LicenceError("Aucun contenu de licence fourni.");
  }

  let json: unknown;
  try {
    json = JSON.parse(trimmed);
  } catch {
    // Pas du JSON direct : tente un decodage base64 (cas du "code" colle,
    // plus compact/transmissible qu'un fichier .lic complet).
    try {
      json = JSON.parse(Buffer.from(trimmed, "base64").toString("utf8"));
    } catch {
      throw new LicenceError(
        "Le contenu fourni n'est pas un fichier ou un code de licence reconnu. Verifiez que vous avez copie l'integralite du fichier .lic ou du code."
      );
    }
  }

  const result = licenceFileSchema.safeParse(json);
  if (!result.success) {
    throw new LicenceError(
      "Le fichier de licence a une structure inattendue (peut-etre corrompu ou incomplet). Contactez AzoMedIA si le probleme persiste."
    );
  }
  return result.data;
}

// ============================================================================
// Evaluation d'etat (pure, sans effet de bord - date/empreinte/revocation en
// parametres explicites plutot que lus directement, pour rester testable)
// ============================================================================

/** Duree de la periode de grace apres expiration, en jours (10-15 jours
 * demandes par le prompt - 14 par defaut, configurable). */
export const LICENCE_GRACE_JOURS_DEFAUT = 14;

function formatDateFr(date: Date): string {
  return date.toLocaleDateString("fr-FR", { day: "numeric", month: "long", year: "numeric" });
}

export interface EvaluationLicence {
  etat: LicenceEtat;
  joursRestantsGrace: number | null;
  messageUtilisateur: string;
}

export function evaluateLicenceState(params: {
  payload: LicencePayload;
  machineFingerprint: string;
  now: Date;
  graceJours: number;
  revoquee: boolean;
}): EvaluationLicence {
  const { payload, machineFingerprint, now, graceJours, revoquee } = params;

  if (revoquee) {
    return {
      etat: "bloquee",
      joursRestantsGrace: null,
      messageUtilisateur: "Votre licence a été révoquée par AzoMedIA. Contactez AzoMedIA pour plus d'informations.",
    };
  }

  if (payload.empreinteMachine !== machineFingerprint) {
    return {
      etat: "bloquee",
      joursRestantsGrace: null,
      messageUtilisateur:
        "Cette licence ne correspond pas à cet ordinateur. Contactez AzoMedIA pour obtenir une licence valide pour ce poste.",
    };
  }

  const expiration = new Date(payload.dateExpiration);
  if (Number.isNaN(expiration.getTime())) {
    return {
      etat: "bloquee",
      joursRestantsGrace: null,
      messageUtilisateur: "Le fichier de licence est invalide (date d'expiration illisible). Contactez AzoMedIA.",
    };
  }

  if (now.getTime() <= expiration.getTime()) {
    return {
      etat: "valide",
      joursRestantsGrace: null,
      messageUtilisateur: `Licence valide jusqu'au ${formatDateFr(expiration)}.`,
    };
  }

  const finGrace = expiration.getTime() + graceJours * 24 * 60 * 60 * 1000;
  if (now.getTime() <= finGrace) {
    const joursRestants = Math.max(1, Math.ceil((finGrace - now.getTime()) / (24 * 60 * 60 * 1000)));
    return {
      etat: "grace",
      joursRestantsGrace: joursRestants,
      messageUtilisateur: `Votre licence a expiré le ${formatDateFr(expiration)}. Il vous reste ${joursRestants} jour(s) avant blocage de l'accès. Contactez AzoMedIA pour la renouveler.`,
    };
  }

  return {
    etat: "bloquee",
    joursRestantsGrace: null,
    messageUtilisateur: `Votre licence a expiré le ${formatDateFr(expiration)}. Contactez AzoMedIA pour la renouveler.`,
  };
}

// ============================================================================
// Gestion d'etat locale (I/O : fichier de licence, marqueur de revocation)
// ============================================================================

function licenceFilePath(): string {
  return path.join(userDataDir(), "licence.lic");
}

function licenceLocalStatePath(): string {
  return path.join(secretsDir(), "licence-state.json");
}

interface LicenceLocalState {
  revoquee?: boolean;
  revoqueeAt?: string;
}

function readLocalState(): LicenceLocalState {
  try {
    return JSON.parse(fs.readFileSync(licenceLocalStatePath(), "utf8")) as LicenceLocalState;
  } catch {
    return {};
  }
}

function writeLocalState(state: LicenceLocalState): void {
  fs.mkdirSync(secretsDir(), { recursive: true });
  fs.writeFileSync(licenceLocalStatePath(), JSON.stringify(state, null, 2));
}

/** La revocation n'est consultee qu'UNE FOIS par cycle de vie du process
 * (mise en cache au premier appel) : une revocation recue en cours de
 * session via phone-home ne doit jamais couper l'acces brutalement,
 * seulement au prochain redemarrage - voir contrainte du prompt. */
let cachedRevoquee: boolean | null = null;
function isRevoqueeThisSession(): boolean {
  if (cachedRevoquee === null) {
    cachedRevoquee = Boolean(readLocalState().revoquee);
  }
  return cachedRevoquee;
}

function writeLicenceFileAtomic(file: LicenceFile): void {
  fs.mkdirSync(userDataDir(), { recursive: true });
  const finalPath = licenceFilePath();
  const tmpPath = `${finalPath}.tmp-${process.pid}`;
  fs.writeFileSync(tmpPath, JSON.stringify(file, null, 2));
  fs.renameSync(tmpPath, finalPath);
}

const graceJoursConfigures = (): number => {
  const raw = Number(process.env.LICENCE_GRACE_JOURS);
  return Number.isFinite(raw) && raw > 0 ? raw : LICENCE_GRACE_JOURS_DEFAUT;
};

/** Lit, verifie et evalue la licence actuellement installee. Jamais
 * d'appel reseau ici (uniquement le fichier local + l'empreinte machine,
 * elle-meme mise en cache localement - voir machineFingerprint.ts). */
export async function getCurrentLicenceStatus(): Promise<LicenceStatus> {
  // Calculee en tout premier, y compris quand aucune licence n'existe
  // encore : c'est la seule facon pour le cabinet de connaitre l'empreinte
  // a transmettre a AzoMedIA pour sa toute premiere licence (voir le champ
  // empreinteMachine ci-dessous, et README aurore-licence-service).
  const fingerprint = await getMachineFingerprint();

  if (!fs.existsSync(licenceFilePath())) {
    return {
      etat: "absente",
      licenceId: null,
      payload: null,
      joursRestantsGrace: null,
      messageUtilisateur: "Aucune licence active. Activez Aurore avec le fichier de licence fourni par AzoMedIA.",
      empreinteMachine: fingerprint,
    };
  }

  let file: LicenceFile;
  try {
    file = parseLicenceFileContent(fs.readFileSync(licenceFilePath(), "utf8"));
  } catch {
    console.error("[licence] fichier local illisible/corrompu (licence valide: false).");
    return {
      etat: "bloquee",
      licenceId: null,
      payload: null,
      joursRestantsGrace: null,
      messageUtilisateur: "Le fichier de licence est invalide ou corrompu. Réactivez Aurore avec un fichier de licence valide.",
      empreinteMachine: fingerprint,
    };
  }

  if (!verifyLicenceSignature(file.payload, file.signature)) {
    console.error("[licence] signature invalide detectee sur le fichier local (licence valide: false).");
    return {
      etat: "bloquee",
      licenceId: null,
      payload: null,
      joursRestantsGrace: null,
      messageUtilisateur: "Le fichier de licence est invalide ou corrompu. Réactivez Aurore avec un fichier de licence valide.",
      empreinteMachine: fingerprint,
    };
  }

  const evaluation = evaluateLicenceState({
    payload: file.payload,
    machineFingerprint: fingerprint,
    now: new Date(),
    graceJours: graceJoursConfigures(),
    revoquee: isRevoqueeThisSession(),
  });

  console.log(`[licence] statut evalue (licence valide: ${evaluation.etat === "valide"}, etat: "${evaluation.etat}").`);

  return {
    etat: evaluation.etat,
    licenceId: computeLicenceId(file),
    payload: file.payload,
    joursRestantsGrace: evaluation.joursRestantsGrace,
    messageUtilisateur: evaluation.messageUtilisateur,
    empreinteMachine: fingerprint,
  };
}

/** Active une nouvelle licence a partir d'un contenu brut (fichier .lic ou
 * code colle). Verifie signature ET empreinte machine AVANT tout ecriture
 * sur disque - une licence rejetee n'est jamais persistee. Leve
 * LicenceError (message utilisateur clair) en cas de rejet. */
export async function activateLicence(rawContent: string): Promise<LicenceStatus> {
  const file = parseLicenceFileContent(rawContent);

  if (!verifyLicenceSignature(file.payload, file.signature)) {
    console.error("[licence] tentative d'activation rejetee : signature invalide (licence valide: false).");
    throw new LicenceError(
      "La signature de ce fichier de licence est invalide. Vérifiez que le fichier n'a pas été modifié, ou contactez AzoMedIA."
    );
  }

  const fingerprint = await getMachineFingerprint();
  if (file.payload.empreinteMachine !== fingerprint) {
    console.error("[licence] tentative d'activation rejetee : empreinte machine differente (licence valide: false).");
    throw new LicenceError(
      "Cette licence ne correspond pas à cet ordinateur. Contactez AzoMedIA pour obtenir une licence valide pour ce poste."
    );
  }

  writeLicenceFileAtomic(file);
  // Une nouvelle activation, signee et valide pour cette machine, doit
  // toujours pouvoir lever une revocation anterieure.
  writeLocalState({ ...readLocalState(), revoquee: false });
  cachedRevoquee = false;

  console.log("[licence] activation reussie (licence valide: true).");
  const status = await getCurrentLicenceStatus();
  await syncCabinetLicenceFields(status);
  return status;
}

// ============================================================================
// Phone-home (mode auto uniquement - voir routes/licence.ts pour l'appel
// manuel "Verifier maintenant", et index.ts pour la planification node-cron)
// ============================================================================

function getAppVersion(): string {
  try {
    const raw = fs.readFileSync(path.join(appRoot(), "package.json"), "utf8");
    const pkg = JSON.parse(raw) as { version?: string };
    return pkg.version || "0.0.0-inconnue";
  } catch {
    return "0.0.0-inconnue";
  }
}

const phoneHomeResponseSchema = z.object({
  revoquee: z.boolean().optional(),
  licence: licenceFileSchema.optional(),
  // Lot 22 : modele LLM actif par fournisseur (ex: { "gemini": "gemini-2.5-flash" }),
  // envoye par un serveur aurore-licence-service equipe du Lot 22 - absent
  // pour un serveur plus ancien. z.record(z.string()) reste coherent avec le
  // schema non strict deja en place (voir isMissingConfigurationError et le
  // rapport d'inspection Lot 4 : les champs additionnels/inconnus ne cassent
  // jamais .safeParse(), ils sont simplement ignores si non declares ici -
  // ce champ est desormais declare, donc lu, mais n'importe quelle cle de
  // fournisseur non geree par registreModeles.ts sera elle-meme ignoree par
  // appliquerConfigurationDistante).
  modelesLlmActifs: z.record(z.string()).optional(),
});

export interface PhoneHomeResult {
  ok: boolean;
  action: "ignore" | "aucun-changement" | "renouvelee" | "revoquee" | "echec-reseau" | "reponse-invalide";
  message: string;
}

// Endpoint public (pas un secret - deja protege par CORS + rate-limiting
// cote Worker, voir aurore-licence-service/wrangler.toml) - code en dur ici
// plutot que via bundledExternalServiceKeys.ts (reserve aux vraies cles
// secretes injectees par le CI) : jusqu'ici LICENCE_PHONE_HOME_URL n'etait
// JAMAIS injectee dans aucun build distribue, ce qui rendait le
// phone-home (auto ET "Verifier maintenant") totalement muet dans toute
// installation reelle depuis le Lot 4 - jamais remarque faute d'un message
// d'erreur visible ailleurs qu'ici. LICENCE_PHONE_HOME_URL reste lisible en
// variable d'environnement pour pointer vers un autre serveur (dev/tests).
const LICENCE_PHONE_HOME_URL_DEFAUT = "https://aurore-licence-service.azomedia20.workers.dev/phone-home";

/**
 * Verification en ligne aupres du service de licence (Lot 4, endpoint
 * configurable). Ne bloque JAMAIS l'application : toute erreur reseau/HTTP
 * est avalee et journalisee, jamais interpretee comme une revocation.
 *
 * `options.force` distingue les deux seuls appelants possibles :
 * - index.ts (demarrage + planification hebdomadaire node-cron) appelle
 *   SANS force : en mode manuel, aucun appel reseau n'est declenche, comme
 *   exige par le prompt ("zero appel reseau" en mode manuel).
 * - routes/licence.ts (bouton "Verifier maintenant") appelle AVEC
 *   force: true : une action explicite de l'utilisateur doit toujours
 *   pouvoir declencher une verification, meme en mode manuel - c'est
 *   precisement le seul cas ou un appel reseau est autorise en mode manuel.
 */
export async function runPhoneHomeCheck(options: { force?: boolean } = {}): Promise<PhoneHomeResult> {
  const status = await getCurrentLicenceStatus();
  if (!status.payload) {
    return { ok: false, action: "ignore", message: "Aucune licence active - rien a verifier." };
  }
  if (status.payload.modeVerification !== "auto" && !options.force) {
    return { ok: true, action: "ignore", message: "Mode manuel actif : verification en ligne non automatique." };
  }

  const endpoint = process.env.LICENCE_PHONE_HOME_URL || LICENCE_PHONE_HOME_URL_DEFAUT;

  const fingerprint = await getMachineFingerprint();
  const payload = { cabinetId: status.payload.cabinetId, empreinteMachine: fingerprint, versionApp: getAppVersion() };

  let response: globalThis.Response;
  try {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 10_000);
    try {
      response = await fetch(endpoint, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(payload),
        signal: controller.signal,
      });
    } finally {
      clearTimeout(timeout);
    }
  } catch (error) {
    // Pas de connexion / serveur injoignable : jamais bloquant, jamais une
    // revocation - simple echec silencieux, nouvelle tentative au prochain
    // cycle hebdomadaire.
    console.warn(
      "[licence] verification en ligne injoignable (reessai automatique plus tard) :",
      error instanceof Error ? error.message : error
    );
    return { ok: false, action: "echec-reseau", message: "Vérification en ligne impossible (pas de connexion) - nouvel essai automatique plus tard." };
  }

  if (!response.ok) {
    console.warn(`[licence] verification en ligne : reponse HTTP ${response.status} (ignoree, reessai plus tard).`);
    return {
      ok: false,
      action: "echec-reseau",
      message: `Le service de licence a répondu une erreur (${response.status}) - nouvel essai automatique plus tard.`,
    };
  }

  let body: unknown;
  try {
    body = await response.json();
  } catch {
    return { ok: false, action: "reponse-invalide", message: "Réponse du service de licence illisible." };
  }

  const parsed = phoneHomeResponseSchema.safeParse(body);
  if (!parsed.success) {
    return { ok: false, action: "reponse-invalide", message: "Réponse du service de licence dans un format inattendu." };
  }

  // Lot 22 : applique la configuration distante des modeles LLM des qu'une
  // reponse phone-home valide en contient une - independamment du
  // renouvellement/revocation de licence ci-dessous (voir registreModeles.ts,
  // appliquerConfigurationDistante : ignore silencieusement si absent ou
  // deja a jour, ne modifie jamais le modele de repli).
  if (parsed.data.modelesLlmActifs) {
    appliquerConfigurationDistante(parsed.data.modelesLlmActifs);
  }

  if (parsed.data.licence) {
    if (!verifyLicenceSignature(parsed.data.licence.payload, parsed.data.licence.signature)) {
      console.error("[licence] licence renouvelee recue via phone-home avec signature invalide - ignoree.");
      return { ok: false, action: "reponse-invalide", message: "La licence renouvelée reçue est invalide - ignorée." };
    }
    writeLicenceFileAtomic(parsed.data.licence);
    console.log("[licence] licence renouvelee recue et appliquee (licence valide: true).");
    const newStatus = await getCurrentLicenceStatus();
    await syncCabinetLicenceFields(newStatus);
    return { ok: true, action: "renouvelee", message: "Licence renouvelée automatiquement." };
  }

  if (parsed.data.revoquee) {
    // Jamais de coupure brutale en cours de session (voir
    // isRevoqueeThisSession) : simple marqueur applique au prochain
    // demarrage.
    writeLocalState({ ...readLocalState(), revoquee: true, revoqueeAt: new Date().toISOString() });
    console.warn("[licence] revocation recue - sera appliquee au prochain demarrage de l'application.");
    return { ok: true, action: "revoquee", message: "Révocation reçue - sera appliquée au prochain démarrage de l'application." };
  }

  return { ok: true, action: "aucun-changement", message: "Licence toujours valide, aucun changement." };
}

// ============================================================================
// Synchronisation Cabinet - licenceId/mode/date/empreinte restent un pur
// miroir de visibilite admin (jamais la source de verite d'acces, qui reste
// le fichier local + evaluateLicenceState). limiteComptes ET modulesDesactives
// ci-dessous font EXCEPTION : ce sont les seuls champs reellement exploites
// en enforcement (routes/users.ts verifierLimiteComptes ; middleware/roles.ts
// requireModule/estModuleDesactive) - la licence en devient donc la source
// reelle en mode portable/reseau (aucun super_admin n'y existe pour les
// regler autrement, voir routes/auth.ts).
// ============================================================================

// Calcule les modules a desactiver a partir de la liste blanche du payload
// de licence (modulesActifs) : convention inversee par rapport a
// Cabinet.modulesDesactives (liste noire) - "all" (defaut historique de
// toute licence, voir aurore-licence-service/generateLicence.ts) => aucune
// restriction. Sinon, tout module connu absent de la liste blanche est
// desactive. Une cle inconnue de MODULES_DISPONIBLES dans modulesActifs
// (ex: cle ajoutee cote app avant d'etre ajoutee ici) est silencieusement
// sans effet, jamais une erreur.
export function calculerModulesDesactives(modulesActifs: string[]): string[] {
  if (modulesActifs.includes("all")) return [];
  return MODULES_DISPONIBLES.filter((cle) => !modulesActifs.includes(cle));
}

async function syncCabinetLicenceFields(status: LicenceStatus): Promise<void> {
  if (!status.payload || !status.licenceId) return;
  try {
    // Import differe : ce module reste utilisable (fonctions pures,
    // parsing, evaluation d'etat) sans jamais instancier Prisma si
    // l'appelant ne s'en sert pas - meme logique que index.ts (Lot 2) pour
    // ne charger Prisma qu'une fois DATABASE_URL disponible.
    const { prisma } = await import("../lib/prisma");
    // BUG CORRIGE (2026-09-05) : ce miroir cherchait jusqu'ici le cabinet
    // local par `id: status.payload.cabinetId` - or cet id est assigne cote
    // aurore-licence-service (systeme totalement distinct), alors que le
    // cabinet cree localement au "premier lancement" (routes/auth.ts,
    // `prisma.cabinet.create({ data: { nom: cabinetNom } })`, sans id
    // fourni) recoit un UUID genere par Prisma, SANS AUCUN rapport avec
    // celui de la licence. Les deux ne coincident donc JAMAIS - ce miroir
    // ne synchronisait RIEN depuis son introduction (limiteComptes,
    // modulesDesactives, limiteAvocats, limiteCollaborateurs, quotas par
    // avocat), silencieusement (count: 0, jamais signale bruyamment par
    // design). Correctif : en mode portable/reseau (le seul ou une licence
    // locale existe - voir deploymentMode.ts, "le mode externe ignore ce
    // module entierement"), la base locale ne contient jamais qu'UN SEUL
    // cabinet reel (garde par aucunCabinetReel(), routes/auth.ts) - on cible
    // donc simplement cet unique cabinet, quel que soit son id, plutot que
    // de exiger une egalite d'id qui n'a jamais de raison d'etre vraie.
    const cabinetLocal = await prisma.cabinet.findFirst({ select: { id: true } });
    if (!cabinetLocal) {
      // Cabinet legitimement pas encore cree (tout premier demarrage,
      // licence activee AVANT la creation du compte titulaire - c'est meme
      // le parcours normal, voir welcome-setup.html) - reevalue a CHAQUE
      // requete protegee (voir requireLicence), donc pas signale bruyamment.
      console.log(
        "[licence] aucun cabinet en base pour l'instant (miroir non synchronise, reessaiera a la prochaine requete) - normal avant la creation du compte titulaire."
      );
    } else {
      await prisma.cabinet.update({
        where: { id: cabinetLocal.id },
        data: {
          licenceId: status.licenceId,
          licenceModeVerification: status.payload.modeVerification,
          licenceDateExpiration: new Date(status.payload.dateExpiration),
          empreinteMachineAutorisee: status.payload.empreinteMachine,
          // Contrairement aux autres champs synchronises ci-dessus (purs
          // miroirs de visibilite), celui-ci EST directement exploite en
          // enforcement (voir routes/users.ts, verifierLimiteComptes) - la
          // licence devient donc la source reelle de cette limite en mode
          // portable/reseau, alors qu'elle etait jusqu'ici reglable
          // uniquement via l'ecran super_admin (mode externe, voir
          // routes/admin.ts). `?? null` : une licence sans ce champ (emise
          // avant son introduction) remet explicitement "illimite", jamais
          // une valeur laissee au hasard.
          limiteComptes: status.payload.limiteComptes ?? null,
          // Memes plafonds separes par role, meme convention `?? null` que
          // limiteComptes ci-dessus - exploites par routes/users.ts
          // (verifierLimiteComptes), jamais par ce miroir lui-meme.
          limiteAvocats: status.payload.limiteAvocats ?? null,
          limiteCollaborateurs: status.payload.limiteCollaborateurs ?? null,
          modulesDesactives: calculerModulesDesactives(status.payload.modulesActifs),
        },
      });

      // Quota de documents par avocat : SEULEMENT si ce champ est present
      // dans le payload signe (`!== undefined`) - une licence emise avant
      // son introduction laisse ce champ absent, et ne doit JAMAIS ecraser
      // un quota regle manuellement via l'ecran super_admin (mode externe,
      // voir routes/admin.ts PATCH /api/admin/users/:id/quota, qui reste la
      // seule voie pour ce mode-la). Des qu'il est present (y compris
      // `null`, une soumission volontairement vide depuis le dashboard
      // licence), la licence devient la source de verite pour CE cabinet,
      // meme logique que modulesDesactives ci-dessus : reinitialise TOUS
      // les comptes du cabinet a "illimite", puis reapplique les overrides
      // listes - un avocat retire de la liste lors d'un renouvellement
      // retrouve donc un quota illimite.
      if (status.payload.quotasDocumentsParUtilisateur !== undefined) {
        await prisma.user.updateMany({
          where: { cabinetId: cabinetLocal.id },
          data: { limiteDocumentsParMois: null },
        });
        for (const { email, limiteDocumentsParMois } of status.payload.quotasDocumentsParUtilisateur ?? []) {
          await prisma.user.updateMany({
            where: { cabinetId: cabinetLocal.id, email },
            data: { limiteDocumentsParMois },
          });
        }
      }
    }
  } catch (error) {
    // Erreur DB reelle (connexion perdue...) cette fois, pas une simple
    // absence de cabinet (voir updateMany ci-dessus) - non bloquant : ce
    // miroir DB est un confort de visibilite, jamais requis pour que la
    // licence fonctionne.
    console.warn(
      "[licence] synchronisation des champs Cabinet impossible (ignoree) :",
      error instanceof Error ? error.message : error
    );
  }
}
