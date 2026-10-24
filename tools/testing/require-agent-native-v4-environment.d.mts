export const nativeV4IsolationFlags: readonly string[];
export function requireAgentNativeV4Environment(environment?: Record<string,string|undefined>,target?: "current"|"pre-0187",browser?: boolean): {
  url: string; nonce: string; name: string; lane: string;
};
