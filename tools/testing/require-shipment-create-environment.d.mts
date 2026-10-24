export function requireShipmentCreateEnvironment(environment?: Record<string, string | undefined>, target?: "current", browser?: boolean): {
  url: string; nonce: string; name: string; lane: string;
};
