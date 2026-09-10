-- Versions FICHIER d'une action (aller-retour Word - corrections/
-- commentaires/suivi des modifications faits dans Word, hors de l'editeur
-- texte d'Aurore, voir routes/actionVersionsFichier.ts). Migration additive
-- uniquement - nouvelle table, aucun impact sur les donnees existantes.
--
-- Application manuelle (mode externe/reseau), meme remarque que les
-- migrations precedentes (ce projet n'utilise pas l'historique
-- "prisma migrate deploy") :
--   psql "$DATABASE_URL" -f prisma/migrations/20260911000000_action_versions_fichier/migration.sql
-- Mode portable : deja inclus automatiquement dans prisma/portable-init.sql
-- (regenere depuis schema.prisma via `npm run prisma:portable-sql`), et
-- applique automatiquement aux installations existantes au demarrage
-- suivant (voir database/applyPendingMigrations.ts).

-- CreateTable
CREATE TABLE "action_versions_fichier" (
    "id" TEXT NOT NULL,
    "action_id" TEXT NOT NULL,
    "numero" INTEGER NOT NULL,
    "nom_original" TEXT NOT NULL,
    "type_mime" TEXT NOT NULL,
    "taille_octets" INTEGER NOT NULL,
    "nom_fichier" TEXT NOT NULL,
    "auteur_id" TEXT NOT NULL,
    "est_version_validee" BOOLEAN NOT NULL DEFAULT false,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "action_versions_fichier_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "action_versions_fichier_action_id_idx" ON "action_versions_fichier"("action_id");

-- AddForeignKey
ALTER TABLE "action_versions_fichier" ADD CONSTRAINT "action_versions_fichier_action_id_fkey" FOREIGN KEY ("action_id") REFERENCES "actions"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "action_versions_fichier" ADD CONSTRAINT "action_versions_fichier_auteur_id_fkey" FOREIGN KEY ("auteur_id") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
