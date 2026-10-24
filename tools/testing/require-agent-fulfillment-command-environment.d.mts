export const agentFulfillmentCommandIsolationFlags: string[];
export function requireAgentFulfillmentCommandEnvironment(environment?: NodeJS.ProcessEnv, browser?: boolean, target?: "current" | "pre-0186"): {
  url: string; name: string; nonce: string; lane: string;
};
