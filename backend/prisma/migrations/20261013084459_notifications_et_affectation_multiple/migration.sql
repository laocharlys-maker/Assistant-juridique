-- CreateTable
CREATE TABLE "notifications" (
    "id" TEXT NOT NULL,
    "cabinet_id" TEXT NOT NULL,
    "destinataire_id" TEXT NOT NULL,
    "type" TEXT NOT NULL,
    "titre" TEXT NOT NULL,
    "message" TEXT,
    "lien_url" TEXT,
    "lu" BOOLEAN NOT NULL DEFAULT false,
    "lu_at" TIMESTAMP(3),
    "cree_par_id" TEXT,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "notifications_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "courrier_affectations" (
    "courrier_entrant_id" TEXT NOT NULL,
    "collaborateur_id" TEXT NOT NULL,
    "affecte_par_id" TEXT NOT NULL,
    "note" TEXT,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "courrier_affectations_pkey" PRIMARY KEY ("courrier_entrant_id","collaborateur_id")
);

-- CreateIndex
CREATE INDEX "notifications_destinataire_id_lu_idx" ON "notifications"("destinataire_id", "lu");

-- CreateIndex
CREATE INDEX "courrier_affectations_collaborateur_id_idx" ON "courrier_affectations"("collaborateur_id");

-- AddForeignKey
ALTER TABLE "notifications" ADD CONSTRAINT "notifications_cabinet_id_fkey" FOREIGN KEY ("cabinet_id") REFERENCES "cabinets"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "notifications" ADD CONSTRAINT "notifications_destinataire_id_fkey" FOREIGN KEY ("destinataire_id") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "notifications" ADD CONSTRAINT "notifications_cree_par_id_fkey" FOREIGN KEY ("cree_par_id") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "courrier_affectations" ADD CONSTRAINT "courrier_affectations_courrier_entrant_id_fkey" FOREIGN KEY ("courrier_entrant_id") REFERENCES "courriers_entrants"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "courrier_affectations" ADD CONSTRAINT "courrier_affectations_collaborateur_id_fkey" FOREIGN KEY ("collaborateur_id") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "courrier_affectations" ADD CONSTRAINT "courrier_affectations_affecte_par_id_fkey" FOREIGN KEY ("affecte_par_id") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
