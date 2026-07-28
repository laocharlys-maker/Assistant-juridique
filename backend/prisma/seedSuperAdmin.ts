// Cree (ou retrouve) le tout premier compte super_admin - il n'existe
// aucun autre moyen d'en creer un (l'API /api/admin/* est elle-meme
// reservee aux super_admin). A executer une seule fois sur le serveur :
//   npx tsx prisma/seedSuperAdmin.ts admin@exemple.com "Ton nom"
import { PrismaClient } from "@prisma/client";
import crypto from "node:crypto";
import { hashPassword } from "../src/services/auth";

const prisma = new PrismaClient();

async function main() {
  const email = process.argv[2];
  const nom = process.argv[3];
  if (!email || !nom) {
    console.error('Usage : npx tsx prisma/seedSuperAdmin.ts "email@exemple.com" "Nom complet"');
    process.exit(1);
  }

  const existingUser = await prisma.user.findUnique({ where: { email } });
  if (existingUser) {
    if (existingUser.role === "super_admin") {
      console.log("Ce compte super_admin existe deja :", existingUser.email);
      return;
    }
    console.error(`Un compte existe deja avec cet email (role actuel : ${existingUser.role}) - choisis un autre email.`);
    process.exit(1);
  }

  // Cabinet technique porteur du compte plateforme - n'accueille jamais de
  // donnees metier (dossiers, clients...), seulement le(s) compte(s)
  // super_admin.
  const cabinet = await prisma.cabinet.upsert({
    where: { id: "00000000-0000-0000-0000-000000000000" },
    update: {},
    create: {
      id: "00000000-0000-0000-0000-000000000000",
      nom: "Administration Aurore",
    },
  });

  const plainPassword = crypto.randomBytes(9).toString("base64url");
  const user = await prisma.user.create({
    data: {
      cabinetId: cabinet.id,
      nom,
      email,
      motDePasseHash: await hashPassword(plainPassword),
      role: "super_admin",
    },
  });

  console.log("Compte super_admin cree :");
  console.log(`  email    = ${user.email}`);
  console.log(`  password = ${plainPassword}`);
  console.log("");
  console.log("Mot de passe affiche une seule fois - note-le avant de fermer ce terminal.");
}

main()
  .catch((error) => {
    console.error(error);
    process.exit(1);
  })
  .finally(async () => {
    await prisma.$disconnect();
  });
