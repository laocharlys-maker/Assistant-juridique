-- Lot 12a : modele Evenement unifie (calendrier mois/semaine/jour/liste),
-- generation automatique depuis RoleAudience/DelaiCalcul. Migration
-- additive uniquement - deux nouvelles tables, aucun impact sur les
-- donnees existantes.
--
-- Application manuelle (mode externe/reseau), meme remarque que les
-- migrations des Lots 2bis/3/5/10/11 (ce projet n'utilise pas l'historique
-- "prisma migrate deploy") :
--   psql "$DATABASE_URL" -f prisma/migrations/20260807020000_calendrier_unifie/migration.sql
-- Mode portable : deja inclus automatiquement dans prisma/portable-init.sql
-- (regenere depuis schema.prisma via `npm run prisma:portable-sql`).

-- CreateEnum
CREATE TYPE "TypeEvenement" AS ENUM ('audience', 'rdv', 'appel', 'tache', 'echeance_procedure', 'autre');

-- CreateEnum
CREATE TYPE "SourceEvenement" AS ENUM ('manuel', 'role_audience', 'delai_calcule', 'sync_google', 'sync_caldav');

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

-- CreateIndex
CREATE UNIQUE INDEX "evenements_role_audience_id_key" ON "evenements"("role_audience_id");

-- CreateIndex
CREATE UNIQUE INDEX "evenements_delai_calcul_id_key" ON "evenements"("delai_calcul_id");

-- CreateIndex
CREATE INDEX "evenements_cabinet_id_date_debut_idx" ON "evenements"("cabinet_id", "date_debut");

-- CreateIndex
CREATE INDEX "evenements_dossier_id_idx" ON "evenements"("dossier_id");

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
