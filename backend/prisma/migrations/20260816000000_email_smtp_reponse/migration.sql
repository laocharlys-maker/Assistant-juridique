-- Ajoute la possibilite de repondre a un email depuis une boite IMAP
-- generique (Gmail repond via l'API Gmail elle-meme, pas besoin de SMTP
-- separe - voir services/emailIngestion/gmailClient.ts). Colonnes nullables,
-- migration purement additive : une connexion IMAP existante sans ces
-- valeurs reste utilisable en lecture exactement comme avant, seul le
-- bouton "Repondre" reste simplement absent tant qu'elles ne sont pas
-- renseignees.
--
-- Application manuelle (mode externe/reseau), meme remarque que les
-- migrations precedentes (ce projet n'utilise pas l'historique
-- "prisma migrate deploy") :
--   psql "$DATABASE_URL" -f prisma/migrations/20260816000000_email_smtp_reponse/migration.sql
-- Mode portable : appliquee automatiquement au demarrage sur une
-- installation existante (voir database/applyPendingMigrations.ts) ; deja
-- incluse dans prisma/portable-init.sql pour une installation neuve
-- (regenere depuis schema.prisma via `npm run prisma:portable-sql`,
-- execute automatiquement par `npm run build:sea`).

-- AlterTable
ALTER TABLE "connexions_email_externe" ADD COLUMN "smtp_host" TEXT;
ALTER TABLE "connexions_email_externe" ADD COLUMN "smtp_port" INTEGER;
ALTER TABLE "connexions_email_externe" ADD COLUMN "smtp_secure" BOOLEAN NOT NULL DEFAULT false;
