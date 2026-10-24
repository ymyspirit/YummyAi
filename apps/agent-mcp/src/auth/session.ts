import path from "node:path";
import { randomUUID } from "node:crypto";
import { setTimeout as delay } from "node:timers/promises";
import type { AgentMcpCredentialProvider } from "../credential-provider.js";
import { agentMcpAuthProfileDigest, parseAgentMcpAuthProfile, type AgentMcpAuthProfile } from "./config.js";
import { AgentMcpCredentialStore, type AgentMcpCredentialState, type AgentMcpSavedIdentity } from "./credential-store.js";
import { AgentMcpAuthError, authAbort, authCheck } from "./error.js";
import { AgentMcpOidc, receiveAgentMcpAuthorization } from "./oidc.js";
import { WindowsAgentMcpDataProtection, openAgentMcpAuthorizationUrl, type AgentMcpDataProtection } from "./windows-dpapi.js";

export interface PersonalAgentMcpSessionOptions {
  storeDir?: string;
  fetch?: typeof fetch;
  openAuthorization?: (url: URL) => Promise<void>;
  now?: () => number;
  dataProtection?: AgentMcpDataProtection;
  loginTimeoutMs?: number;
}
export type AgentMcpAuthStatus = Readonly<{
  schemaVersion: 1;
  state: "signed_out" | "signed_in" | "signing_in" | "refreshing" | "reauthentication_required";
  apiUrl: string;
  profileDigest: string;
  grantId: string | null;
  tenantId: string | null;
  userId: string | null;
  accessExpiresAt: string | null;
}>;
export interface PersonalAgentMcpSession {
  credentials: AgentMcpCredentialProvider;
  login(options?: { signal?: AbortSignal }): Promise<AgentMcpAuthStatus>;
  status(): Promise<AgentMcpAuthStatus>;
  logout(): Promise<void>;
}

export function defaultAgentMcpAuthStoreDirectory(profile: AgentMcpAuthProfile, env: NodeJS.ProcessEnv = process.env): string {
  const base = env.LOCALAPPDATA;
  authCheck(base && path.isAbsolute(base) && !base.startsWith("\\\\") && !base.startsWith("//"),
    "mcp_auth_storage_unavailable");
  return path.join(base, "YummyAI", "agent-mcp", agentMcpAuthProfileDigest(profile));
}
const sameIdentity = (left: AgentMcpSavedIdentity, right: AgentMcpSavedIdentity) =>
  left.subject === right.subject && left.tenantId === right.tenantId && left.userId === right.userId;

/** Startup binds one grant. Login never hot-swaps the provider's original identity. */
export async function createPersonalAgentMcpSession(
  rawProfile: AgentMcpAuthProfile, options: PersonalAgentMcpSessionOptions = {},
): Promise<PersonalAgentMcpSession> {
  const profile = parseAgentMcpAuthProfile(rawProfile), digest = agentMcpAuthProfileDigest(profile);
  const directory = options.storeDir ?? defaultAgentMcpAuthStoreDirectory(profile);
  const store = new AgentMcpCredentialStore(directory, digest, options.dataProtection ?? new WindowsAgentMcpDataProtection());
  const now = options.now ?? Date.now, oidc = new AgentMcpOidc(profile, options.fetch ?? fetch, now);
  const loginTimeoutMs = options.loginTimeoutMs ?? 120_000;
  authCheck(Number.isInteger(loginTimeoutMs) && loginTimeoutMs >= 1000 && loginTimeoutMs <= 300_000, "mcp_auth_profile_invalid");
  let initial: AgentMcpCredentialState | null;
  try { initial = await store.read(); }
  catch (error) {
    if (!(error instanceof AgentMcpAuthError) || error.code !== "mcp_auth_cache_invalid") throw error;
    initial = null;
  }
  const bound = initial?.state === "ready" || initial?.state === "refreshing" ? initial : null;
  const grantId = bound?.grantId ?? null, identity = bound?.identity ?? null;
  let refreshFlight: Promise<void> | undefined;
  const ensureGrant = (record: AgentMcpCredentialState | null) => {
    authCheck(grantId && identity && record && record.grantId === grantId &&
      record.state !== "signed_out" && record.state !== "login_pending", "mcp_auth_session_changed");
    if (record.state === "requires_login") throw new AgentMcpAuthError("mcp_auth_required");
    authCheck(record.identity && sameIdentity(identity, record.identity), "mcp_auth_identity_changed");
    return record;
  };
  const status = async (): Promise<AgentMcpAuthStatus> => {
    let record: AgentMcpCredentialState | null;
    try { record = await store.read(); }
    catch (error) {
      if (!(error instanceof AgentMcpAuthError) || error.code !== "mcp_auth_cache_invalid") throw error;
      return { schemaVersion: 1, state: "reauthentication_required", apiUrl: profile.apiUrl,
        profileDigest: digest, grantId: null, tenantId: null, userId: null, accessExpiresAt: null };
    }
    const details = record && record.state !== "signed_out" ? record.identity : null;
    const expiry = record?.state === "ready" ? record.tokens.accessExpiresAt :
      record?.state === "refreshing" || record?.state === "login_pending" ? record.accessExpiresAt : null;
    const state: AgentMcpAuthStatus["state"] = !record || record.state === "signed_out" ? "signed_out" :
      record.state === "ready" ? (record.tokens.accessExpiresAt <= now() && !record.tokens.refreshToken ? "reauthentication_required" : "signed_in") :
        record.state === "login_pending" ? "signing_in" :
          record.state === "refreshing" && now() - record.startedAt <= 60_000 ? "refreshing" : "reauthentication_required";
    return { schemaVersion: 1, state, apiUrl: profile.apiUrl, profileDigest: digest, grantId: record?.grantId ?? null,
      tenantId: details?.tenantId ?? null, userId: details?.userId ?? null,
      accessExpiresAt: expiry === null ? null : new Date(expiry).toISOString() };
  };
  async function refresh(signal: AbortSignal): Promise<void> {
    authAbort(signal);
    const operationId = randomUUID();
    const original = await store.update(current => {
      authAbort(signal);
      const record = ensureGrant(current);
      if (record.state !== "ready" || record.tokens.accessExpiresAt - now() >= 150_000) return { next: null, value: null };
      authCheck(record.tokens.refreshToken, "mcp_auth_required");
      return { next: { schemaVersion: 1, profileDigest: digest, grantId: record.grantId,
        revision: record.revision + 1, state: "refreshing", operationId, startedAt: now(),
        identity: record.identity, accessExpiresAt: record.tokens.accessExpiresAt }, value: record };
    });
    if (!original) return;
    try {
      // Once the rotating-token request may be sent, finish receiving it even if
      // the caller cancels. Never retry an uncertain refresh or an ERP request.
      const renewed = await oidc.refresh(original.tokens, original.identity);
      await store.update(current => {
        authCheck(current?.state === "refreshing" && current.grantId === grantId &&
          current.operationId === operationId, "mcp_auth_session_changed");
        return { next: { schemaVersion: 1, profileDigest: digest, grantId: current.grantId,
          revision: current.revision + 1, state: "ready", identity: renewed.identity, tokens: renewed.tokens }, value: undefined };
      });
    } catch (error) {
      await store.update(current => current?.state === "refreshing" && current.grantId === grantId && current.operationId === operationId
        ? { next: { schemaVersion: 1, profileDigest: digest, grantId: current.grantId, revision: current.revision + 1,
          state: "requires_login", identity: current.identity }, value: undefined }
        : { next: null, value: undefined }).catch(() => {});
      throw error instanceof AgentMcpAuthError ? error : new AgentMcpAuthError("mcp_auth_refresh_unknown");
    }
  }
  const credentials: AgentMcpCredentialProvider = Object.freeze({
    async acquire(signal) {
      authAbort(signal); authCheck(grantId && identity, "mcp_auth_required");
      const until = performance.now() + 30_000;
      for (;;) {
        authAbort(signal);
        const record = ensureGrant(await store.read());
        if (record.state === "ready" && record.tokens.accessExpiresAt - now() >= 150_000) {
          const accessToken = record.tokens.accessToken, expiresAt = record.tokens.accessExpiresAt;
          return Object.freeze({ accessToken, async assertCurrent(assertSignal?: AbortSignal) {
            authAbort(assertSignal);
            const latest = ensureGrant(await store.read());
            authCheck(latest.state !== "refreshing", "mcp_auth_refresh_pending");
            authCheck(latest.state === "ready" && expiresAt > now(), "mcp_auth_required");
            authAbort(assertSignal);
          } });
        }
        if (record.state === "refreshing") {
          authCheck(now() - record.startedAt <= 60_000, "mcp_auth_refresh_unknown");
          authCheck(performance.now() < until, "mcp_auth_refresh_pending");
          try { await delay(100, undefined, { signal }); } catch { throw new AgentMcpAuthError("mcp_auth_cancelled"); }
        } else {
          refreshFlight ??= refresh(signal).finally(() => { refreshFlight = undefined; });
          await refreshFlight;
        }
      }
    },
  });
  return Object.freeze({
    credentials,
    status,
    async logout() {
      await store.update(current => ({ next: { schemaVersion: 1, profileDigest: digest,
        grantId: randomUUID(), revision: (current?.revision ?? 0) + 1, state: "signed_out" }, value: undefined }), { resetInvalid: true });
    },
    async login(loginOptions: { signal?: AbortSignal } = {}) {
      authAbort(loginOptions.signal);
      const loginGrant = randomUUID(), operationId = randomUUID();
      await store.update(current => ({ next: { schemaVersion: 1, profileDigest: digest,
        grantId: loginGrant, revision: (current?.revision ?? 0) + 1, state: "login_pending",
        operationId, startedAt: now(), identity: null, accessExpiresAt: null }, value: undefined }), { resetInvalid: true });
      try {
        const flow = await oidc.start(loginOptions.signal);
        const callback = await receiveAgentMcpAuthorization(profile, flow, options.openAuthorization ?? openAgentMcpAuthorizationUrl,
          { signal: loginOptions.signal, timeoutMs: loginTimeoutMs });
        const verified = await oidc.complete(flow, callback, loginOptions.signal);
        authAbort(loginOptions.signal);
        await store.update(current => {
          authCheck(current?.state === "login_pending" && current.grantId === loginGrant &&
            current.operationId === operationId, "mcp_auth_session_changed");
          return { next: { schemaVersion: 1, profileDigest: digest, grantId: loginGrant,
            revision: current.revision + 1, state: "ready", identity: verified.identity, tokens: verified.tokens }, value: undefined };
        });
        return await status();
      } catch (error) {
        await store.update(current => current?.state === "login_pending" && current.grantId === loginGrant && current.operationId === operationId
          ? { next: { schemaVersion: 1, profileDigest: digest, grantId: loginGrant, revision: current.revision + 1,
            state: "requires_login", identity: null }, value: undefined }
          : { next: null, value: undefined }).catch(() => {});
        throw error instanceof AgentMcpAuthError ? error : new AgentMcpAuthError("mcp_auth_login_failed");
      }
    },
  });
}
