import { Prisma, PrismaClient } from "@prisma/client";
import { decryptField, decryptJsonField, encryptField, encryptJsonField } from "./encryptionAtRest";

/**
 * Extension Prisma (Lot 2bis) qui chiffre/dechiffre de facon transparente
 * les champs sensibles designes ci-dessous, pour que le reste du code
 * metier (webActions.ts, routes/clients.ts, documentExport.ts...) continue
 * de lire/ecrire des valeurs en clair sans aucune modification. Voir
 * README-LOT2BIS.md pour le detail du choix de champs et des limites.
 *
 * Champs volontairement exclus (non chiffres) : tout ce qui sert a un WHERE
 * exact ou un tri cote base (id, cabinetId, statut, dates...), et tout champ
 * non explicitement designe ici (ex: Client.notes, Client.lieuNaissance) -
 * cf. contrainte du prompt Lot 2bis ("ne pas chiffrer les champs utilises
 * dans des WHERE/recherches frequentes").
 */
const ENCRYPTED_FIELDS_BY_MODEL: Record<string, Record<string, "string" | "json">> = {
  Client: {
    nom: "string",
    email: "string",
    telephone: "string",
    numeroPieceIdentite: "string",
    quartierResidence: "string",
    rue: "string",
    autrePrecision: "string",
    maison: "string",
  },
  Action: {
    contenuGenere: "string",
    champsDocument: "json",
  },
  // Lot 12b : tokens OAuth2 Google et mot de passe CalDAV - jamais en clair
  // en base, meme pattern que les champs identifiants de Client ci-dessus.
  // caldavUsername/caldavUrl/calendrierUrl NE sont PAS chiffres : non
  // secrets (juste de la configuration, affichee telle quelle a l'ecran
  // "Paramètres > Calendrier").
  ConnexionCalendrierExterne: {
    accessToken: "string",
    refreshToken: "string",
    caldavPassword: "string",
  },
  // Lot 16 : tokens OAuth2 Gmail et mot de passe IMAP - meme pattern que
  // ConnexionCalendrierExterne ci-dessus. adresseEmail/imapHost/imapPort/
  // imapSecure/imapUsername NE sont PAS chiffres : non secrets (juste de la
  // configuration, affichee telle quelle a l'ecran "Paramètres > Emails").
  ConnexionEmailExterne: {
    accessToken: "string",
    refreshToken: "string",
    imapPassword: "string",
  },
};

interface RelationInfo {
  targetModel: string;
}

/** Construit, a partir du DMMF Prisma, la table des relations objet de
 * chaque modele (nom de champ -> modele cible), utilisee pour propager le
 * dechiffrement dans les lectures imbriquees (`include`/`select` depuis un
 * AUTRE modele - ex: `facture.dossier.client`, `dossier.actions[]`), que
 * l'extension `query` de Prisma n'intercepte PAS automatiquement puisqu'elle
 * ne se declenche que pour le modele directement interroge. */
function buildRelationsByModel(): Record<string, Record<string, RelationInfo>> {
  const relations: Record<string, Record<string, RelationInfo>> = {};
  for (const model of Prisma.dmmf.datamodel.models) {
    const fields: Record<string, RelationInfo> = {};
    for (const field of model.fields) {
      if (field.kind === "object" && field.relationName) {
        fields[field.name] = { targetModel: field.type };
      }
    }
    relations[model.name] = fields;
  }
  return relations;
}

const RELATIONS_BY_MODEL = buildRelationsByModel();

/** Cloture transitive : un modele est "concerne" s'il porte lui-meme un
 * champ chiffre, ou s'il a une relation (a n'importe quelle profondeur) vers
 * un modele qui en porte un. Permet de sauter entierement les modeles sans
 * rapport (JurisprudenceChunk, DelaiType...) plutot que de parcourir chaque
 * resultat de requete en aveugle - cf. exigence de performance du Lot 2bis. */
function computeRelevantModels(): Set<string> {
  const relevant = new Set<string>(Object.keys(ENCRYPTED_FIELDS_BY_MODEL));
  let changed = true;
  while (changed) {
    changed = false;
    for (const [modelName, fields] of Object.entries(RELATIONS_BY_MODEL)) {
      if (relevant.has(modelName)) continue;
      for (const info of Object.values(fields)) {
        if (relevant.has(info.targetModel)) {
          relevant.add(modelName);
          changed = true;
          break;
        }
      }
    }
  }
  return relevant;
}

const RELEVANT_MODELS = computeRelevantModels();

function codecFor(kind: "string" | "json") {
  return kind === "json" ? { encrypt: encryptJsonField, decrypt: decryptJsonField } : { encrypt: encryptField, decrypt: decryptField };
}

function encryptScalarUpdateValue(raw: unknown, kind: "string" | "json"): unknown {
  const codec = codecFor(kind);
  if (raw && typeof raw === "object" && !Array.isArray(raw) && "set" in (raw as Record<string, unknown>)) {
    return { ...(raw as Record<string, unknown>), set: codec.encrypt((raw as Record<string, unknown>).set as never) };
  }
  return codec.encrypt(raw as never);
}

/**
 * Chiffre les champs designes dans un objet `data` d'ecriture directe sur le
 * modele (create/update/createMany.data/upsert.create/upsert.update).
 * Volontairement limite aux ecritures DIRECTES sur Client/Action : le
 * projet n'utilise nulle part une ecriture imbriquee du type
 * `prisma.dossier.update({ data: { client: { update: {...} } } } })` pour
 * ces deux modeles (verifie a l'ecriture de ce lot) - si un tel usage
 * apparait plus tard, il faudra passer par `prisma.client.update()` /
 * `prisma.action.update()` directement, ou etendre cette fonction.
 */
function encryptDataForModel(model: string, data: unknown): unknown {
  const fields = ENCRYPTED_FIELDS_BY_MODEL[model];
  if (!fields || data === null || data === undefined) return data;
  if (Array.isArray(data)) return data.map((item) => encryptDataForModel(model, item));
  if (typeof data !== "object") return data;
  const out: Record<string, unknown> = { ...(data as Record<string, unknown>) };
  for (const [field, kind] of Object.entries(fields)) {
    if (!(field in out)) continue;
    out[field] = encryptScalarUpdateValue(out[field], kind);
  }
  return out;
}

function applyWriteEncryption(model: string, operation: string, args: unknown): unknown {
  if (!ENCRYPTED_FIELDS_BY_MODEL[model] || !args || typeof args !== "object") return args;
  const next: Record<string, unknown> = { ...(args as Record<string, unknown>) };
  if (operation === "upsert") {
    if ("create" in next) next.create = encryptDataForModel(model, next.create);
    if ("update" in next) next.update = encryptDataForModel(model, next.update);
  } else if ("data" in next) {
    next.data = encryptDataForModel(model, next.data);
  }
  return next;
}

/** Parcourt recursivement un resultat de requete (objet unique, tableau, ou
 * arbre imbrique via include/select) et dechiffre en place tout champ
 * designe rencontre, a n'importe quelle profondeur de relation. */
function decryptResultTree(model: string, value: unknown): void {
  if (!RELEVANT_MODELS.has(model) || value === null || value === undefined) return;
  if (Array.isArray(value)) {
    for (const item of value) decryptResultTree(model, item);
    return;
  }
  if (typeof value !== "object") return;
  const row = value as Record<string, unknown>;

  const fields = ENCRYPTED_FIELDS_BY_MODEL[model];
  if (fields) {
    for (const [field, kind] of Object.entries(fields)) {
      if (field in row) row[field] = codecFor(kind).decrypt(row[field] as never);
    }
  }

  const relations = RELATIONS_BY_MODEL[model];
  if (relations) {
    for (const [relField, info] of Object.entries(relations)) {
      if (relField in row && row[relField] != null && RELEVANT_MODELS.has(info.targetModel)) {
        decryptResultTree(info.targetModel, row[relField]);
      }
    }
  }
}

function extractOrderCriteria(orderBy: unknown): Array<{ field: string; direction: "asc" | "desc" }> {
  if (!orderBy) return [];
  const list = Array.isArray(orderBy) ? orderBy : [orderBy];
  const out: Array<{ field: string; direction: "asc" | "desc" }> = [];
  for (const entry of list) {
    if (!entry || typeof entry !== "object") continue;
    for (const [field, dir] of Object.entries(entry as Record<string, unknown>)) {
      if (typeof dir === "string") out.push({ field, direction: dir === "desc" ? "desc" : "asc" });
    }
  }
  return out;
}

/**
 * Un champ chiffre au repos n'a plus d'ordre alphabetique significatif cote
 * SQL (le tri se fait sur le texte chiffre). La seule utilisation actuelle
 * d'un `orderBy` sur un champ concerne est `orderBy: { nom: "asc" }` dans
 * routes/clients.ts - on re-trie donc ici, apres dechiffrement, en JS.
 * Limite volontaire : ne traite que le `orderBy` du modele interroge
 * directement (pas un `orderBy` imbrique dans un `include`), aucun usage de
 * ce cas n'existant aujourd'hui dans le projet.
 */
function reorderByEncryptedFields(model: string, args: unknown, result: unknown): void {
  if (!Array.isArray(result)) return;
  const fields = ENCRYPTED_FIELDS_BY_MODEL[model];
  if (!fields) return;
  const orderBy = args && typeof args === "object" ? (args as Record<string, unknown>).orderBy : undefined;
  const criteria = extractOrderCriteria(orderBy).filter((c) => c.field in fields);
  if (criteria.length === 0) return;
  // Tri stable (V8) applique du dernier critere au premier, pour que le
  // premier critere reste prioritaire en cas de tri multi-champs.
  for (let i = criteria.length - 1; i >= 0; i--) {
    const { field, direction } = criteria[i];
    (result as Array<Record<string, unknown>>).sort((a, b) => {
      const av = String(a?.[field] ?? "");
      const bv = String(b?.[field] ?? "");
      const cmp = av.localeCompare(bv, "fr");
      return direction === "desc" ? -cmp : cmp;
    });
  }
}

interface AllOperationsArgs {
  model?: string;
  operation: string;
  args: unknown;
  query: (args: unknown) => Promise<unknown>;
}

/**
 * Applique l'extension a un PrismaClient. Interception generique sur TOUS
 * les modeles (`$allModels.$allOperations`) plutot que ciblee sur
 * Client/Action uniquement : c'est necessaire pour dechiffrer les lectures
 * imbriquees declenchees depuis un AUTRE modele (ex: `prisma.facture.
 * findMany({ include: { dossier: { select: { client: true } } } } })`,
 * `prisma.dossier.findFirst({ include: { actions: true } })`) - verifie
 * comme etant deja utilise dans routes/factures.ts et routes/dossiers.ts.
 * Les modeles sans rapport (JurisprudenceChunk, DelaiType...) sont ecartes
 * immediatement via RELEVANT_MODELS, sans cout au-dela d'une verification
 * Set.has().
 */
export function withEncryptionAtRest(client: PrismaClient): PrismaClient {
  // Le type de retour de `$extends` (DynamicClientExtensionThis, avec des
  // generiques internes lies a la forme exacte de l'extension) n'est pas
  // litteralement `PrismaClient`, mais expose la meme API publique utilisee
  // partout ailleurs dans le projet (`prisma.<model>.<operation>()`,
  // `prisma.$disconnect()`, `prisma.$queryRaw`...). On recadre donc
  // explicitement vers `PrismaClient` ici, en un seul endroit, plutot que de
  // propager un type d'extension complexe dans les 30 fichiers qui
  // importent `prisma` depuis lib/prisma.ts.
  return client.$extends({
    name: "aurore-encryption-at-rest",
    query: {
      $allModels: {
        async $allOperations({ model, operation, args, query }: AllOperationsArgs) {
          if (!model) return query(args);
          const nextArgs = applyWriteEncryption(model, operation, args);
          const result = await query(nextArgs);
          decryptResultTree(model, result);
          reorderByEncryptedFields(model, nextArgs, result);
          return result;
        },
      },
    },
  }) as unknown as PrismaClient;
}
