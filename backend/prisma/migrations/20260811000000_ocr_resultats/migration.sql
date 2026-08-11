-- Lot 17 : transcription (OCR) des pieces de dossier (Lot 15). Migration
-- additive uniquement - une nouvelle table, aucun impact sur les donnees
-- existantes. texte_extrait est chiffre au repos (AES-256-GCM, meme cle
-- applicative que le reste du projet - voir security/encryptionAtRest.ts) :
-- cette table ne contient jamais de texte en clair. Voir README-LOT17.md.
--
-- Application manuelle (mode externe/reseau), meme remarque que les
-- migrations precedentes (ce projet n'utilise pas l'historique
-- "prisma migrate deploy") :
--   psql "$DATABASE_URL" -f prisma/migrations/20260811000000_ocr_resultats/migration.sql
-- Mode portable : deja inclus automatiquement dans prisma/portable-init.sql
-- (regenere depuis schema.prisma via `npm run prisma:portable-sql`).

-- CreateEnum
CREATE TYPE "OcrStatut" AS ENUM ('en_attente', 'en_cours', 'termine', 'echec');

-- CreateTable
CREATE TABLE "ocr_resultats" (
    "id" TEXT NOT NULL,
    "document_id" TEXT NOT NULL,
    "cabinet_id" TEXT NOT NULL,
    "dossier_id" TEXT NOT NULL,
    "statut" "OcrStatut" NOT NULL DEFAULT 'en_attente',
    "moteur" TEXT NOT NULL DEFAULT 'tesseract',
    "texte_extrait" TEXT,
    "score_confiance" DOUBLE PRECISION,
    "message_erreur" TEXT,
    "tentatives" INTEGER NOT NULL DEFAULT 0,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "ocr_resultats_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "ocr_resultats_document_id_key" ON "ocr_resultats"("document_id");

-- CreateIndex
CREATE INDEX "ocr_resultats_dossier_id_idx" ON "ocr_resultats"("dossier_id");

-- CreateIndex
CREATE INDEX "ocr_resultats_cabinet_id_idx" ON "ocr_resultats"("cabinet_id");

-- CreateIndex
CREATE INDEX "ocr_resultats_statut_idx" ON "ocr_resultats"("statut");

-- AddForeignKey
ALTER TABLE "ocr_resultats" ADD CONSTRAINT "ocr_resultats_document_id_fkey" FOREIGN KEY ("document_id") REFERENCES "documents_dossier"("id") ON DELETE CASCADE ON UPDATE CASCADE;
