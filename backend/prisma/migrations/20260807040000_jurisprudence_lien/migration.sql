-- Lot 13 : ajoute le lien reel et verifiable vers la decision elle-meme,
-- absent du schema avant ce lot (verifie en premier - voir README-LOT13.md).
-- Migration additive uniquement - une colonne nullable, aucun impact sur
-- les donnees existantes. Les chunks deja indexes n'auront simplement pas
-- ce champ renseigne (lien = NULL) tant qu'ils n'auront pas ete completes
-- manuellement (voir public/jurisprudence-base.html).
--
-- Application manuelle (mode externe/reseau), meme remarque que les
-- migrations precedentes (ce projet n'utilise pas l'historique
-- "prisma migrate deploy") :
--   psql "$DATABASE_URL" -f prisma/migrations/20260807040000_jurisprudence_lien/migration.sql
-- Mode portable : deja inclus automatiquement dans prisma/portable-init.sql
-- (regenere depuis schema.prisma via `npm run prisma:portable-sql`).

ALTER TABLE "jurisprudence_chunks" ADD COLUMN "lien" TEXT;
