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

-- CreateEnum
CREATE TYPE "TypeEvenement" AS ENUM ('audience', 'rdv', 'appel', 'tache', 'echeance_procedure', 'autre');

-- CreateEnum
CREATE TYPE "SourceEvenement" AS ENUM ('manuel', 'role_audience', 'delai_calcule', 'sync_google', 'sync_caldav', 'email');

-- CreateEnum
CREATE TYPE "NatureCourrier" AS ENUM ('correspondance', 'convocation', 'assignation', 'signification', 'mise_en_demeure', 'courrier_client', 'courrier_juridiction', 'courrier_confrere', 'courrier_administratif', 'autre');

-- CreateEnum
CREATE TYPE "ModeCourrier" AS ENUM ('main_propre', 'courrier_postal', 'huissier', 'email', 'fax', 'autre');

-- CreateEnum
CREATE TYPE "StatutCourrierEntrant" AS ENUM ('recu', 'a_affecter', 'affecte', 'en_traitement', 'traite', 'classe');

-- CreateEnum
CREATE TYPE "StatutCourrierSortant" AS ENUM ('brouillon', 'envoye', 'classe');

-- CreateEnum
CREATE TYPE "OcrStatut" AS ENUM ('en_attente', 'en_cours', 'termine', 'echec');

-- CreateEnum
CREATE TYPE "ProviderEmailExterne" AS ENUM ('gmail', 'imap');

-- CreateEnum
CREATE TYPE "StatutEmailImporte" AS ENUM ('nouveau', 'traite');

-- CreateEnum
CREATE TYPE "ProviderCalendrierExterne" AS ENUM ('google', 'caldav');

-- CreateEnum
CREATE TYPE "StatutSyncExterne" AS ENUM ('en_attente', 'synchronise', 'erreur', 'a_supprimer');

-- CreateEnum
CREATE TYPE "SourceSaisieTemps" AS ENUM ('chrono', 'manuel');

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
    "taille_documents" INTEGER NOT NULL DEFAULT 13,
    "entete_url" TEXT,
    "veille_sujets" TEXT,
    "veille_active" BOOLEAN NOT NULL DEFAULT false,
    "veille_derniere_execution" TIMESTAMP(3),
    "role_semaine_derniere_execution" TIMESTAMP(3),
    "archivage_delai_mois" INTEGER NOT NULL DEFAULT 6,
    "limite_documents_collaborateur_par_mois" INTEGER,
    "limite_documents_cabinet_par_mois" INTEGER,
    "limite_comptes" INTEGER,
    "limite_avocats" INTEGER,
    "limite_collaborateurs" INTEGER,
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
    "reset_code_hash" TEXT,
    "reset_code_expires_at" TIMESTAMP(3),
    "role" "UserRole" NOT NULL DEFAULT 'collaborateur',
    "responsable_id" TEXT,
    "signature_url" TEXT,
    "partage_signature_actif" BOOLEAN NOT NULL DEFAULT false,
    "acces_tous_dossiers" BOOLEAN NOT NULL DEFAULT false,
    "modules_desactives" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "recoit_veille" BOOLEAN NOT NULL DEFAULT true,
    "veille_derniere_vue" TIMESTAMP(3),
    "actif" BOOLEAN NOT NULL DEFAULT true,
    "last_login_at" TIMESTAMP(3),
    "limite_documents_par_mois" INTEGER,
    "telephone" TEXT,
    "adresse" TEXT,
    "date_arrivee" TIMESTAMP(3),
    "taux_horaire_defaut" INTEGER,
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
    "courrier_entrant_id" TEXT,

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
CREATE TABLE "documents_dossier" (
    "id" TEXT NOT NULL,
    "cabinet_id" TEXT NOT NULL,
    "dossier_id" TEXT NOT NULL,
    "nom_original" TEXT NOT NULL,
    "type_mime" TEXT NOT NULL,
    "taille_octets" INTEGER NOT NULL,
    "nom_fichier" TEXT NOT NULL,
    "source" TEXT NOT NULL DEFAULT 'upload',
    "email_origine_id" TEXT,
    "courrier_entrant_id" TEXT,
    "courrier_sortant_id" TEXT,
    "uploade_par_id" TEXT NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "documents_dossier_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ocr_resultats" (
    "id" TEXT NOT NULL,
    "document_id" TEXT NOT NULL,
    "cabinet_id" TEXT NOT NULL,
    "dossier_id" TEXT NOT NULL,
    "statut" "OcrStatut" NOT NULL DEFAULT 'en_attente',
    "moteur" TEXT NOT NULL DEFAULT 'tesseract',
    "texte_extrait" TEXT,
    "score_confiance" DOUBLE PRECISION,
    "message_erreur" TEXT,
    "tentatives" INTEGER NOT NULL DEFAULT 0,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "ocr_resultats_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "connexions_email_externe" (
    "id" TEXT NOT NULL,
    "user_id" TEXT NOT NULL,
    "provider" "ProviderEmailExterne" NOT NULL,
    "access_token" TEXT,
    "refresh_token" TEXT,
    "token_expires_at" TIMESTAMP(3),
    "adresse_email" TEXT,
    "imap_host" TEXT,
    "imap_port" INTEGER,
    "imap_secure" BOOLEAN NOT NULL DEFAULT true,
    "imap_username" TEXT,
    "imap_password" TEXT,
    "smtp_host" TEXT,
    "smtp_port" INTEGER,
    "smtp_secure" BOOLEAN NOT NULL DEFAULT false,
    "dernier_identifiant_synchronise" TEXT,
    "actif" BOOLEAN NOT NULL DEFAULT true,
    "derniere_erreur" TEXT,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "connexions_email_externe_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "emails_importes" (
    "id" TEXT NOT NULL,
    "connexion_id" TEXT NOT NULL,
    "cabinet_id" TEXT NOT NULL,
    "identifiant_externe" TEXT NOT NULL,
    "expediteur_email" TEXT NOT NULL,
    "expediteur_nom" TEXT,
    "objet" TEXT,
    "date_reception" TIMESTAMP(3) NOT NULL,
    "pieces_jointes" JSONB,
    "date_detectee" TIMESTAMP(3),
    "date_detectee_contexte" TEXT,
    "statut" "StatutEmailImporte" NOT NULL DEFAULT 'nouveau',
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "emails_importes_pkey" PRIMARY KEY ("id")
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
CREATE TABLE "evenements" (
    "id" TEXT NOT NULL,
    "cabinet_id" TEXT NOT NULL,
    "dossier_id" TEXT,
    "type" "TypeEvenement" NOT NULL,
    "source" "SourceEvenement" NOT NULL DEFAULT 'manuel',
    "titre" TEXT NOT NULL,
    "description" TEXT,
    "date_debut" TIMESTAMP(3) NOT NULL,
    "date_fin" TIMESTAMP(3),
    "toute_la_journee" BOOLEAN NOT NULL DEFAULT false,
    "lieu" TEXT,
    "created_by_id" TEXT NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,
    "role_audience_id" TEXT,
    "delai_calcul_id" TEXT,

    CONSTRAINT "evenements_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "evenement_assignes" (
    "evenement_id" TEXT NOT NULL,
    "user_id" TEXT NOT NULL,

    CONSTRAINT "evenement_assignes_pkey" PRIMARY KEY ("evenement_id","user_id")
);

-- CreateTable
CREATE TABLE "connexions_calendrier_externe" (
    "id" TEXT NOT NULL,
    "user_id" TEXT NOT NULL,
    "provider" "ProviderCalendrierExterne" NOT NULL,
    "access_token" TEXT,
    "refresh_token" TEXT,
    "token_expires_at" TIMESTAMP(3),
    "caldav_url" TEXT,
    "caldav_username" TEXT,
    "caldav_password" TEXT,
    "calendrier_url" TEXT,
    "actif" BOOLEAN NOT NULL DEFAULT true,
    "derniere_erreur" TEXT,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "connexions_calendrier_externe_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "evenement_sync_externe" (
    "id" TEXT NOT NULL,
    "evenement_id" TEXT,
    "connexion_id" TEXT NOT NULL,
    "external_event_id" TEXT,
    "statut" "StatutSyncExterne" NOT NULL DEFAULT 'en_attente',
    "tentatives" INTEGER NOT NULL DEFAULT 0,
    "derniere_erreur" TEXT,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "evenement_sync_externe_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "saisies_temps" (
    "id" TEXT NOT NULL,
    "cabinet_id" TEXT NOT NULL,
    "dossier_id" TEXT NOT NULL,
    "action_id" TEXT,
    "user_id" TEXT NOT NULL,
    "source" "SourceSaisieTemps" NOT NULL DEFAULT 'manuel',
    "date" TIMESTAMP(3) NOT NULL,
    "demarre_a" TIMESTAMP(3),
    "arrete_a" TIMESTAMP(3),
    "duree_accumulee_secondes" INTEGER NOT NULL DEFAULT 0,
    "duree_minutes" INTEGER,
    "description" TEXT,
    "facturable" BOOLEAN NOT NULL DEFAULT true,
    "taux_horaire_applique" INTEGER,
    "facture_id" TEXT,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "saisies_temps_pkey" PRIMARY KEY ("id")
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
    "facture_normalisee_numero" TEXT,
    "facture_normalisee_date_paiement" TIMESTAMP(3),
    "facture_normalisee_nom_fichier" TEXT,
    "facture_normalisee_nom_original" TEXT,
    "facture_normalisee_taille_octets" INTEGER,
    "facture_normalisee_ajoutee_at" TIMESTAMP(3),

    CONSTRAINT "factures_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "facture_rappels_ignores" (
    "id" TEXT NOT NULL,
    "facture_id" TEXT NOT NULL,
    "user_id" TEXT NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "facture_rappels_ignores_pkey" PRIMARY KEY ("id")
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
    "courrier_entrant_id" TEXT,

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
CREATE TABLE "action_versions_fichier" (
    "id" TEXT NOT NULL,
    "action_id" TEXT NOT NULL,
    "numero" INTEGER NOT NULL,
    "nom_original" TEXT NOT NULL,
    "type_mime" TEXT NOT NULL,
    "taille_octets" INTEGER NOT NULL,
    "nom_fichier" TEXT NOT NULL,
    "auteur_id" TEXT NOT NULL,
    "est_version_validee" BOOLEAN NOT NULL DEFAULT false,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "action_versions_fichier_pkey" PRIMARY KEY ("id")
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
    "action_id" TEXT,
    "courrier_entrant_id" TEXT,
    "courrier_sortant_id" TEXT,
    "etape" TEXT NOT NULL,
    "statut" "StatutExecution" NOT NULL,
    "detail" TEXT,
    "timestamp" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "audit_logs_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "sequences_courrier" (
    "id" TEXT NOT NULL,
    "cabinet_id" TEXT NOT NULL,
    "annee" INTEGER NOT NULL,
    "sens" TEXT NOT NULL,
    "dernier_numero" INTEGER NOT NULL DEFAULT 0,

    CONSTRAINT "sequences_courrier_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "courrier_pieces_jointes" (
    "id" TEXT NOT NULL,
    "cabinet_id" TEXT NOT NULL,
    "courrier_entrant_id" TEXT,
    "courrier_sortant_id" TEXT,
    "nom_original" TEXT NOT NULL,
    "type_mime" TEXT NOT NULL,
    "taille_octets" INTEGER NOT NULL,
    "nom_fichier" TEXT NOT NULL,
    "uploade_par_id" TEXT NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "courrier_pieces_jointes_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "courriers_entrants" (
    "id" TEXT NOT NULL,
    "cabinet_id" TEXT NOT NULL,
    "numero" TEXT NOT NULL,
    "objet" TEXT NOT NULL,
    "nature" "NatureCourrier",
    "expediteur" TEXT,
    "date_courrier" TIMESTAMP(3),
    "date_reception" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "mode_reception" "ModeCourrier",
    "receptionne_par_id" TEXT NOT NULL,
    "client_id" TEXT,
    "dossier_id" TEXT,
    "observations" TEXT,
    "statut" "StatutCourrierEntrant" NOT NULL DEFAULT 'recu',
    "affecte_a_id" TEXT,
    "affecte_at" TIMESTAMP(3),
    "classe_at" TIMESTAMP(3),
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "courriers_entrants_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "courriers_sortants" (
    "id" TEXT NOT NULL,
    "cabinet_id" TEXT NOT NULL,
    "numero" TEXT NOT NULL,
    "objet" TEXT NOT NULL,
    "nature" "NatureCourrier",
    "destinataire" TEXT,
    "date_courrier" TIMESTAMP(3),
    "date_envoi" TIMESTAMP(3),
    "mode_envoi" "ModeCourrier",
    "client_id" TEXT,
    "dossier_id" TEXT,
    "observations" TEXT,
    "statut" "StatutCourrierSortant" NOT NULL DEFAULT 'brouillon',
    "reponse_a_id" TEXT,
    "redige_par_id" TEXT NOT NULL,
    "classe_at" TIMESTAMP(3),
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "courriers_sortants_pkey" PRIMARY KEY ("id")
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
    "lien" TEXT,
    "groupe_id" TEXT,

    CONSTRAINT "jurisprudence_chunks_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "jurisprudence_pdfs" (
    "groupe_id" TEXT NOT NULL,
    "nom_fichier" TEXT NOT NULL,
    "nom_original" TEXT NOT NULL,
    "taille_octets" INTEGER NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "jurisprudence_pdfs_pkey" PRIMARY KEY ("groupe_id")
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
CREATE INDEX "delai_calculs_courrier_entrant_id_idx" ON "delai_calculs"("courrier_entrant_id");

-- CreateIndex
CREATE INDEX "dossiers_client_id_idx" ON "dossiers"("client_id");

-- CreateIndex
CREATE INDEX "dossiers_archived_at_idx" ON "dossiers"("archived_at");

-- CreateIndex
CREATE UNIQUE INDEX "dossiers_cabinet_id_numero_dossier_key" ON "dossiers"("cabinet_id", "numero_dossier");

-- CreateIndex
CREATE INDEX "documents_dossier_dossier_id_idx" ON "documents_dossier"("dossier_id");

-- CreateIndex
CREATE INDEX "documents_dossier_cabinet_id_idx" ON "documents_dossier"("cabinet_id");

-- CreateIndex
CREATE UNIQUE INDEX "ocr_resultats_document_id_key" ON "ocr_resultats"("document_id");

-- CreateIndex
CREATE INDEX "ocr_resultats_dossier_id_idx" ON "ocr_resultats"("dossier_id");

-- CreateIndex
CREATE INDEX "ocr_resultats_cabinet_id_idx" ON "ocr_resultats"("cabinet_id");

-- CreateIndex
CREATE INDEX "ocr_resultats_statut_idx" ON "ocr_resultats"("statut");

-- CreateIndex
CREATE UNIQUE INDEX "connexions_email_externe_user_id_provider_key" ON "connexions_email_externe"("user_id", "provider");

-- CreateIndex
CREATE INDEX "emails_importes_cabinet_id_idx" ON "emails_importes"("cabinet_id");

-- CreateIndex
CREATE UNIQUE INDEX "emails_importes_connexion_id_identifiant_externe_key" ON "emails_importes"("connexion_id", "identifiant_externe");

-- CreateIndex
CREATE INDEX "role_audiences_cabinet_id_idx" ON "role_audiences"("cabinet_id");

-- CreateIndex
CREATE INDEX "role_audiences_dossier_id_idx" ON "role_audiences"("dossier_id");

-- CreateIndex
CREATE UNIQUE INDEX "evenements_role_audience_id_key" ON "evenements"("role_audience_id");

-- CreateIndex
CREATE UNIQUE INDEX "evenements_delai_calcul_id_key" ON "evenements"("delai_calcul_id");

-- CreateIndex
CREATE INDEX "evenements_cabinet_id_date_debut_idx" ON "evenements"("cabinet_id", "date_debut");

-- CreateIndex
CREATE INDEX "evenements_dossier_id_idx" ON "evenements"("dossier_id");

-- CreateIndex
CREATE UNIQUE INDEX "connexions_calendrier_externe_user_id_provider_key" ON "connexions_calendrier_externe"("user_id", "provider");

-- CreateIndex
CREATE INDEX "evenement_sync_externe_statut_idx" ON "evenement_sync_externe"("statut");

-- CreateIndex
CREATE UNIQUE INDEX "evenement_sync_externe_evenement_id_connexion_id_key" ON "evenement_sync_externe"("evenement_id", "connexion_id");

-- CreateIndex
CREATE INDEX "saisies_temps_cabinet_id_idx" ON "saisies_temps"("cabinet_id");

-- CreateIndex
CREATE INDEX "saisies_temps_dossier_id_idx" ON "saisies_temps"("dossier_id");

-- CreateIndex
CREATE INDEX "saisies_temps_user_id_idx" ON "saisies_temps"("user_id");

-- CreateIndex
CREATE INDEX "saisies_temps_facture_id_idx" ON "saisies_temps"("facture_id");

-- CreateIndex
CREATE INDEX "factures_dossier_id_idx" ON "factures"("dossier_id");

-- CreateIndex
CREATE UNIQUE INDEX "factures_cabinet_id_numero_key" ON "factures"("cabinet_id", "numero");

-- CreateIndex
CREATE UNIQUE INDEX "facture_rappels_ignores_facture_id_user_id_key" ON "facture_rappels_ignores"("facture_id", "user_id");

-- CreateIndex
CREATE INDEX "actions_dossier_id_idx" ON "actions"("dossier_id");

-- CreateIndex
CREATE INDEX "actions_created_by_idx" ON "actions"("created_by");

-- CreateIndex
CREATE INDEX "actions_courrier_entrant_id_idx" ON "actions"("courrier_entrant_id");

-- CreateIndex
CREATE INDEX "action_versions_action_id_idx" ON "action_versions"("action_id");

-- CreateIndex
CREATE INDEX "action_versions_fichier_action_id_idx" ON "action_versions_fichier"("action_id");

-- CreateIndex
CREATE INDEX "commentaires_revision_action_id_idx" ON "commentaires_revision"("action_id");

-- CreateIndex
CREATE INDEX "audit_logs_action_id_idx" ON "audit_logs"("action_id");

-- CreateIndex
CREATE INDEX "audit_logs_courrier_entrant_id_idx" ON "audit_logs"("courrier_entrant_id");

-- CreateIndex
CREATE INDEX "audit_logs_courrier_sortant_id_idx" ON "audit_logs"("courrier_sortant_id");

-- CreateIndex
CREATE UNIQUE INDEX "sequences_courrier_cabinet_id_annee_sens_key" ON "sequences_courrier"("cabinet_id", "annee", "sens");

-- CreateIndex
CREATE INDEX "courriers_entrants_cabinet_id_statut_idx" ON "courriers_entrants"("cabinet_id", "statut");

-- CreateIndex
CREATE INDEX "courriers_entrants_dossier_id_idx" ON "courriers_entrants"("dossier_id");

-- CreateIndex
CREATE INDEX "courriers_entrants_client_id_idx" ON "courriers_entrants"("client_id");

-- CreateIndex
CREATE UNIQUE INDEX "courriers_entrants_cabinet_id_numero_key" ON "courriers_entrants"("cabinet_id", "numero");

-- CreateIndex
CREATE INDEX "courriers_sortants_cabinet_id_statut_idx" ON "courriers_sortants"("cabinet_id", "statut");

-- CreateIndex
CREATE INDEX "courriers_sortants_dossier_id_idx" ON "courriers_sortants"("dossier_id");

-- CreateIndex
CREATE INDEX "courriers_sortants_client_id_idx" ON "courriers_sortants"("client_id");

-- CreateIndex
CREATE INDEX "courriers_sortants_reponse_a_id_idx" ON "courriers_sortants"("reponse_a_id");

-- CreateIndex
CREATE UNIQUE INDEX "courriers_sortants_cabinet_id_numero_key" ON "courriers_sortants"("cabinet_id", "numero");

-- CreateIndex
CREATE INDEX "jurisprudence_chunks_groupe_id_idx" ON "jurisprudence_chunks"("groupe_id");

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
ALTER TABLE "delai_calculs" ADD CONSTRAINT "delai_calculs_courrier_entrant_id_fkey" FOREIGN KEY ("courrier_entrant_id") REFERENCES "courriers_entrants"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "dossiers" ADD CONSTRAINT "dossiers_cabinet_id_fkey" FOREIGN KEY ("cabinet_id") REFERENCES "cabinets"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "dossiers" ADD CONSTRAINT "dossiers_client_id_fkey" FOREIGN KEY ("client_id") REFERENCES "clients"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "dossiers" ADD CONSTRAINT "dossiers_created_by_fkey" FOREIGN KEY ("created_by") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "documents_dossier" ADD CONSTRAINT "documents_dossier_cabinet_id_fkey" FOREIGN KEY ("cabinet_id") REFERENCES "cabinets"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "documents_dossier" ADD CONSTRAINT "documents_dossier_dossier_id_fkey" FOREIGN KEY ("dossier_id") REFERENCES "dossiers"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "documents_dossier" ADD CONSTRAINT "documents_dossier_uploade_par_id_fkey" FOREIGN KEY ("uploade_par_id") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "documents_dossier" ADD CONSTRAINT "documents_dossier_email_origine_id_fkey" FOREIGN KEY ("email_origine_id") REFERENCES "emails_importes"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "documents_dossier" ADD CONSTRAINT "documents_dossier_courrier_entrant_id_fkey" FOREIGN KEY ("courrier_entrant_id") REFERENCES "courriers_entrants"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "documents_dossier" ADD CONSTRAINT "documents_dossier_courrier_sortant_id_fkey" FOREIGN KEY ("courrier_sortant_id") REFERENCES "courriers_sortants"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ocr_resultats" ADD CONSTRAINT "ocr_resultats_document_id_fkey" FOREIGN KEY ("document_id") REFERENCES "documents_dossier"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "connexions_email_externe" ADD CONSTRAINT "connexions_email_externe_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "emails_importes" ADD CONSTRAINT "emails_importes_connexion_id_fkey" FOREIGN KEY ("connexion_id") REFERENCES "connexions_email_externe"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "role_audiences" ADD CONSTRAINT "role_audiences_cabinet_id_fkey" FOREIGN KEY ("cabinet_id") REFERENCES "cabinets"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "role_audiences" ADD CONSTRAINT "role_audiences_dossier_id_fkey" FOREIGN KEY ("dossier_id") REFERENCES "dossiers"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "role_audiences" ADD CONSTRAINT "role_audiences_created_by_fkey" FOREIGN KEY ("created_by") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "evenements" ADD CONSTRAINT "evenements_cabinet_id_fkey" FOREIGN KEY ("cabinet_id") REFERENCES "cabinets"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "evenements" ADD CONSTRAINT "evenements_dossier_id_fkey" FOREIGN KEY ("dossier_id") REFERENCES "dossiers"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "evenements" ADD CONSTRAINT "evenements_created_by_id_fkey" FOREIGN KEY ("created_by_id") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "evenements" ADD CONSTRAINT "evenements_role_audience_id_fkey" FOREIGN KEY ("role_audience_id") REFERENCES "role_audiences"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "evenements" ADD CONSTRAINT "evenements_delai_calcul_id_fkey" FOREIGN KEY ("delai_calcul_id") REFERENCES "delai_calculs"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "evenement_assignes" ADD CONSTRAINT "evenement_assignes_evenement_id_fkey" FOREIGN KEY ("evenement_id") REFERENCES "evenements"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "evenement_assignes" ADD CONSTRAINT "evenement_assignes_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "connexions_calendrier_externe" ADD CONSTRAINT "connexions_calendrier_externe_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "evenement_sync_externe" ADD CONSTRAINT "evenement_sync_externe_evenement_id_fkey" FOREIGN KEY ("evenement_id") REFERENCES "evenements"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "evenement_sync_externe" ADD CONSTRAINT "evenement_sync_externe_connexion_id_fkey" FOREIGN KEY ("connexion_id") REFERENCES "connexions_calendrier_externe"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "saisies_temps" ADD CONSTRAINT "saisies_temps_cabinet_id_fkey" FOREIGN KEY ("cabinet_id") REFERENCES "cabinets"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "saisies_temps" ADD CONSTRAINT "saisies_temps_dossier_id_fkey" FOREIGN KEY ("dossier_id") REFERENCES "dossiers"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "saisies_temps" ADD CONSTRAINT "saisies_temps_action_id_fkey" FOREIGN KEY ("action_id") REFERENCES "actions"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "saisies_temps" ADD CONSTRAINT "saisies_temps_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "saisies_temps" ADD CONSTRAINT "saisies_temps_facture_id_fkey" FOREIGN KEY ("facture_id") REFERENCES "factures"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "factures" ADD CONSTRAINT "factures_cabinet_id_fkey" FOREIGN KEY ("cabinet_id") REFERENCES "cabinets"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "factures" ADD CONSTRAINT "factures_dossier_id_fkey" FOREIGN KEY ("dossier_id") REFERENCES "dossiers"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "factures" ADD CONSTRAINT "factures_created_by_fkey" FOREIGN KEY ("created_by") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "facture_rappels_ignores" ADD CONSTRAINT "facture_rappels_ignores_facture_id_fkey" FOREIGN KEY ("facture_id") REFERENCES "factures"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "facture_rappels_ignores" ADD CONSTRAINT "facture_rappels_ignores_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "actions" ADD CONSTRAINT "actions_dossier_id_fkey" FOREIGN KEY ("dossier_id") REFERENCES "dossiers"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "actions" ADD CONSTRAINT "actions_created_by_fkey" FOREIGN KEY ("created_by") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "actions" ADD CONSTRAINT "actions_verrouille_par_fkey" FOREIGN KEY ("verrouille_par") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "actions" ADD CONSTRAINT "actions_courrier_entrant_id_fkey" FOREIGN KEY ("courrier_entrant_id") REFERENCES "courriers_entrants"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "action_versions" ADD CONSTRAINT "action_versions_action_id_fkey" FOREIGN KEY ("action_id") REFERENCES "actions"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "action_versions" ADD CONSTRAINT "action_versions_auteur_id_fkey" FOREIGN KEY ("auteur_id") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "action_versions_fichier" ADD CONSTRAINT "action_versions_fichier_action_id_fkey" FOREIGN KEY ("action_id") REFERENCES "actions"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "action_versions_fichier" ADD CONSTRAINT "action_versions_fichier_auteur_id_fkey" FOREIGN KEY ("auteur_id") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "commentaires_revision" ADD CONSTRAINT "commentaires_revision_action_id_fkey" FOREIGN KEY ("action_id") REFERENCES "actions"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "commentaires_revision" ADD CONSTRAINT "commentaires_revision_auteur_id_fkey" FOREIGN KEY ("auteur_id") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "commentaires_revision" ADD CONSTRAINT "commentaires_revision_resolu_par_id_fkey" FOREIGN KEY ("resolu_par_id") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "audit_logs" ADD CONSTRAINT "audit_logs_action_id_fkey" FOREIGN KEY ("action_id") REFERENCES "actions"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "audit_logs" ADD CONSTRAINT "audit_logs_courrier_entrant_id_fkey" FOREIGN KEY ("courrier_entrant_id") REFERENCES "courriers_entrants"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "audit_logs" ADD CONSTRAINT "audit_logs_courrier_sortant_id_fkey" FOREIGN KEY ("courrier_sortant_id") REFERENCES "courriers_sortants"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "sequences_courrier" ADD CONSTRAINT "sequences_courrier_cabinet_id_fkey" FOREIGN KEY ("cabinet_id") REFERENCES "cabinets"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "courrier_pieces_jointes" ADD CONSTRAINT "courrier_pieces_jointes_courrier_entrant_id_fkey" FOREIGN KEY ("courrier_entrant_id") REFERENCES "courriers_entrants"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "courrier_pieces_jointes" ADD CONSTRAINT "courrier_pieces_jointes_courrier_sortant_id_fkey" FOREIGN KEY ("courrier_sortant_id") REFERENCES "courriers_sortants"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "courriers_entrants" ADD CONSTRAINT "courriers_entrants_cabinet_id_fkey" FOREIGN KEY ("cabinet_id") REFERENCES "cabinets"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "courriers_entrants" ADD CONSTRAINT "courriers_entrants_receptionne_par_id_fkey" FOREIGN KEY ("receptionne_par_id") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "courriers_entrants" ADD CONSTRAINT "courriers_entrants_affecte_a_id_fkey" FOREIGN KEY ("affecte_a_id") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "courriers_entrants" ADD CONSTRAINT "courriers_entrants_client_id_fkey" FOREIGN KEY ("client_id") REFERENCES "clients"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "courriers_entrants" ADD CONSTRAINT "courriers_entrants_dossier_id_fkey" FOREIGN KEY ("dossier_id") REFERENCES "dossiers"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "courriers_sortants" ADD CONSTRAINT "courriers_sortants_cabinet_id_fkey" FOREIGN KEY ("cabinet_id") REFERENCES "cabinets"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "courriers_sortants" ADD CONSTRAINT "courriers_sortants_redige_par_id_fkey" FOREIGN KEY ("redige_par_id") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "courriers_sortants" ADD CONSTRAINT "courriers_sortants_client_id_fkey" FOREIGN KEY ("client_id") REFERENCES "clients"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "courriers_sortants" ADD CONSTRAINT "courriers_sortants_dossier_id_fkey" FOREIGN KEY ("dossier_id") REFERENCES "dossiers"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "courriers_sortants" ADD CONSTRAINT "courriers_sortants_reponse_a_id_fkey" FOREIGN KEY ("reponse_a_id") REFERENCES "courriers_entrants"("id") ON DELETE SET NULL ON UPDATE CASCADE;

