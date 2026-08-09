-- Pause/reprise du chronometre (Header) : une mise en pause n'ouvre jamais
-- une nouvelle SaisieTemps, elle accumule la duree du segment qui vient de
-- se terminer dans cette nouvelle colonne, puis vide demarreA (voir le
-- commentaire sur SaisieTemps.demarreA, schema.prisma). Migration additive
-- uniquement - aucun impact sur les donnees existantes (defaut 0).
--
-- Application manuelle (mode externe/reseau), meme remarque que les
-- migrations precedentes (ce projet n'utilise pas l'historique
-- "prisma migrate deploy") :
--   psql "$DATABASE_URL" -f prisma/migrations/20260809010000_pause_chronometre/migration.sql
-- Mode portable : deja inclus automatiquement dans prisma/portable-init.sql
-- (regenere depuis schema.prisma via `npm run prisma:portable-sql`) ET
-- rattrape sur une installation existante au demarrage suivant (voir
-- src/database/applyPendingMigrations.ts).

-- AlterTable
ALTER TABLE "saisies_temps" ADD COLUMN     "duree_accumulee_secondes" INTEGER NOT NULL DEFAULT 0;
