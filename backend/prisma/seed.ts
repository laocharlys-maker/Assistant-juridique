import { PrismaClient } from "@prisma/client";
import crypto from "node:crypto";

const prisma = new PrismaClient();

async function main() {
  const cabinet = await prisma.cabinet.upsert({
    where: { id: "00000000-0000-0000-0000-000000000001" },
    update: {},
    create: {
      id: "00000000-0000-0000-0000-000000000001",
      nom: "Cabinet KOFFI & ASSOCIES",
    },
  });

  const user = await prisma.user.upsert({
    where: { email: "cabinet.koffi@example.com" },
    update: {},
    create: {
      cabinetId: cabinet.id,
      nom: "Maître Koffi",
      email: "cabinet.koffi@example.com",
      // Mot de passe temporaire, a changer via l'app une fois l'auth branchee (Phase 2).
      motDePasseHash: crypto.randomBytes(32).toString("hex"),
      role: "titulaire",
    },
  });

  console.log("Cabinet cree/retrouve :", cabinet.id, cabinet.nom);
  console.log("Utilisateur cree/retrouve :", user.id, user.email);
  console.log("");
  console.log("Utilise ces identifiants dans les appels a POST /api/actions/whatsapp :");
  console.log(`  cabinetId = ${cabinet.id}`);
  console.log(`  userId    = ${user.id}`);
}

main()
  .catch((error) => {
    console.error(error);
    process.exit(1);
  })
  .finally(async () => {
    await prisma.$disconnect();
  });
