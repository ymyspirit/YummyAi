import { createEnvironmentSecretVault } from "@yummyai/ai-core";

/** Retained Finance fillings have their own encryption domain and key. */
export function createFinanceCommandVault(environment: NodeJS.ProcessEnv = process.env) {
  return createEnvironmentSecretVault("FINANCE_COMMAND_ENCRYPTION_KEY", "yummyai:finance-command:v1", environment);
}
