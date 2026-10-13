-- AlterTable
ALTER TABLE "audit_logs" ADD COLUMN     "fiche_personnel_id" TEXT;

-- CreateTable
CREATE TABLE "fiches_personnel" (
    "id" TEXT NOT NULL,
    "cabinet_id" TEXT NOT NULL,
    "user_id" TEXT,
    "nom" TEXT NOT NULL,
    "prenoms" TEXT,
    "categorie" TEXT NOT NULL,
    "fonction" TEXT,
    "type_contrat" TEXT NOT NULL,
    "date_entree" TIMESTAMP(3) NOT NULL,
    "date_sortie" TIMESTAMP(3),
    "statut" TEXT NOT NULL DEFAULT 'actif',
    "telephone" TEXT,
    "email" TEXT,
    "contact_urgence" TEXT,
    "mode_paiement" TEXT,
    "coordonnees_paiement" TEXT,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "fiches_personnel_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "fiches_personnel_user_id_key" ON "fiches_personnel"("user_id");

-- CreateIndex
CREATE INDEX "fiches_personnel_cabinet_id_idx" ON "fiches_personnel"("cabinet_id");

-- CreateIndex
CREATE INDEX "audit_logs_fiche_personnel_id_idx" ON "audit_logs"("fiche_personnel_id");

-- AddForeignKey
ALTER TABLE "fiches_personnel" ADD CONSTRAINT "fiches_personnel_cabinet_id_fkey" FOREIGN KEY ("cabinet_id") REFERENCES "cabinets"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "fiches_personnel" ADD CONSTRAINT "fiches_personnel_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "audit_logs" ADD CONSTRAINT "audit_logs_fiche_personnel_id_fkey" FOREIGN KEY ("fiche_personnel_id") REFERENCES "fiches_personnel"("id") ON DELETE SET NULL ON UPDATE CASCADE;
