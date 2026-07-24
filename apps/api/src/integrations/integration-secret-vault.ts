import { createEnvironmentSecretVault } from "@yummyai/ai-core";

export function createIntegrationSecretVault(environment: NodeJS.ProcessEnv = process.env) {
  return createEnvironmentSecretVault("INTEGRATION_SECRET_ENCRYPTION_KEY", "yummyai-integration-v1", environment);
}
