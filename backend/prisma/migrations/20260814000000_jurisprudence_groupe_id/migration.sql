-- Lot 18 : identifiant partage par tous les chunks issus d'une meme
-- soumission du formulaire "Ajouter une source" (une decision longue peut
-- desormais etre decoupee en plusieurs lignes jurisprudence_chunks - voir
-- services/jurisprudence/chunkerTexte.ts). Permet a PATCH
-- /api/jurisprudence-base/:id (modification du lien) de mettre a jour TOUS
-- les chunks d'une meme decision en une seule operation. Migration additive
-- uniquement - colonne nullable, aucun impact sur les donnees existantes
-- (corpus indexe avant ce lot : groupe_id reste NULL, PATCH se replie alors
-- sur une mise a jour par id seul, voir jurisprudenceBase.ts).
--
-- Application manuelle (mode externe/reseau), meme remarque que les
-- migrations precedentes (ce projet n'utilise pas l'historique
-- "prisma migrate deploy") :
--   psql "$DATABASE_URL" -f prisma/migrations/20260814000000_jurisprudence_groupe_id/migration.sql
-- Mode portable : deja inclus automatiquement dans prisma/portable-init.sql
-- (regenere depuis schema.prisma via `npm run prisma:portable-sql`).

-- AlterTable
ALTER TABLE "jurisprudence_chunks" ADD COLUMN "groupe_id" TEXT;

-- CreateIndex
CREATE INDEX "jurisprudence_chunks_groupe_id_idx" ON "jurisprudence_chunks"("groupe_id");
