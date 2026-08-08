-- Lot 15 : stockage documentaire par dossier (GED). Migration additive
-- uniquement - une nouvelle table, aucun impact sur les donnees existantes.
-- Cette table ne contient JAMAIS le contenu binaire des fichiers (voir
-- services/stockageDocuments.ts) : uniquement des metadonnees et le nom du
-- fichier chiffre stocke sur disque, hors du dossier d'installation de
-- l'app (voir README-LOT15.md).
--
-- Application manuelle (mode externe/reseau), meme remarque que les
-- migrations precedentes (ce projet n'utilise pas l'historique
-- "prisma migrate deploy") :
--   psql "$DATABASE_URL" -f prisma/migrations/20260808000000_documents_dossier/migration.sql
-- Mode portable : deja inclus automatiquement dans prisma/portable-init.sql
-- (regenere depuis schema.prisma via `npm run prisma:portable-sql`).

-- CreateTable
CREATE TABLE "documents_dossier" (
    "id" TEXT NOT NULL,
    "cabinet_id" TEXT NOT NULL,
    "dossier_id" TEXT NOT NULL,
    "nom_original" TEXT NOT NULL,
    "type_mime" TEXT NOT NULL,
    "taille_octets" INTEGER NOT NULL,
    "nom_fichier" TEXT NOT NULL,
    "source" TEXT NOT NULL DEFAULT 'upload',
    "email_origine_id" TEXT,
    "uploade_par_id" TEXT NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "documents_dossier_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "documents_dossier_dossier_id_idx" ON "documents_dossier"("dossier_id");

-- CreateIndex
CREATE INDEX "documents_dossier_cabinet_id_idx" ON "documents_dossier"("cabinet_id");

-- AddForeignKey
ALTER TABLE "documents_dossier" ADD CONSTRAINT "documents_dossier_cabinet_id_fkey" FOREIGN KEY ("cabinet_id") REFERENCES "cabinets"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "documents_dossier" ADD CONSTRAINT "documents_dossier_dossier_id_fkey" FOREIGN KEY ("dossier_id") REFERENCES "dossiers"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "documents_dossier" ADD CONSTRAINT "documents_dossier_uploade_par_id_fkey" FOREIGN KEY ("uploade_par_id") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
