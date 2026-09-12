-- Lot 20 - registre de gestion des courriers (entrants/sortants), numerotation
-- sequentielle par annee/sens (sequences_courrier), piece jointe temporaire
-- pour un courrier sans dossier encore attache (courrier_pieces_jointes), et
-- extension additive du Journal d'audit existant (audit_logs.action_id
-- devient facultatif, deux nouvelles colonnes courrier_entrant_id/
-- courrier_sortant_id) - AUCUN impact sur les lignes existantes (elles
-- gardent leur action_id). Migration entierement additive : aucune table ni
-- colonne existante n'est supprimee ou retrecie.
--
-- Application manuelle (mode externe/reseau), meme remarque que les
-- migrations precedentes (ce projet n'utilise pas l'historique
-- "prisma migrate deploy") :
--   psql "$DATABASE_URL" -f prisma/migrations/20260912000000_lot20_gestion_courriers/migration.sql
-- Mode portable : deja inclus automatiquement dans prisma/portable-init.sql
-- (regenere depuis schema.prisma via `npm run prisma:portable-sql`), et
-- applique automatiquement aux installations existantes au demarrage
-- suivant (voir database/applyPendingMigrations.ts).

-- CreateEnum
CREATE TYPE "NatureCourrier" AS ENUM ('correspondance', 'convocation', 'assignation', 'signification', 'mise_en_demeure', 'courrier_client', 'courrier_juridiction', 'courrier_confrere', 'courrier_administratif', 'autre');

-- CreateEnum
CREATE TYPE "ModeCourrier" AS ENUM ('main_propre', 'courrier_postal', 'huissier', 'email', 'fax', 'autre');

-- CreateEnum
CREATE TYPE "StatutCourrierEntrant" AS ENUM ('recu', 'a_affecter', 'affecte', 'en_traitement', 'traite', 'classe');

-- CreateEnum
CREATE TYPE "StatutCourrierSortant" AS ENUM ('brouillon', 'envoye', 'classe');

-- DropForeignKey
ALTER TABLE "audit_logs" DROP CONSTRAINT "audit_logs_action_id_fkey";

-- AlterTable
ALTER TABLE "delai_calculs" ADD COLUMN     "courrier_entrant_id" TEXT;

-- AlterTable
ALTER TABLE "documents_dossier" ADD COLUMN     "courrier_entrant_id" TEXT,
ADD COLUMN     "courrier_sortant_id" TEXT;

-- AlterTable
ALTER TABLE "actions" ADD COLUMN     "courrier_entrant_id" TEXT;

-- AlterTable
ALTER TABLE "audit_logs" ADD COLUMN     "courrier_entrant_id" TEXT,
ADD COLUMN     "courrier_sortant_id" TEXT,
ALTER COLUMN "action_id" DROP NOT NULL;

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
CREATE INDEX "delai_calculs_courrier_entrant_id_idx" ON "delai_calculs"("courrier_entrant_id");

-- CreateIndex
CREATE INDEX "actions_courrier_entrant_id_idx" ON "actions"("courrier_entrant_id");

-- CreateIndex
CREATE INDEX "audit_logs_courrier_entrant_id_idx" ON "audit_logs"("courrier_entrant_id");

-- CreateIndex
CREATE INDEX "audit_logs_courrier_sortant_id_idx" ON "audit_logs"("courrier_sortant_id");

-- AddForeignKey
ALTER TABLE "delai_calculs" ADD CONSTRAINT "delai_calculs_courrier_entrant_id_fkey" FOREIGN KEY ("courrier_entrant_id") REFERENCES "courriers_entrants"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "documents_dossier" ADD CONSTRAINT "documents_dossier_courrier_entrant_id_fkey" FOREIGN KEY ("courrier_entrant_id") REFERENCES "courriers_entrants"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "documents_dossier" ADD CONSTRAINT "documents_dossier_courrier_sortant_id_fkey" FOREIGN KEY ("courrier_sortant_id") REFERENCES "courriers_sortants"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "actions" ADD CONSTRAINT "actions_courrier_entrant_id_fkey" FOREIGN KEY ("courrier_entrant_id") REFERENCES "courriers_entrants"("id") ON DELETE SET NULL ON UPDATE CASCADE;

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
