import fs from "node:fs/promises";
import path from "node:path";
import { createHash } from "node:crypto";
import { z } from "zod";
import { parseAgentMcpApiUrl } from "../config.js";
import { AgentMcpAuthError, authCheck } from "./error.js";

const clean = z.string().min(1).max(2048).refine(value =>
  value === value.trim() && ![...value].some(char => char.charCodeAt(0) <= 32 || char.charCodeAt(0) === 127));
export const AgentMcpAuthProfileSchema = z.object({
  schemaVersion: z.literal(1),
  apiUrl: clean,
  issuer: clean,
  clientId: clean,
  audience: clean,
  redirectUri: clean,
}).strict();
export type AgentMcpAuthProfile = Readonly<z.infer<typeof AgentMcpAuthProfileSchema>>;

export function parseAgentMcpAuthProfile(value: unknown): AgentMcpAuthProfile {
  try {
    const profile = AgentMcpAuthProfileSchema.parse(value);
    authCheck(parseAgentMcpApiUrl(profile.apiUrl) === profile.apiUrl, "mcp_auth_profile_invalid");
    const issuer = new URL(profile.issuer);
    const local = issuer.hostname === "127.0.0.1" || issuer.hostname === "localhost" || issuer.hostname === "[::1]";
    authCheck((issuer.protocol === "https:" || issuer.protocol === "http:" && local) &&
      !issuer.username && !issuer.password && !issuer.search && !issuer.hash &&
      !profile.issuer.endsWith("/") && issuer.href.replace(/\/$/, "") === profile.issuer,
    "mcp_auth_profile_invalid");
    authCheck(/^[A-Za-z0-9._-]{1,200}$/.test(profile.clientId), "mcp_auth_profile_invalid");
    const redirect = /^http:\/\/127\.0\.0\.1:([1-9][0-9]{0,4})\/callback$/.exec(profile.redirectUri);
    authCheck(redirect && Number(redirect[1]) <= 65535, "mcp_auth_profile_invalid");
    return Object.freeze(profile);
  } catch {
    throw new AgentMcpAuthError("mcp_auth_profile_invalid");
  }
}

export function agentMcpAuthProfileDigest(profile: AgentMcpAuthProfile): string {
  return createHash("sha256").update(JSON.stringify([
    "erp-mcp-personal-auth-v1", profile.schemaVersion, profile.apiUrl,
    profile.issuer, profile.clientId, profile.audience, profile.redirectUri,
  ])).digest("hex");
}

export async function assertAuthRegularPath(filename: string, allowMissing = false): Promise<void> {
  authCheck(path.isAbsolute(filename) && !filename.startsWith("\\\\") && !filename.startsWith("//"),
    "mcp_auth_storage_unavailable");
  const parsed = path.parse(filename), parts = path.relative(parsed.root, filename).split(path.sep);
  let current = parsed.root;
  for (const [index, part] of parts.entries()) {
    current = path.join(current, part);
    let stat;
    try { stat = await fs.lstat(current); }
    catch (error) {
      if (allowMissing && (error as NodeJS.ErrnoException).code === "ENOENT") return;
      throw new AgentMcpAuthError("mcp_auth_storage_unavailable");
    }
    authCheck(!stat.isSymbolicLink() && (index === parts.length - 1 || stat.isDirectory()),
      "mcp_auth_storage_unavailable");
  }
}

export async function loadAgentMcpAuthProfile(env: NodeJS.ProcessEnv): Promise<AgentMcpAuthProfile> {
  try {
    const filename = env.YUMMYAI_MCP_AUTH_PROFILE;
    authCheck(filename && path.isAbsolute(filename), "mcp_auth_profile_invalid");
    await assertAuthRegularPath(filename);
    const stat = await fs.lstat(filename);
    authCheck(stat.isFile() && stat.size <= 16_384, "mcp_auth_profile_invalid");
    const bytes = await fs.readFile(filename);
    authCheck(bytes.byteLength <= 16_384, "mcp_auth_profile_invalid");
    return parseAgentMcpAuthProfile(JSON.parse(new TextDecoder("utf-8", { fatal: true })
      .decode(bytes).replace(/^\uFEFF/, "")));
  } catch {
    throw new AgentMcpAuthError("mcp_auth_profile_invalid");
  }
}
