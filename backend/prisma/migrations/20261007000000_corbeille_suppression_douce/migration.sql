-- Corbeille (2026-10-07) : suppression douce des dossiers/clients/documents
-- generes (Action), restaurable pendant 30 jours avant purge definitive
-- (voir jobs/purgeCorbeille.ts). Migration additive, aucun impact sur les
-- donnees existantes.
--
-- Application manuelle (mode externe/reseau) :
--   psql "$DATABASE_URL" -f prisma/migrations/20261007000000_corbeille_suppression_douce/migration.sql
-- Mode portable : deja inclus automatiquement dans prisma/portable-init.sql.

-- AlterTable
ALTER TABLE "clients" ADD COLUMN     "supprime_le" TIMESTAMP(3),
ADD COLUMN     "supprime_par_id" TEXT;

-- AlterTable
ALTER TABLE "dossiers" ADD COLUMN     "supprime_le" TIMESTAMP(3),
ADD COLUMN     "supprime_par_id" TEXT;

-- AlterTable
ALTER TABLE "actions" ADD COLUMN     "supprime_le" TIMESTAMP(3),
ADD COLUMN     "supprime_par_id" TEXT;

-- CreateIndex
CREATE INDEX "clients_supprime_le_idx" ON "clients"("supprime_le");

-- CreateIndex
CREATE INDEX "dossiers_supprime_le_idx" ON "dossiers"("supprime_le");

-- CreateIndex
CREATE INDEX "actions_supprime_le_idx" ON "actions"("supprime_le");

-- AddForeignKey
ALTER TABLE "clients" ADD CONSTRAINT "clients_supprime_par_id_fkey" FOREIGN KEY ("supprime_par_id") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "dossiers" ADD CONSTRAINT "dossiers_supprime_par_id_fkey" FOREIGN KEY ("supprime_par_id") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "actions" ADD CONSTRAINT "actions_supprime_par_id_fkey" FOREIGN KEY ("supprime_par_id") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;
