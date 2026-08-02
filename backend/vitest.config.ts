import { defineConfig } from "vitest/config";

// Delais generereux (Lot 7) : necessaires pour les tests de bout en bout
// (tests/e2e/) qui font de vraies operations d'E/S - demarrage d'un
// cluster PostgreSQL jetable (initdb/pg_ctl), premiere lecture de
// l'empreinte machine (spawn PowerShell, voir security/machineFingerprint.ts),
// generation d'un certificat TLS... Sans effet perceptible sur les tests
// unitaires existants (rapides), qui n'approchent jamais ces plafonds.
export default defineConfig({
  test: {
    testTimeout: 20_000,
    hookTimeout: 30_000,
  },
});
