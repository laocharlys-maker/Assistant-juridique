-- Suivi comptable "Factures payées" : permet d'attacher a une facture deja
-- payee (statut interne "payee") le PDF de la facture normalisee (SYGMEF)
-- correspondante, avec son propre numero (facultatif) et sa propre date de
-- paiement - distincts de numero/payeeAt qui restent pilotes par le
-- workflow interne Aurore. Colonnes nullables, migration purement additive :
-- toute facture existante reste inchangee, sans PDF attache.
--
-- Application manuelle (mode externe/reseau), meme remarque que les
-- migrations precedentes (ce projet n'utilise pas l'historique
-- "prisma migrate deploy") :
--   psql "$DATABASE_URL" -f prisma/migrations/20260816010000_facture_normalisee/migration.sql
-- Mode portable : appliquee automatiquement au demarrage sur une
-- installation existante (voir database/applyPendingMigrations.ts) ; deja
-- incluse dans prisma/portable-init.sql pour une installation neuve
-- (regenere depuis schema.prisma via `npm run prisma:portable-sql`,
-- execute automatiquement par `npm run build:sea`).

-- AlterTable
ALTER TABLE "factures" ADD COLUMN "facture_normalisee_numero" TEXT;
ALTER TABLE "factures" ADD COLUMN "facture_normalisee_date_paiement" TIMESTAMP(3);
ALTER TABLE "factures" ADD COLUMN "facture_normalisee_nom_fichier" TEXT;
ALTER TABLE "factures" ADD COLUMN "facture_normalisee_nom_original" TEXT;
ALTER TABLE "factures" ADD COLUMN "facture_normalisee_taille_octets" INTEGER;
ALTER TABLE "factures" ADD COLUMN "facture_normalisee_ajoutee_at" TIMESTAMP(3);
