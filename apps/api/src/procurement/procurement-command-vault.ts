import { createEnvironmentSecretVault } from "@yummyai/ai-core";

/** Procurement originals have a separate encryption domain from incoming work. */
export function createProcurementCommandVault(environment: NodeJS.ProcessEnv = process.env) {
  return createEnvironmentSecretVault("PROCUREMENT_COMMAND_ENCRYPTION_KEY", "yummyai:procurement-command:v1", environment);
}
