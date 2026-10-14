-- CreateTable
CREATE TABLE "commentaires_revision_destinataires" (
    "commentaire_id" TEXT NOT NULL,
    "user_id" TEXT NOT NULL,

    CONSTRAINT "commentaires_revision_destinataires_pkey" PRIMARY KEY ("commentaire_id","user_id")
);

-- AddForeignKey
ALTER TABLE "commentaires_revision_destinataires" ADD CONSTRAINT "commentaires_revision_destinataires_commentaire_id_fkey" FOREIGN KEY ("commentaire_id") REFERENCES "commentaires_revision"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "commentaires_revision_destinataires" ADD CONSTRAINT "commentaires_revision_destinataires_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
