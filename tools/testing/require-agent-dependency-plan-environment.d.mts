export const dependencyPlanIsolationFlags: string[];
export function requireAgentDependencyPlanEnvironment(environment?: NodeJS.ProcessEnv, target?: "current" | "pre-0184", browser?: boolean): { url: string; nonce: string; name: string; lane: string };
