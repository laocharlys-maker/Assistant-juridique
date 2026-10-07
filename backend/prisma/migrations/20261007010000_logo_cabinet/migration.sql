-- Logo du cabinet (2026-10-07) - distinct de l'en-tete des documents
-- (entete_url) : uniquement affiche dans l'interface (ecran de connexion),
-- jamais insere dans un document genere. Migration additive.
--
-- Application manuelle (mode externe/reseau) :
--   psql "$DATABASE_URL" -f prisma/migrations/20261007010000_logo_cabinet/migration.sql
-- Mode portable : deja inclus automatiquement dans prisma/portable-init.sql.

ALTER TABLE "cabinets" ADD COLUMN     "logo_url" TEXT;
