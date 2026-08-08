-- Lot 16 : ingestion email assistee (pieces jointes + detection de RDV).
-- Migration additive uniquement - deux nouvelles tables (connexions_email_externe,
-- emails_importes), une nouvelle valeur d'enum SourceEvenement ('email'), une
-- cle etrangere nullable sur documents_dossier (email_origine_id, deja
-- presente comme simple colonne depuis le Lot 15, transformee ici en vraie
-- relation) - aucun impact sur les donnees existantes.
--
-- Application manuelle (mode externe/reseau), meme remarque que les
-- migrations precedentes (ce projet n'utilise pas l'historique
-- "prisma migrate deploy") :
--   psql "$DATABASE_URL" -f prisma/migrations/20260808000000_ingestion_email/migration.sql
-- Mode portable : deja inclus automatiquement dans prisma/portable-init.sql
-- (regenere depuis schema.prisma via `npm run prisma:portable-sql`).

-- CreateEnum
CREATE TYPE "ProviderEmailExterne" AS ENUM ('gmail', 'imap');

-- CreateEnum
CREATE TYPE "StatutEmailImporte" AS ENUM ('nouveau', 'traite');

-- AlterEnum
ALTER TYPE "SourceEvenement" ADD VALUE 'email';

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

-- CreateIndex
CREATE UNIQUE INDEX "connexions_email_externe_user_id_provider_key" ON "connexions_email_externe"("user_id", "provider");

-- CreateIndex
CREATE INDEX "emails_importes_cabinet_id_idx" ON "emails_importes"("cabinet_id");

-- CreateIndex
CREATE UNIQUE INDEX "emails_importes_connexion_id_identifiant_externe_key" ON "emails_importes"("connexion_id", "identifiant_externe");

-- AddForeignKey
ALTER TABLE "documents_dossier" ADD CONSTRAINT "documents_dossier_email_origine_id_fkey" FOREIGN KEY ("email_origine_id") REFERENCES "emails_importes"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "connexions_email_externe" ADD CONSTRAINT "connexions_email_externe_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "emails_importes" ADD CONSTRAINT "emails_importes_connexion_id_fkey" FOREIGN KEY ("connexion_id") REFERENCES "connexions_email_externe"("id") ON DELETE CASCADE ON UPDATE CASCADE;
