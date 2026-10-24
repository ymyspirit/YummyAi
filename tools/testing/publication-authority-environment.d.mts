export const PUBLICATION_AUTHORITY_LANE: string;
export function requirePublicationAuthorityEnvironment(env?: NodeJS.ProcessEnv, browser?: boolean): { url: string; name: string; nonce: string; lane: string };
