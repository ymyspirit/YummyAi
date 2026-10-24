export const publicationNodePreviewIsolationFlags: readonly string[];
export function requirePublicationNodePreviewEnvironment(env?: NodeJS.ProcessEnv, target?: "current" | "pre-0182", browser?: boolean): { url: string; name: string; nonce: string };
