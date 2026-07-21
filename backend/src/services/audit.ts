import { prisma } from "../lib/prisma";
import { StatutExecution } from "@prisma/client";

export async function logAuditStep(
  actionId: string,
  etape: string,
  statut: StatutExecution,
  detail?: string
): Promise<void> {
  await prisma.auditLog.create({
    data: { actionId, etape, statut, detail },
  });
}
