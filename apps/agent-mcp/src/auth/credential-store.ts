import fs from "node:fs/promises";
import path from "node:path";
import { z } from "zod";
import { assertAuthRegularPath } from "./config.js";
import { AgentMcpAuthError, authCheck } from "./error.js";
import { secureAgentMcpAuthDirectory, withAgentMcpCredentialLock, type AgentMcpDataProtection } from "./windows-dpapi.js";

export const AgentMcpSavedIdentitySchema = z.object({
  subject: z.string().min(1).max(1024),
  tenantId: z.uuidv7(),
  userId: z.uuidv7(),
}).strict();
export type AgentMcpSavedIdentity = z.infer<typeof AgentMcpSavedIdentitySchema>;
export const AgentMcpSavedTokensSchema = z.object({
  accessToken: z.string().min(1).max(32768),
  refreshToken: z.string().min(1).max(32768).nullable(),
  accessExpiresAt: z.number().finite().positive().max(8_640_000_000_000_000),
}).strict();
export type AgentMcpSavedTokens = z.infer<typeof AgentMcpSavedTokensSchema>;
const common = {
  schemaVersion: z.literal(1),
  profileDigest: z.string().regex(/^[a-f0-9]{64}$/),
  grantId: z.uuid(),
  revision: z.number().int().positive().max(Number.MAX_SAFE_INTEGER),
};
export const AgentMcpCredentialStateSchema = z.discriminatedUnion("state", [
  z.object({ ...common, state: z.literal("ready"), identity: AgentMcpSavedIdentitySchema, tokens: AgentMcpSavedTokensSchema }).strict(),
  z.object({ ...common, state: z.enum(["refreshing", "login_pending"]), operationId: z.uuid(),
    startedAt: z.number().finite(), identity: AgentMcpSavedIdentitySchema.nullable(), accessExpiresAt: z.number().finite().nullable() }).strict(),
  z.object({ ...common, state: z.literal("requires_login"), identity: AgentMcpSavedIdentitySchema.nullable() }).strict(),
  z.object({ ...common, state: z.literal("signed_out") }).strict(),
]);
export type AgentMcpCredentialState = z.infer<typeof AgentMcpCredentialStateSchema>;

/** Contains only DPAPI ciphertext. No file ever contains a plaintext token. */
export class AgentMcpCredentialStore {
  readonly directory: string;
  private readonly filename: string;
  private readonly entropy: Buffer;
  private initialized: Promise<void> | undefined;
  constructor(directory: string, readonly profileDigest: string, private readonly protection: AgentMcpDataProtection) {
    authCheck(path.isAbsolute(directory) && !directory.startsWith("\\\\") && !directory.startsWith("//") &&
      path.resolve(directory) !== path.parse(path.resolve(directory)).root &&
      /^[a-f0-9]{64}$/.test(profileDigest), "mcp_auth_storage_unavailable");
    this.directory = path.resolve(directory);
    this.filename = path.join(this.directory, "credential.bin");
    this.entropy = Buffer.from("yummyai:agent-mcp:personal-auth:v1:" + profileDigest);
  }
  private initialize(): Promise<void> {
    this.initialized ??= (async () => {
      await assertAuthRegularPath(this.directory, true);
      await fs.mkdir(this.directory, { recursive: true });
      await assertAuthRegularPath(this.directory);
      authCheck((await fs.lstat(this.directory)).isDirectory(), "mcp_auth_storage_unavailable");
      // Never change ACLs on a mistakenly selected non-vault directory.
      authCheck((await fs.readdir(this.directory)).every(name => name === "credential.bin" || name === "credential.lock" ||
        /^\.credential-[a-f0-9]{32}\.tmp$/.test(name)), "mcp_auth_storage_unavailable");
      await secureAgentMcpAuthDirectory(this.directory);
    })().catch(() => {
      this.initialized = undefined;
      throw new AgentMcpAuthError("mcp_auth_storage_unavailable");
    });
    return this.initialized;
  }
  async read(): Promise<AgentMcpCredentialState | null> {
    let encrypted: Buffer | undefined, plain: Uint8Array | undefined;
    try {
      await assertAuthRegularPath(this.directory, true);
      let stat;
      try { stat = await fs.lstat(this.filename); }
      catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return null; throw error; }
      authCheck(stat.isFile() && !stat.isSymbolicLink() && stat.size > 0 && stat.size <= 256 * 1024, "mcp_auth_cache_invalid");
      encrypted = await fs.readFile(this.filename);
      authCheck(encrypted.byteLength <= 256 * 1024, "mcp_auth_cache_invalid");
      try { plain = await this.protection.unprotect(encrypted, this.entropy); }
      catch { throw new AgentMcpAuthError("mcp_auth_cache_invalid"); }
      authCheck(plain.byteLength <= 192 * 1024, "mcp_auth_cache_invalid");
      const record = AgentMcpCredentialStateSchema.parse(JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(plain)));
      authCheck(record.profileDigest === this.profileDigest, "mcp_auth_cache_invalid");
      return record;
    } catch (error) {
      if (error instanceof AgentMcpAuthError && error.code === "mcp_auth_storage_unavailable") throw error;
      throw new AgentMcpAuthError("mcp_auth_cache_invalid");
    } finally { encrypted?.fill(0); plain?.fill(0); }
  }
  async update<T>(
    action: (current: AgentMcpCredentialState | null) => { next: AgentMcpCredentialState | null; value: T },
    options: { resetInvalid?: boolean } = {},
  ): Promise<T> {
    await this.initialize();
    const lock = path.join(this.directory, "credential.lock");
    await assertAuthRegularPath(lock, true);
    return withAgentMcpCredentialLock(lock, async commit => {
      let current: AgentMcpCredentialState | null;
      try { current = await this.read(); }
      catch (error) {
        if (!options.resetInvalid || !(error instanceof AgentMcpAuthError) || error.code !== "mcp_auth_cache_invalid") throw error;
        current = null;
      }
      const result = action(current);
      if (result.next !== null) {
        const record = AgentMcpCredentialStateSchema.parse(result.next);
        authCheck(record.profileDigest === this.profileDigest, "mcp_auth_storage_unavailable");
        const plain = Buffer.from(JSON.stringify(record));
        let cipher: Uint8Array | undefined;
        try {
          cipher = await this.protection.protect(plain, this.entropy);
          authCheck(cipher.byteLength > 0 && cipher.byteLength <= 256 * 1024, "mcp_auth_storage_unavailable");
          // Only the helper still holding the OS lock may replace credential.bin.
          await commit(cipher);
        } finally { plain.fill(0); cipher?.fill(0); }
      }
      return result.value;
    }).catch(error => {
      if (error instanceof AgentMcpAuthError) throw error;
      throw new AgentMcpAuthError("mcp_auth_storage_unavailable");
    });
  }
}
