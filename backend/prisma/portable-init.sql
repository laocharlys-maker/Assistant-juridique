-- CreateExtension
CREATE EXTENSION IF NOT EXISTS "pgcrypto";

-- CreateExtension
CREATE EXTENSION IF NOT EXISTS "vector";

-- CreateEnum
CREATE TYPE "UserRole" AS ENUM ('titulaire', 'avocat', 'collaborateur', 'super_admin');

-- CreateEnum
CREATE TYPE "Canal" AS ENUM ('web', 'whatsapp');

-- CreateEnum
CREATE TYPE "TypeAction" AS ENUM ('notes', 'redac', 'jurisprudence', 'recherche_juridique', 'conclusions', 'assignation', 'mise_en_demeure', 'traduction', 'resume_pdf', 'veille_juridique', 'plainte', 'contrat', 'notification_date', 'requete', 'projet_ordonnance', 'note_plaidoirie');

-- CreateEnum
CREATE TYPE "StatutExecution" AS ENUM ('succes', 'erreur');

-- CreateEnum
CREATE TYPE "StatutAction" AS ENUM ('brouillon', 'en_attente_validation', 'valide', 'envoye', 'echec_generation', 'revision_demandee');

-- CreateEnum
CREATE TYPE "UniteDelai" AS ENUM ('jours', 'mois');

-- CreateEnum
CREATE TYPE "FactureStatut" AS ENUM ('brouillon', 'envoyee', 'payee');

-- CreateEnum
CREATE TYPE "StatutRoleAudience" AS ENUM ('a_preparer', 'pret', 'traite');

-- CreateTable
CREATE TABLE "cabinets" (
    "id" TEXT NOT NULL,
    "nom" TEXT NOT NULL,
    "actif" BOOLEAN NOT NULL DEFAULT true,
    "modules_desactives" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "plan" TEXT,
    "adresse" TEXT,
    "email_contact" TEXT,
    "police_documents" TEXT NOT NULL DEFAULT 'Times New Roman',
    "taille_documents" INTEGER NOT NULL DEFAULT 11,
    "entete_url" TEXT,
    "veille_sujets" TEXT,
    "veille_active" BOOLEAN NOT NULL DEFAULT false,
    "archivage_delai_mois" INTEGER NOT NULL DEFAULT 6,
    "limite_documents_collaborateur_par_mois" INTEGER,
    "limite_documents_cabinet_par_mois" INTEGER,
    "limite_comptes" INTEGER,
    "essai_expire_le" TIMESTAMP(3),
    "licence_id" TEXT,
    "licence_mode_verification" TEXT,
    "licence_date_expiration" TIMESTAMP(3),
    "empreinte_machine_autorisee" TEXT,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "cabinets_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "huissiers" (
    "id" TEXT NOT NULL,
    "cabinet_id" TEXT NOT NULL,
    "nom" TEXT NOT NULL,
    "email" TEXT NOT NULL,
    "telephone" TEXT,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "huissiers_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "users" (
    "id" TEXT NOT NULL,
    "cabinet_id" TEXT NOT NULL,
    "nom" TEXT NOT NULL,
    "email" TEXT NOT NULL,
    "mot_de_passe_hash" TEXT NOT NULL,
    "role" "UserRole" NOT NULL DEFAULT 'collaborateur',
    "responsable_id" TEXT,
    "signature_url" TEXT,
    "partage_signature_actif" BOOLEAN NOT NULL DEFAULT false,
    "acces_tous_dossiers" BOOLEAN NOT NULL DEFAULT false,
    "recoit_veille" BOOLEAN NOT NULL DEFAULT true,
    "actif" BOOLEAN NOT NULL DEFAULT true,
    "last_login_at" TIMESTAMP(3),
    "limite_documents_par_mois" INTEGER,
    "telephone" TEXT,
    "adresse" TEXT,
    "date_arrivee" TIMESTAMP(3),
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "users_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "acces_supplementaires" (
    "id" TEXT NOT NULL,
    "collaborateur_id" TEXT NOT NULL,
    "avocat_id" TEXT NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "acces_supplementaires_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "clients" (
    "id" TEXT NOT NULL,
    "cabinet_id" TEXT NOT NULL,
    "nom" TEXT NOT NULL,
    "email" TEXT,
    "telephone" TEXT,
    "notes" TEXT,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "type_personne" TEXT NOT NULL DEFAULT 'physique',
    "civilite" TEXT,
    "date_naissance" TIMESTAMP(3),
    "lieu_naissance" TEXT,
    "numero_piece_identite" TEXT,
    "quartier_residence" TEXT,
    "rue" TEXT,
    "autre_precision" TEXT,
    "maison" TEXT,
    "situation_matrimoniale" TEXT,
    "fonction" TEXT,
    "entreprise" TEXT,
    "adresse_entreprise" TEXT,

    CONSTRAINT "clients_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "delai_types" (
    "id" TEXT NOT NULL,
    "cabinet_id" TEXT NOT NULL,
    "nom" TEXT NOT NULL,
    "nombre_unites" INTEGER NOT NULL,
    "unite" "UniteDelai" NOT NULL,
    "jours_ouvres_uniquement" BOOLEAN NOT NULL DEFAULT true,
    "texte_reference" TEXT NOT NULL,
    "actif" BOOLEAN NOT NULL DEFAULT true,
    "created_by_id" TEXT NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "delai_types_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "delai_calculs" (
    "id" TEXT NOT NULL,
    "delai_type_id" TEXT NOT NULL,
    "dossier_id" TEXT,
    "date_depart" TIMESTAMP(3) NOT NULL,
    "date_limite" TIMESTAMP(3) NOT NULL,
    "rappel_calendar" BOOLEAN NOT NULL DEFAULT false,
    "created_by_id" TEXT NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "delai_calculs_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "dossiers" (
    "id" TEXT NOT NULL,
    "cabinet_id" TEXT NOT NULL,
    "client_id" TEXT,
    "numero_dossier" TEXT NOT NULL,
    "nom_affaire" TEXT NOT NULL,
    "nom_client" TEXT NOT NULL,
    "nom_juridiction" TEXT,
    "nom_chambre" TEXT,
    "created_by" TEXT NOT NULL,
    "statut" TEXT NOT NULL DEFAULT 'actif',
    "est_recherche" BOOLEAN NOT NULL DEFAULT false,
    "date_cloture" TIMESTAMP(3),
    "archived_at" TIMESTAMP(3),
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "dossiers_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "role_audiences" (
    "id" TEXT NOT NULL,
    "cabinet_id" TEXT NOT NULL,
    "dossier_id" TEXT,
    "date_audience" TIMESTAMP(3) NOT NULL,
    "juridiction" TEXT NOT NULL,
    "chambre" TEXT,
    "procedure_numero" TEXT,
    "parties" TEXT NOT NULL,
    "qualite_procedurale" TEXT,
    "objet_procedure" TEXT,
    "dernier_motif" TEXT,
    "diligences" TEXT,
    "statut" "StatutRoleAudience" NOT NULL DEFAULT 'a_preparer',
    "created_by" TEXT NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "role_audiences_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "factures" (
    "id" TEXT NOT NULL,
    "cabinet_id" TEXT NOT NULL,
    "dossier_id" TEXT,
    "client_nom" TEXT,
    "numero" TEXT NOT NULL,
    "description" TEXT NOT NULL,
    "montant" INTEGER NOT NULL,
    "appliquer_tva" BOOLEAN NOT NULL DEFAULT false,
    "est_proforma" BOOLEAN NOT NULL DEFAULT false,
    "date_emission" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "date_echeance" TIMESTAMP(3),
    "statut" "FactureStatut" NOT NULL DEFAULT 'brouillon',
    "destinataire_email" TEXT,
    "envoye_at" TIMESTAMP(3),
    "payee_at" TIMESTAMP(3),
    "created_by" TEXT NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "factures_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "actions" (
    "id" TEXT NOT NULL,
    "dossier_id" TEXT NOT NULL,
    "type_action" "TypeAction" NOT NULL,
    "canal" "Canal" NOT NULL,
    "contenu_genere" TEXT,
    "date_audience" TIMESTAMP(3),
    "prochaine_audience" TIMESTAMP(3),
    "pieces_prevoir" TEXT,
    "ignorer_suggestion_role" BOOLEAN NOT NULL DEFAULT false,
    "statut" "StatutAction" NOT NULL DEFAULT 'brouillon',
    "document_url" TEXT,
    "document_id" TEXT,
    "destinataire_email" TEXT,
    "envoye_at" TIMESTAMP(3),
    "champs_formulaire" JSONB,
    "champs_document" JSONB,
    "donnees_pseudonymisees" BOOLEAN NOT NULL DEFAULT false,
    "nom_document" TEXT,
    "created_by" TEXT NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "verrouille_par" TEXT,
    "verrouille_le" TIMESTAMP(3),
    "version_actuelle" INTEGER NOT NULL DEFAULT 0,
    "mode_creation" TEXT NOT NULL DEFAULT 'genere_ia',

    CONSTRAINT "actions_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "action_versions" (
    "id" TEXT NOT NULL,
    "action_id" TEXT NOT NULL,
    "numero" INTEGER NOT NULL,
    "contenu" TEXT NOT NULL,
    "auteur_id" TEXT NOT NULL,
    "est_version_validee" BOOLEAN NOT NULL DEFAULT false,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "action_versions_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "commentaires_revision" (
    "id" TEXT NOT NULL,
    "action_id" TEXT NOT NULL,
    "auteur_id" TEXT NOT NULL,
    "contenu" TEXT NOT NULL,
    "statut" TEXT NOT NULL DEFAULT 'ouvert',
    "date_creation" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "date_resolution" TIMESTAMP(3),
    "resolu_par_id" TEXT,

    CONSTRAINT "commentaires_revision_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "audit_logs" (
    "id" TEXT NOT NULL,
    "action_id" TEXT NOT NULL,
    "etape" TEXT NOT NULL,
    "statut" "StatutExecution" NOT NULL,
    "detail" TEXT,
    "timestamp" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "audit_logs_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "jurisprudence_chunks" (
    "id" TEXT NOT NULL,
    "source" TEXT NOT NULL,
    "reference" TEXT NOT NULL,
    "juridiction" TEXT,
    "date_decision" TEXT,
    "contenu" TEXT NOT NULL,
    "embedding" vector,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "jurisprudence_chunks_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "huissiers_cabinet_id_idx" ON "huissiers"("cabinet_id");

-- CreateIndex
CREATE UNIQUE INDEX "users_email_key" ON "users"("email");

-- CreateIndex
CREATE INDEX "users_cabinet_id_idx" ON "users"("cabinet_id");

-- CreateIndex
CREATE UNIQUE INDEX "acces_supplementaires_collaborateur_id_avocat_id_key" ON "acces_supplementaires"("collaborateur_id", "avocat_id");

-- CreateIndex
CREATE INDEX "clients_cabinet_id_idx" ON "clients"("cabinet_id");

-- CreateIndex
CREATE INDEX "delai_types_cabinet_id_idx" ON "delai_types"("cabinet_id");

-- CreateIndex
CREATE INDEX "delai_calculs_dossier_id_idx" ON "delai_calculs"("dossier_id");

-- CreateIndex
CREATE INDEX "dossiers_client_id_idx" ON "dossiers"("client_id");

-- CreateIndex
CREATE INDEX "dossiers_archived_at_idx" ON "dossiers"("archived_at");

-- CreateIndex
CREATE UNIQUE INDEX "dossiers_cabinet_id_numero_dossier_key" ON "dossiers"("cabinet_id", "numero_dossier");

-- CreateIndex
CREATE INDEX "role_audiences_cabinet_id_idx" ON "role_audiences"("cabinet_id");

-- CreateIndex
CREATE INDEX "role_audiences_dossier_id_idx" ON "role_audiences"("dossier_id");

-- CreateIndex
CREATE INDEX "factures_dossier_id_idx" ON "factures"("dossier_id");

-- CreateIndex
CREATE UNIQUE INDEX "factures_cabinet_id_numero_key" ON "factures"("cabinet_id", "numero");

-- CreateIndex
CREATE INDEX "actions_dossier_id_idx" ON "actions"("dossier_id");

-- CreateIndex
CREATE INDEX "actions_created_by_idx" ON "actions"("created_by");

-- CreateIndex
CREATE INDEX "action_versions_action_id_idx" ON "action_versions"("action_id");

-- CreateIndex
CREATE INDEX "commentaires_revision_action_id_idx" ON "commentaires_revision"("action_id");

-- CreateIndex
CREATE INDEX "audit_logs_action_id_idx" ON "audit_logs"("action_id");

-- AddForeignKey
ALTER TABLE "huissiers" ADD CONSTRAINT "huissiers_cabinet_id_fkey" FOREIGN KEY ("cabinet_id") REFERENCES "cabinets"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "users" ADD CONSTRAINT "users_cabinet_id_fkey" FOREIGN KEY ("cabinet_id") REFERENCES "cabinets"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "users" ADD CONSTRAINT "users_responsable_id_fkey" FOREIGN KEY ("responsable_id") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "acces_supplementaires" ADD CONSTRAINT "acces_supplementaires_collaborateur_id_fkey" FOREIGN KEY ("collaborateur_id") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "acces_supplementaires" ADD CONSTRAINT "acces_supplementaires_avocat_id_fkey" FOREIGN KEY ("avocat_id") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "clients" ADD CONSTRAINT "clients_cabinet_id_fkey" FOREIGN KEY ("cabinet_id") REFERENCES "cabinets"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "delai_types" ADD CONSTRAINT "delai_types_cabinet_id_fkey" FOREIGN KEY ("cabinet_id") REFERENCES "cabinets"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "delai_types" ADD CONSTRAINT "delai_types_created_by_id_fkey" FOREIGN KEY ("created_by_id") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "delai_calculs" ADD CONSTRAINT "delai_calculs_delai_type_id_fkey" FOREIGN KEY ("delai_type_id") REFERENCES "delai_types"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "delai_calculs" ADD CONSTRAINT "delai_calculs_dossier_id_fkey" FOREIGN KEY ("dossier_id") REFERENCES "dossiers"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "delai_calculs" ADD CONSTRAINT "delai_calculs_created_by_id_fkey" FOREIGN KEY ("created_by_id") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "dossiers" ADD CONSTRAINT "dossiers_cabinet_id_fkey" FOREIGN KEY ("cabinet_id") REFERENCES "cabinets"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "dossiers" ADD CONSTRAINT "dossiers_client_id_fkey" FOREIGN KEY ("client_id") REFERENCES "clients"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "dossiers" ADD CONSTRAINT "dossiers_created_by_fkey" FOREIGN KEY ("created_by") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "role_audiences" ADD CONSTRAINT "role_audiences_cabinet_id_fkey" FOREIGN KEY ("cabinet_id") REFERENCES "cabinets"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "role_audiences" ADD CONSTRAINT "role_audiences_dossier_id_fkey" FOREIGN KEY ("dossier_id") REFERENCES "dossiers"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "role_audiences" ADD CONSTRAINT "role_audiences_created_by_fkey" FOREIGN KEY ("created_by") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "factures" ADD CONSTRAINT "factures_cabinet_id_fkey" FOREIGN KEY ("cabinet_id") REFERENCES "cabinets"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "factures" ADD CONSTRAINT "factures_dossier_id_fkey" FOREIGN KEY ("dossier_id") REFERENCES "dossiers"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "factures" ADD CONSTRAINT "factures_created_by_fkey" FOREIGN KEY ("created_by") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "actions" ADD CONSTRAINT "actions_dossier_id_fkey" FOREIGN KEY ("dossier_id") REFERENCES "dossiers"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "actions" ADD CONSTRAINT "actions_created_by_fkey" FOREIGN KEY ("created_by") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "actions" ADD CONSTRAINT "actions_verrouille_par_fkey" FOREIGN KEY ("verrouille_par") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "action_versions" ADD CONSTRAINT "action_versions_action_id_fkey" FOREIGN KEY ("action_id") REFERENCES "actions"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "action_versions" ADD CONSTRAINT "action_versions_auteur_id_fkey" FOREIGN KEY ("auteur_id") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "commentaires_revision" ADD CONSTRAINT "commentaires_revision_action_id_fkey" FOREIGN KEY ("action_id") REFERENCES "actions"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "commentaires_revision" ADD CONSTRAINT "commentaires_revision_auteur_id_fkey" FOREIGN KEY ("auteur_id") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "commentaires_revision" ADD CONSTRAINT "commentaires_revision_resolu_par_id_fkey" FOREIGN KEY ("resolu_par_id") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "audit_logs" ADD CONSTRAINT "audit_logs_action_id_fkey" FOREIGN KEY ("action_id") REFERENCES "actions"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

