-- Pop-up "Factures en attente de paiement" (tableau de bord) : permet a un
-- utilisateur d'ecarter definitivement le rappel pour une facture precise
-- ("Ne plus me rappeler"), sans affecter les autres utilisateurs du cabinet.
-- Migration additive uniquement - une nouvelle table, aucun impact sur les
-- donnees existantes.
--
-- Application manuelle (mode externe/reseau), meme remarque que les
-- migrations precedentes (ce projet n'utilise pas l'historique
-- "prisma migrate deploy") :
--   psql "$DATABASE_URL" -f prisma/migrations/20260809000000_facture_rappels_ignores/migration.sql
-- Mode portable : deja inclus automatiquement dans prisma/portable-init.sql
-- (regenere depuis schema.prisma via `npm run prisma:portable-sql`).

-- CreateTable
CREATE TABLE "facture_rappels_ignores" (
    "id" TEXT NOT NULL,
    "facture_id" TEXT NOT NULL,
    "user_id" TEXT NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "facture_rappels_ignores_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "facture_rappels_ignores_facture_id_user_id_key" ON "facture_rappels_ignores"("facture_id", "user_id");

-- AddForeignKey
ALTER TABLE "facture_rappels_ignores" ADD CONSTRAINT "facture_rappels_ignores_facture_id_fkey" FOREIGN KEY ("facture_id") REFERENCES "factures"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "facture_rappels_ignores" ADD CONSTRAINT "facture_rappels_ignores_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;
