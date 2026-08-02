-- Lot 5 : pseudonymisation avant appel LLM.
-- Migration additive : nouvelle valeur d'enum + colonne nullable-par-defaut,
-- aucun impact sur les donnees existantes.
--
-- Application manuelle (mode externe/reseau), meme remarque que les
-- migrations des Lots 2bis/3 (ce projet n'utilise pas l'historique
-- "prisma migrate deploy") :
--   psql "$DATABASE_URL" -f prisma/migrations/20260802020000_pseudonymisation/migration.sql
-- Mode portable : deja inclus automatiquement dans prisma/portable-init.sql
-- (regenere depuis schema.prisma via `npm run prisma:portable-sql`).

ALTER TYPE "StatutAction" ADD VALUE IF NOT EXISTS 'echec_generation';

ALTER TABLE "actions" ADD COLUMN "donnees_pseudonymisees" BOOLEAN NOT NULL DEFAULT false;
