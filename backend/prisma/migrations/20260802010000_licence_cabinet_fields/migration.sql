-- Lot 3 : miroir en base de la licence locale installee sur le poste du
-- cabinet (source de verite reelle = %APPDATA%/Aurore/licence.lic, voir
-- server/src/security/licenceManager.ts). Migration additive uniquement -
-- 4 colonnes nullables, aucun impact sur les donnees existantes ni sur les
-- requetes actuelles.
--
-- Application manuelle (mode externe/reseau - VPS ou serveur LAN), meme
-- remarque que la migration pgcrypto du Lot 2bis (ce projet n'utilise pas
-- l'historique "prisma migrate deploy") :
--   psql "$DATABASE_URL" -f prisma/migrations/20260802010000_licence_cabinet_fields/migration.sql
-- Mode portable : deja inclus automatiquement dans prisma/portable-init.sql
-- (regenere depuis schema.prisma via `npm run prisma:portable-sql`).

ALTER TABLE "cabinets" ADD COLUMN "licence_id" TEXT;
ALTER TABLE "cabinets" ADD COLUMN "licence_mode_verification" TEXT;
ALTER TABLE "cabinets" ADD COLUMN "licence_date_expiration" TIMESTAMP(3);
ALTER TABLE "cabinets" ADD COLUMN "empreinte_machine_autorisee" TEXT;
