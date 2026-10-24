export function requireStudioPersonalEnvironment(
  environment?: Record<string, string | undefined>, browser?: boolean,
): { url: string; name: string; nonce: string; lane: string };
