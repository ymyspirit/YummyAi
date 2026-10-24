import { randomUUID } from "node:crypto";
import { mkdir, readFile, readdir, unlink, rmdir, writeFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { resolve, relative, isAbsolute } from "node:path";
import type { ChildProcess } from "node:child_process";
import type * as ChildProcessModule from "node:child_process";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createEntityId } from "@yummyai/contracts";
import { agentMcpAuthProfileDigest, parseAgentMcpAuthProfile, loadAgentMcpAuthProfile } from "./auth/config.js";
import { AgentMcpCredentialStore, type AgentMcpCredentialState } from "./auth/credential-store.js";
import { createPersonalAgentMcpSession } from "./auth/session.js";
import { WindowsAgentMcpDataProtection, type AgentMcpDataProtection } from "./auth/windows-dpapi.js";

const spawned = vi.hoisted(() => [] as ChildProcess[]);
vi.mock("node:child_process", async original => {
  const actual = await original<typeof ChildProcessModule>();
  const spawn: typeof actual.spawn = ((...args: unknown[]) => { const child = Reflect.apply(actual.spawn, actual, args) as ChildProcess; spawned.push(child); return child; }) as typeof actual.spawn;
  return { ...actual, spawn };
});

const qa = fileURLToPath(new URL("../../../tmp/agent-mcp-v2-20261022-7c4e1b92/qa/", import.meta.url));
const paths: string[] = [];
const profile = parseAgentMcpAuthProfile({ schemaVersion: 1, apiUrl: "http://127.0.0.1:8130", issuer: "http://127.0.0.1:49159", clientId: "yummyai-agent-mcp",
  audience: "yummyai-api", redirectUri: "http://127.0.0.1:49160/callback" });
const digest = agentMcpAuthProfileDigest(profile), secret = "SYNTHETIC_PERSONAL_REFRESH_TOKEN_never_log";
async function directory() { const path = resolve(qa, "auth-unit-" + randomUUID()), child = relative(qa, path);
  if (child.startsWith("..") || isAbsolute(child)) throw new Error("auth_unit_directory_not_owned"); await mkdir(path, { recursive: true }); paths.push(path); return path; }
function ready(revision = 1): AgentMcpCredentialState {
  return { schemaVersion: 1, profileDigest: digest, grantId: randomUUID(), revision, state: "ready", identity: { subject: "synthetic-personal", tenantId: createEntityId(), userId: createEntityId() },
    tokens: { accessToken: "e30.e30.c3ludGhldGlj", refreshToken: secret, accessExpiresAt: Date.now() + 600_000 } };
}

describe("MCP personal profile protected storage and fixed startup grant", () => {
  afterEach(async () => {
    const errors: unknown[] = [];
    for (const directory of paths.splice(0)) {
      try { const child = relative(qa, directory); if (!child || child.startsWith("..") || isAbsolute(child)) throw new Error("auth_unit_cleanup_not_owned");
        for (const entry of await readdir(directory, { withFileTypes: true })) {
          if (!entry.isFile() || !/^(credential\.(bin|lock)|profile\.json|\.credential-[a-f0-9-]+\.tmp)$/.test(entry.name)) throw new Error("auth_unit_cleanup_unexpected_target");
          await unlink(resolve(directory, entry.name));
        }
        await rmdir(directory);
      } catch (error) { errors.push(error); }
    }
    if (errors.length) throw new AggregateError(errors, "MCP owned auth-unit cleanup failed");
  });

  it("binds a strict public profile to one fixed ERP origin issuer client and loopback callback without accepting a credential or destination override", async () => {
    expect(agentMcpAuthProfileDigest({ ...profile, apiUrl: profile.apiUrl })).toBe(digest); expect(Object.isFrozen(profile)).toBe(true);
    for (const value of [{ ...profile, redirectUri: "http://localhost:49160/callback" }, { ...profile, redirectUri: "http://127.0.0.1:49160/callback?secret=x" },
      { ...profile, apiUrl: "https://user:synthetic@erp.invalid" }, { ...profile, issuer: "https://identity.invalid/?token=synthetic" },
      { ...profile, accessToken: secret }, { ...profile, clientSecret: secret }, { ...profile, audience: " " }]) expect(() => parseAgentMcpAuthProfile(value)).toThrow("mcp_auth_profile_invalid");
    const path = resolve(await directory(), "profile.json"); await writeFile(path, JSON.stringify(profile));
    expect(await loadAgentMcpAuthProfile({ YUMMYAI_MCP_AUTH_PROFILE: path })).toEqual(profile);
    await expect(loadAgentMcpAuthProfile({ YUMMYAI_MCP_AUTH_PROFILE: "relative-profile.json" })).rejects.toMatchObject({ code: "mcp_auth_profile_invalid" });
  });

  it("constructs and reports a missing local grant without networking or falling back to an environment bearer", async () => {
    let requests = 0;
    const session = await createPersonalAgentMcpSession(profile, { storeDir: await directory(), fetch: async () => { requests++; throw new Error(secret); } });
    const status = await session.status(); expect(status).toMatchObject({ state: "signed_out", grantId: null, tenantId: null, userId: null, accessExpiresAt: null });
    await expect(session.credentials.acquire(new AbortController().signal)).rejects.toMatchObject({ code: "mcp_auth_required" });
    expect(requests).toBe(0); expect(JSON.stringify(status).includes(secret)).toBe(false);
  });

  it("persists actual Windows CurrentUser ciphertext and rejects a different profile entropy without returning token material", async () => {
    const location = await directory(), store = new AgentMcpCredentialStore(location, digest, new WindowsAgentMcpDataProtection()), original = ready();
    await store.update(() => ({ next: original, value: undefined }));
    const cipher = await readFile(resolve(location, "credential.bin")); expect(cipher.includes(Buffer.from(secret))).toBe(false);
    const actual = await store.read(); expect(actual?.state).toBe("ready"); expect(actual?.grantId).toBe(original.grantId);
    expect(actual?.state === "ready" && actual.tokens.refreshToken === secret).toBe(true);
    const other = new AgentMcpCredentialStore(location, "f".repeat(64), new WindowsAgentMcpDataProtection());
    await expect(other.read()).rejects.toMatchObject({ code: "mcp_auth_cache_invalid" });
  });

  it("preserves the last complete credential if protection fails and leaves no plaintext or partial replacement", async () => {
    const location = await directory(), dpapi = new WindowsAgentMcpDataProtection(), original = ready(), store = new AgentMcpCredentialStore(location, digest, dpapi);
    await store.update(() => ({ next: original, value: undefined })); const before = await readFile(resolve(location, "credential.bin"));
    const failure: AgentMcpDataProtection = { protect: async () => { throw new Error(secret); }, unprotect: (bytes, entropy) => dpapi.unprotect(bytes, entropy) };
    await expect(new AgentMcpCredentialStore(location, digest, failure).update(current => ({ next: current && { ...current, revision: current.revision + 1 }, value: undefined })))
      .rejects.toMatchObject({ code: "mcp_auth_storage_unavailable" });
    expect((await readFile(resolve(location, "credential.bin"))).equals(before)).toBe(true); expect((await readdir(location)).some(name => name.endsWith(".tmp"))).toBe(false);
  });

  it("requires explicit reauthentication after corrupted storage and never resurrects a fixed provider after logout or a new grant", async () => {
    const location = await directory(), store = new AgentMcpCredentialStore(location, digest, new WindowsAgentMcpDataProtection()), original = ready();
    await store.update(() => ({ next: original, value: undefined })); const session = await createPersonalAgentMcpSession(profile, { storeDir: location });
    const lease = await session.credentials.acquire(new AbortController().signal); await session.logout();
    await expect(lease.assertCurrent()).rejects.toMatchObject({ code: "mcp_auth_session_changed" });
    await store.update(() => ({ next: ready(3), value: undefined })); await expect(session.credentials.acquire(new AbortController().signal)).rejects.toMatchObject({ code: "mcp_auth_session_changed" });
    await writeFile(resolve(location, "credential.bin"), new Uint8Array([0, 1, 2, 3]));
    const corrupted = await createPersonalAgentMcpSession(profile, { storeDir: location, fetch: async () => { throw new Error("unexpected_auth_network"); } });
    expect((await corrupted.status()).state).toBe("reauthentication_required");
    await expect(corrupted.credentials.acquire(new AbortController().signal)).rejects.toMatchObject({ code: "mcp_auth_required" });
  });

  it("cannot commit an old protected grant after its exact lock-holder dies and a real logout has committed", async () => {
    const location = await directory(), protection = new WindowsAgentMcpDataProtection(), store = new AgentMcpCredentialStore(location, digest, protection), original = ready();
    await store.update(() => ({ next: original, value: undefined }));
    let enter!: () => void, release!: () => void;
    const entered = new Promise<void>(yes => { enter = yes; }), released = new Promise<void>(yes => { release = yes; });
    const gated: AgentMcpDataProtection = { unprotect: (cipher, entropy) => protection.unprotect(cipher, entropy), protect: async (plain, entropy) => {
      enter(); await released; return protection.protect(plain, entropy);
    } };
    const offset = spawned.length, late = new AgentMcpCredentialStore(location, digest, gated).update(current => ({ next: current && { ...current, revision: current.revision + 1 }, value: undefined }));
    const settled = late.then(() => "unexpected_commit", () => "rejected");
    let gateTimer: NodeJS.Timeout | undefined;
    try {
      await Promise.race([entered, settled.then(result => { throw new Error("auth_lock_gate_not_reached_" + result); }),
        new Promise<never>((_, reject) => { gateTimer = setTimeout(() => reject(new Error("auth_lock_gate_not_reached_bounded")), 10_000); })]);
      if (gateTimer) clearTimeout(gateTimer);
      const alive = spawned.slice(offset).filter(child => child.exitCode === null && child.signalCode === null);
      // Protect has not spawned its child yet; ACL/read helpers have completed.
      // The one live process is this exact operation's original OS lock holder.
      expect(alive.length).toBe(1); const holder = alive[0]!;
      const ended = new Promise<void>(yes => holder.once("close", () => yes())); holder.kill(); await ended;
      const session = await createPersonalAgentMcpSession(profile, { storeDir: location }); await session.logout();
      const signedOut = await store.read(); expect(signedOut?.state).toBe("signed_out");
      release(); expect(await settled).toBe("rejected"); expect((await store.read())?.grantId).toBe(signedOut?.grantId); expect((await store.read())?.state).toBe("signed_out");
    } finally { if (gateTimer) clearTimeout(gateTimer); release(); await settled; }
  }, 30_000);
});
