-- CreateTable
CREATE TABLE "etats_paiement" (
    "id" TEXT NOT NULL,
    "cabinet_id" TEXT NOT NULL,
    "periode_paie_id" TEXT NOT NULL,
    "statut" TEXT NOT NULL DEFAULT 'brouillon',
    "total_brut" INTEGER NOT NULL DEFAULT 0,
    "total_retenues" INTEGER NOT NULL DEFAULT 0,
    "total_net" INTEGER NOT NULL DEFAULT 0,
    "genere_le" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "genere_par_id" TEXT NOT NULL,

    CONSTRAINT "etats_paiement_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "lignes_paiement" (
    "id" TEXT NOT NULL,
    "etat_paiement_id" TEXT NOT NULL,
    "fiche_paie_id" TEXT NOT NULL,
    "mode_paiement" TEXT,
    "statut_paiement" TEXT NOT NULL DEFAULT 'a_payer',
    "date_paiement" TIMESTAMP(3),
    "reference" TEXT,

    CONSTRAINT "lignes_paiement_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "etats_paiement_periode_paie_id_key" ON "etats_paiement"("periode_paie_id");

-- CreateIndex
CREATE UNIQUE INDEX "lignes_paiement_fiche_paie_id_key" ON "lignes_paiement"("fiche_paie_id");

-- CreateIndex
CREATE INDEX "lignes_paiement_etat_paiement_id_idx" ON "lignes_paiement"("etat_paiement_id");

-- AddForeignKey
ALTER TABLE "etats_paiement" ADD CONSTRAINT "etats_paiement_cabinet_id_fkey" FOREIGN KEY ("cabinet_id") REFERENCES "cabinets"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "etats_paiement" ADD CONSTRAINT "etats_paiement_periode_paie_id_fkey" FOREIGN KEY ("periode_paie_id") REFERENCES "periodes_paie"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "etats_paiement" ADD CONSTRAINT "etats_paiement_genere_par_id_fkey" FOREIGN KEY ("genere_par_id") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "lignes_paiement" ADD CONSTRAINT "lignes_paiement_etat_paiement_id_fkey" FOREIGN KEY ("etat_paiement_id") REFERENCES "etats_paiement"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "lignes_paiement" ADD CONSTRAINT "lignes_paiement_fiche_paie_id_fkey" FOREIGN KEY ("fiche_paie_id") REFERENCES "fiches_paie"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
