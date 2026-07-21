import { PrismaClient } from "@prisma/client";
import crypto from "node:crypto";
import { hashPassword } from "../src/services/auth";

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

  const existingUser = await prisma.user.findUnique({
    where: { email: "cabinet.koffi@example.com" },
  });

  let plainPassword: string | null = null;
  let user = existingUser;

  if (!existingUser) {
    plainPassword = crypto.randomBytes(9).toString("base64url");
    user = await prisma.user.create({
      data: {
        cabinetId: cabinet.id,
        nom: "Maître Koffi",
        email: "cabinet.koffi@example.com",
        motDePasseHash: await hashPassword(plainPassword),
        role: "titulaire",
      },
    });
  } else if (!existingUser.motDePasseHash.startsWith("$2")) {
    // Ancien hash place avant la mise en place de l'auth (Phase 2) : on le remplace par un vrai mot de passe.
    plainPassword = crypto.randomBytes(9).toString("base64url");
    user = await prisma.user.update({
      where: { id: existingUser.id },
      data: { motDePasseHash: await hashPassword(plainPassword) },
    });
  }

  console.log("Cabinet cree/retrouve :", cabinet.id, cabinet.nom);
  console.log("Utilisateur cree/retrouve :", user!.id, user!.email);
  console.log("");
  console.log("Utilise ces identifiants dans les appels a POST /api/actions/whatsapp :");
  console.log(`  cabinetId = ${cabinet.id}`);
  console.log(`  userId    = ${user!.id}`);

  if (plainPassword) {
    console.log("");
    console.log("Compte cree - mot de passe (affiche une seule fois, note-le) :");
    console.log(`  email    = ${user!.email}`);
    console.log(`  password = ${plainPassword}`);
  } else {
    console.log("");
    console.log("Compte deja existant : le mot de passe n'est pas reaffiche.");
  }
}

main()
  .catch((error) => {
    console.error(error);
    process.exit(1);
  })
  .finally(async () => {
    await prisma.$disconnect();
  });
