CREATE TABLE "jurisprudence_pdfs" (
    "groupe_id" TEXT NOT NULL,
    "nom_fichier" TEXT NOT NULL,
    "nom_original" TEXT NOT NULL,
    "taille_octets" INTEGER NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "jurisprudence_pdfs_pkey" PRIMARY KEY ("groupe_id")
);
