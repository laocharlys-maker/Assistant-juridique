-- Lot 12b : synchronisation calendrier externe (Google Calendar OAuth2 +
-- CalDAV generique). Migration additive uniquement - deux nouvelles tables,
-- aucun impact sur les donnees existantes.
--
-- Application manuelle (mode externe/reseau), meme remarque que les
-- migrations precedentes (ce projet n'utilise pas l'historique
-- "prisma migrate deploy") :
--   psql "$DATABASE_URL" -f prisma/migrations/20260807030000_sync_calendrier_externe/migration.sql
-- Mode portable : deja inclus automatiquement dans prisma/portable-init.sql
-- (regenere depuis schema.prisma via `npm run prisma:portable-sql`).

-- CreateEnum
CREATE TYPE "ProviderCalendrierExterne" AS ENUM ('google', 'caldav');

-- CreateEnum
CREATE TYPE "StatutSyncExterne" AS ENUM ('en_attente', 'synchronise', 'erreur', 'a_supprimer');

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

-- CreateIndex
CREATE UNIQUE INDEX "connexions_calendrier_externe_user_id_provider_key" ON "connexions_calendrier_externe"("user_id", "provider");

-- CreateIndex
CREATE INDEX "evenement_sync_externe_statut_idx" ON "evenement_sync_externe"("statut");

-- CreateIndex
CREATE UNIQUE INDEX "evenement_sync_externe_evenement_id_connexion_id_key" ON "evenement_sync_externe"("evenement_id", "connexion_id");

-- AddForeignKey
ALTER TABLE "connexions_calendrier_externe" ADD CONSTRAINT "connexions_calendrier_externe_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "evenement_sync_externe" ADD CONSTRAINT "evenement_sync_externe_evenement_id_fkey" FOREIGN KEY ("evenement_id") REFERENCES "evenements"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "evenement_sync_externe" ADD CONSTRAINT "evenement_sync_externe_connexion_id_fkey" FOREIGN KEY ("connexion_id") REFERENCES "connexions_calendrier_externe"("id") ON DELETE CASCADE ON UPDATE CASCADE;
