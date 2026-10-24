export const fulfillmentCommandIsolationFlags: string[];
export function requireFulfillmentCommandEnvironment(environment?: NodeJS.ProcessEnv, target?: "current" | "pre-0185", browser?: boolean): { url: string; nonce: string; name: string; lane: string };
