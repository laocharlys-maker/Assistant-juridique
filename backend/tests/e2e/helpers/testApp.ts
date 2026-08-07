import type { PrismaClient } from "@prisma/client";

/** Jeu de donnees fictif clairement identifiable (jamais de vraies donnees
 * de cabinet - voir README-LOT7.md), reutilise par les trois suites e2e. */
export const CABINET_TEST_NOM = "Cabinet Test";
export const CLIENT_FICTIF_NOM = "Client Fictif";

export async function seedCabinetEtTitulaire(prisma: PrismaClient, suffix: string) {
  const cabinet = await prisma.cabinet.create({ data: { nom: CABINET_TEST_NOM } });
  const user = await prisma.user.create({
    data: {
      cabinetId: cabinet.id,
      nom: "Avocat Test",
      email: `avocat-e2e-${suffix}@test.invalid`,
      motDePasseHash: "x",
      role: "titulaire",
    },
  });
  return { cabinet, user };
}

export async function mintAuthCookie(
  userId: string,
  cabinetId: string,
  role: "titulaire" | "avocat" | "collaborateur" | "super_admin" = "titulaire"
): Promise<string> {
  const { signAuthToken } = await import("../../../src/services/auth");
  const token = signAuthToken({ userId, cabinetId, role });
  return `aurore_session=${token}`;
}
