export const marketplaceAuthorityIsolationFlags: string[];
export function requireMarketplaceAuthorityEnvironment(env?: NodeJS.ProcessEnv, target?: "current" | "pre-0178", browser?: boolean): { url: string; name: string; nonce: string };
