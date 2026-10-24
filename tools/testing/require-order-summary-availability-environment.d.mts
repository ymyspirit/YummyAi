export const orderSummaryIsolationFlags: string[];
export function requireOrderSummaryEnvironment(environment?: NodeJS.ProcessEnv, browser?: boolean): {
  url: string; nonce: string; name: string; lane: string;
};
