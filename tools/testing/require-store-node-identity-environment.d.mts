export const storeNodeIdentityIsolationFlags: readonly string[];
export function requireStoreNodeIdentityEnvironment(env?: NodeJS.ProcessEnv, target?: "current" | "pre-0179", browser?: boolean): {
  url: string; name: string; nonce: string;
};
