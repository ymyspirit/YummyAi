import { AgentMcpConfigError, parseAgentMcpConfig, type AgentMcpConfig } from "./config.js";
import { AgentReadinessFamilySchema, type AgentReadinessFamily } from "@yummyai/contracts/ai/agent-readiness";

export type AgentMcpV2Config = AgentMcpConfig & Readonly<{
  allowNativeV3: boolean;
  readinessFamilies?: readonly AgentReadinessFamily[];
}>;

/** New flags never alter the meaning or permissiveness of the old entrypoint. */
export function parseAgentMcpV2Config(env: NodeJS.ProcessEnv, args: readonly string[]): AgentMcpV2Config {
  const nativeFlags = args.filter(argument => argument === "--allow-native-v3");
  if (nativeFlags.length > 1) throw new AgentMcpConfigError();
  const readinessFamilies: AgentReadinessFamily[] = [];
  const originalArgs = args.filter(argument => {
    if (argument === "--allow-native-v3") return false;
    if (!argument.startsWith("--allow-readiness=")) return true;
    const family = AgentReadinessFamilySchema.safeParse(argument.slice("--allow-readiness=".length));
    if (!family.success || readinessFamilies.includes(family.data)) throw new AgentMcpConfigError();
    readinessFamilies.push(family.data);
    return false;
  });
  const base = parseAgentMcpConfig(env, originalArgs);
  return Object.freeze({ ...base, allowNativeV3: nativeFlags.length === 1,
    readinessFamilies: Object.freeze([...readinessFamilies]) });
}
