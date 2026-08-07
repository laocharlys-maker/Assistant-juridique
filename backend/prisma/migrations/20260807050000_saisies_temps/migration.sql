-- Lot 14 : timer & feuilles de temps. Migration additive uniquement - une
-- nouvelle table, une colonne nullable sur "users", aucun impact sur les
-- donnees existantes.
--
-- Application manuelle (mode externe/reseau), meme remarque que les
-- migrations precedentes (ce projet n'utilise pas l'historique
-- "prisma migrate deploy") :
--   psql "$DATABASE_URL" -f prisma/migrations/20260807050000_saisies_temps/migration.sql
-- Mode portable : deja inclus automatiquement dans prisma/portable-init.sql
-- (regenere depuis schema.prisma via `npm run prisma:portable-sql`).

-- CreateEnum
CREATE TYPE "SourceSaisieTemps" AS ENUM ('chrono', 'manuel');

-- AlterTable
ALTER TABLE "users" ADD COLUMN     "taux_horaire_defaut" INTEGER;

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
    "duree_minutes" INTEGER,
    "description" TEXT,
    "facturable" BOOLEAN NOT NULL DEFAULT true,
    "taux_horaire_applique" INTEGER,
    "facture_id" TEXT,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "saisies_temps_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "saisies_temps_cabinet_id_idx" ON "saisies_temps"("cabinet_id");

-- CreateIndex
CREATE INDEX "saisies_temps_dossier_id_idx" ON "saisies_temps"("dossier_id");

-- CreateIndex
CREATE INDEX "saisies_temps_user_id_idx" ON "saisies_temps"("user_id");

-- CreateIndex
CREATE INDEX "saisies_temps_facture_id_idx" ON "saisies_temps"("facture_id");

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
