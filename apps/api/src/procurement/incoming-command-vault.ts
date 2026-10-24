import { createEnvironmentSecretVault } from "@yummyai/ai-core";

export function createIncomingCommandVault(environment: NodeJS.ProcessEnv = process.env) {
  return createEnvironmentSecretVault("INCOMING_COMMAND_ENCRYPTION_KEY", "yummyai:incoming-command:v1", environment);
}
