export const storeNodeExecutionIsolationFlags: readonly string[];
export function requireStoreNodeExecutionEnvironment(env?: NodeJS.ProcessEnv, target?: "current" | "pre-0180", browser?: boolean): { url: string; name: string; nonce: string };
