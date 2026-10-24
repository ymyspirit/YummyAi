export const listingSyncIntentIsolationFlags: readonly string[];
export function requireListingSyncIntentEnvironment(env?: NodeJS.ProcessEnv, target?: "current" | "pre-0181", browser?: boolean): { url: string; name: string; nonce: string };
