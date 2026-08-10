-- Releve la taille de police par defaut des documents generes (11 -> 13pt),
-- suite a une capture de reference fournie par l'utilisateur (Mise en
-- demeure en redaction libre) : 11pt rendait le texte trop petit compare au
-- gabarit vise. N'affecte que les cabinets restes sur l'ancienne valeur par
-- defaut (11) - un cabinet ayant deja choisi explicitement une autre taille
-- via Parametres n'est jamais ecrase.
--
-- Application manuelle (mode externe/reseau), meme remarque que les
-- migrations precedentes (ce projet n'utilise pas l'historique
-- "prisma migrate deploy") :
--   psql "$DATABASE_URL" -f prisma/migrations/20260810000000_taille_documents_defaut_13/migration.sql
-- Mode portable : deja inclus automatiquement dans prisma/portable-init.sql
-- (regenere depuis schema.prisma via `npm run prisma:portable-sql`).

ALTER TABLE "cabinets" ALTER COLUMN "taille_documents" SET DEFAULT 13;

UPDATE "cabinets" SET "taille_documents" = 13 WHERE "taille_documents" = 11;
