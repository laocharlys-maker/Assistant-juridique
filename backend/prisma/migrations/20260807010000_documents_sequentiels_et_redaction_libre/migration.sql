-- Lot 11 : verrouillage sequentiel + historique de versions + validation
-- qui s'impose (Partie A), et mode de creation "redaction libre" (Partie B).
-- Migration additive uniquement - 4 colonnes nullables/par-defaut sur
-- "actions", nouvelle table "action_versions" - aucun impact sur les
-- donnees existantes (verrouille_par/verrouille_le nuls, version_actuelle=0,
-- mode_creation='genere_ia' pour toutes les lignes deja en base).
--
-- Application manuelle (mode externe/reseau), meme remarque que les
-- migrations des Lots 2bis/3/5/10 (ce projet n'utilise pas l'historique
-- "prisma migrate deploy") :
--   psql "$DATABASE_URL" -f prisma/migrations/20260807010000_documents_sequentiels_et_redaction_libre/migration.sql
-- Mode portable : deja inclus automatiquement dans prisma/portable-init.sql
-- (regenere depuis schema.prisma via `npm run prisma:portable-sql`).

-- AlterTable
ALTER TABLE "actions" ADD COLUMN     "mode_creation" TEXT NOT NULL DEFAULT 'genere_ia',
ADD COLUMN     "verrouille_le" TIMESTAMP(3),
ADD COLUMN     "verrouille_par" TEXT,
ADD COLUMN     "version_actuelle" INTEGER NOT NULL DEFAULT 0;

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

-- CreateIndex
CREATE INDEX "action_versions_action_id_idx" ON "action_versions"("action_id");

-- AddForeignKey
ALTER TABLE "actions" ADD CONSTRAINT "actions_verrouille_par_fkey" FOREIGN KEY ("verrouille_par") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "action_versions" ADD CONSTRAINT "action_versions_action_id_fkey" FOREIGN KEY ("action_id") REFERENCES "actions"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "action_versions" ADD CONSTRAINT "action_versions_auteur_id_fkey" FOREIGN KEY ("auteur_id") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
