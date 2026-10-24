import {
  createCipheriv,
  createDecipheriv,
  createHash,
  randomBytes,
  timingSafeEqual,
} from "node:crypto";
import { setTimeout as delay } from "node:timers/promises";
import { createRemoteJWKSet, jwtVerify } from "jose";
import { z } from "zod";
import { createAuthorizationRequest } from "../auth";
import type { PersonalSessionStore } from "./store";

export class PersonalSessionError extends Error {
  constructor(
    readonly status: 401 | 400 | 403 | 409 | 503,
    readonly code:
      | "login_required"
      | "login_invalid"
      | "session_unavailable"
      | "erp_access_denied"
      | "authority_changed",
  ) {
    super(code);
    this.name = "PersonalSessionError";
  }
}
export interface PersonalIdentityConfiguration {
  application?: "factory" | "erp";
  origin: string;
  issuer: string;
  clientId: string;
  audience: string;
  jwksUri: string;
  apiBase: string;
  sessionKey: Uint8Array;
}
const Flow = z
  .object({
    kind: z.literal("flow"),
    state: z.string(),
    nonce: z.string(),
    codeVerifier: z.string(),
    returnPath: z.string().max(2000).optional(),
  })
  .strict();
const Session = z
  .object({
    kind: z.literal("session"),
    subject: z.string().min(1),
    tenantId: z.uuidv7(),
    accessToken: z.string().min(1).max(32768),
    refreshToken: z.string().min(1).max(32768).nullable(),
    accessExpiresAt: z.number().finite(),
  })
  .strict();
const Pending = z.object({ kind: z.literal("refreshing") }).strict();
const TokenReply = z.object({
  access_token: z.string().min(1).max(32768),
  id_token: z.string().min(1).max(32768).optional(),
  refresh_token: z.string().min(1).max(32768).optional(),
  expires_in: z.number().int().positive().max(86400),
});
type SessionRecord = z.infer<typeof Session>;
type Fetcher = typeof fetch;
const opaque = () => randomBytes(32).toString("base64url");
const equal = (a: string, b: string) => {
  const left = Buffer.from(a),
    right = Buffer.from(b);
  return left.byteLength === right.byteLength && timingSafeEqual(left, right);
};
export class PersonalIdentitySessions {
  private readonly jwks: ReturnType<typeof createRemoteJWKSet>;
  private readonly aad: Buffer;
  constructor(
    readonly configuration: PersonalIdentityConfiguration,
    private readonly store: PersonalSessionStore,
    private readonly fetcher: Fetcher = fetch,
  ) {
    if (configuration.sessionKey.byteLength !== 32)
      throw new PersonalSessionError(503, "session_unavailable");
    this.jwks = createRemoteJWKSet(new URL(configuration.jwksUri), { timeoutDuration: 5000 });
    this.aad = createHash("sha256")
      .update(
        `${configuration.application === "erp" ? "yummyai:erp-auth:v1" : "yummyai:factory-auth:v1"}:${configuration.origin}:${configuration.issuer}:${configuration.clientId}`,
      )
      .digest();
  }
  private callbackPath() {
    return this.configuration.application === "erp"
      ? "/api/erp-auth/callback"
      : "/api/factory-auth/callback";
  }
  private seal(value: unknown) {
    const iv = randomBytes(12),
      cipher = createCipheriv("aes-256-gcm", this.configuration.sessionKey, iv);
    cipher.setAAD(this.aad);
    const plain = Buffer.from(JSON.stringify(value));
    try {
      const body = Buffer.concat([cipher.update(plain), cipher.final()]);
      return `v1.${iv.toString("base64url")}.${cipher.getAuthTag().toString("base64url")}.${body.toString("base64url")}`;
    } finally {
      plain.fill(0);
    }
  }
  private open(value: string): unknown {
    try {
      if (value.length > 192000) throw Error();
      const [version, iv, tag, body, ...extra] = value.split(".");
      if (
        version !== "v1" ||
        extra.length ||
        !iv ||
        !tag ||
        !body ||
        !/^[A-Za-z0-9_-]+$/.test(iv + tag + body)
      )
        throw Error();
      const ivBytes = Buffer.from(iv, "base64url"),
        tagBytes = Buffer.from(tag, "base64url");
      if (ivBytes.byteLength !== 12 || tagBytes.byteLength !== 16) throw Error();
      const decipher = createDecipheriv("aes-256-gcm", this.configuration.sessionKey, ivBytes);
      decipher.setAAD(this.aad);
      decipher.setAuthTag(tagBytes);
      const plain = Buffer.concat([
        decipher.update(Buffer.from(body, "base64url")),
        decipher.final(),
      ]);
      try {
        return JSON.parse(plain.toString("utf8"));
      } finally {
        plain.fill(0);
      }
    } catch {
      throw new PersonalSessionError(401, "login_required");
    }
  }
  async start(returnPath?: string) {
    const c = this.configuration,
      request = await createAuthorizationRequest({
        authorizationEndpoint: `${c.issuer}/protocol/openid-connect/auth`,
        clientId: c.clientId,
        redirectUri: `${c.origin}${this.callbackPath()}`,
        scope: "openid profile",
        tokenEndpoint: `${c.issuer}/protocol/openid-connect/token`,
      }),
      flowId = opaque();
    await this.store.put(
      "flow",
      flowId,
      this.seal({
        kind: "flow",
        state: request.state,
        nonce: request.nonce,
        codeVerifier: request.codeVerifier,
        ...(this.configuration.application === "erp" ? { returnPath: returnPath ?? "/" } : {}),
      }),
      600,
    );
    return { flowId, url: request.url };
  }
  async finish(flowId: string | undefined, state: string, code: string) {
    if (
      !flowId ||
      !/^[A-Za-z0-9_-]{43}$/.test(flowId) ||
      state.length > 256 ||
      !code ||
      code.length > 4096
    )
      throw new PersonalSessionError(400, "login_invalid");
    const encrypted = await this.store.get("flow", flowId);
    if (!encrypted) throw new PersonalSessionError(400, "login_invalid");
    const parsed = Flow.safeParse(this.open(encrypted));
    if (
      !parsed.success ||
      !equal(parsed.data.state, state) ||
      !(await this.store.consumeFlow(flowId, encrypted))
    )
      throw new PersonalSessionError(400, "login_invalid");
    const tokens = await this.exchange({
      grant_type: "authorization_code",
      code,
      code_verifier: parsed.data.codeVerifier,
      redirect_uri: `${this.configuration.origin}${this.callbackPath()}`,
    });
    const session = await this.verifyTokens(tokens, { nonce: parsed.data.nonce });
    await this.assertMembership(session.accessToken);
    const sessionId = opaque();
    await this.store.put("session", sessionId, this.seal(session), 8 * 3600);
    return {
      sessionId,
      maxAge: 8 * 3600,
      ...(this.configuration.application === "erp"
        ? { returnPath: parsed.data.returnPath ?? "/" }
        : {}),
    };
  }
  async token(sessionId: string | undefined): Promise<string> {
    if (!sessionId || !/^[A-Za-z0-9_-]{43}$/.test(sessionId))
      throw new PersonalSessionError(401, "login_required");
    const encrypted = await this.store.get("session", sessionId);
    if (!encrypted) throw new PersonalSessionError(401, "login_required");
    const contents = this.open(encrypted);
    if (Pending.safeParse(contents).success) return this.awaitRefresh(sessionId, encrypted);
    const parsed = Session.safeParse(contents);
    if (!parsed.success) throw new PersonalSessionError(401, "login_required");
    const original = parsed.data;
    if (original.accessExpiresAt > Date.now() + 30000) return original.accessToken;
    if (!original.refreshToken) {
      await this.store.removeSession(sessionId);
      throw new PersonalSessionError(401, "login_required");
    }
    const lockOwner = opaque();
    if (!(await this.store.takeRefreshLock(sessionId, lockOwner))) {
      return this.awaitRefresh(sessionId, encrypted);
    }
    try {
      const latest = await this.store.get("session", sessionId);
      if (!latest) throw new PersonalSessionError(401, "login_required");
      if (latest !== encrypted) {
        const changed = Session.parse(this.open(latest));
        return changed.accessToken;
      }
      // Persist a non-replayable marker before the one-time rotating-token request.
      const marker = this.seal({ kind: "refreshing" });
      if (!(await this.store.replaceSession(sessionId, encrypted, marker)))
        throw new PersonalSessionError(401, "login_required");
      const tokens = await this.exchange({
        grant_type: "refresh_token",
        refresh_token: original.refreshToken,
      });
      const renewed = await this.verifyTokens(tokens, {
        subject: original.subject,
        tenantId: original.tenantId,
      });
      await this.assertMembership(renewed.accessToken);
      // CAS with KEEPTTL cannot recreate a logged-out session or extend its original lifetime.
      if (
        !(await this.store.replaceSession(
          sessionId,
          marker,
          this.seal({ ...renewed, refreshToken: renewed.refreshToken ?? original.refreshToken }),
        ))
      )
        throw new PersonalSessionError(401, "login_required");
      return renewed.accessToken;
    } catch (error) {
      await this.store.removeSession(sessionId).catch(() => {});
      throw error instanceof PersonalSessionError
        ? error
        : new PersonalSessionError(401, "login_required");
    } finally {
      await this.store.releaseRefreshLock(sessionId, lockOwner);
    }
  }
  async logout(sessionId: string | undefined) {
    if (sessionId && /^[A-Za-z0-9_-]{43}$/.test(sessionId))
      await this.store.removeSession(sessionId);
  }
  async assertLiveSession(sessionId: string | undefined) {
    if (!sessionId || !/^[A-Za-z0-9_-]{43}$/.test(sessionId))
      throw new PersonalSessionError(401, "login_required");
    const current = await this.store.get("session", sessionId);
    if (!current) throw new PersonalSessionError(401, "login_required");
    const value = this.open(current);
    if (!Session.safeParse(value).success && !Pending.safeParse(value).success)
      throw new PersonalSessionError(401, "login_required");
  }
  private async awaitRefresh(sessionId: string, previous: string) {
    for (let attempt = 0; attempt < 40; attempt++) {
      await delay(100);
      const next = await this.store.get("session", sessionId);
      if (!next) throw new PersonalSessionError(401, "login_required");
      if (next !== previous) {
        const parsed = Session.safeParse(this.open(next));
        if (parsed.success && parsed.data.accessExpiresAt > Date.now() + 5000)
          return parsed.data.accessToken;
      }
    }
    if (!(await this.store.isRefreshLocked(sessionId))) {
      await this.store.removeSession(sessionId).catch(() => {});
      throw new PersonalSessionError(401, "login_required");
    }
    throw new PersonalSessionError(503, "session_unavailable");
  }
  private async exchange(parameters: Record<string, string>) {
    let response: Response;
    try {
      response = await this.fetcher(`${this.configuration.issuer}/protocol/openid-connect/token`, {
        method: "POST",
        headers: { "content-type": "application/x-www-form-urlencoded" },
        body: new URLSearchParams({ client_id: this.configuration.clientId, ...parameters }),
        cache: "no-store",
        redirect: "error",
        signal: AbortSignal.timeout(10000),
      });
    } catch {
      throw new PersonalSessionError(401, "login_required");
    }
    if (!response.ok) throw new PersonalSessionError(401, "login_required");
    const body = await readIdentityJson(response, 128 * 1024);
    const parsed = TokenReply.safeParse(body);
    if (!parsed.success) throw new PersonalSessionError(400, "login_invalid");
    return parsed.data;
  }
  private async verifyTokens(
    tokens: z.infer<typeof TokenReply>,
    expected: { nonce?: string; subject?: string; tenantId?: string },
  ): Promise<SessionRecord> {
    try {
      const c = this.configuration,
        { payload: access } = await jwtVerify(tokens.access_token, this.jwks, {
          issuer: c.issuer,
          audience: c.audience,
          algorithms: ["RS256"],
          requiredClaims: ["sub", "exp", "tenant_id"],
          clockTolerance: 5,
        });
      const tenantId = z.uuidv7().parse(access.tenant_id);
      if (
        !access.sub ||
        access.azp !== c.clientId ||
        (expected.subject && access.sub !== expected.subject) ||
        (expected.tenantId && tenantId !== expected.tenantId)
      )
        throw Error();
      if (expected.nonce && !tokens.id_token) throw Error();
      if (tokens.id_token) {
        const { payload: id } = await jwtVerify(tokens.id_token, this.jwks, {
          issuer: c.issuer,
          audience: c.clientId,
          algorithms: ["RS256"],
          requiredClaims: ["sub", "exp"],
          clockTolerance: 5,
        });
        if (id.sub !== access.sub || (expected.nonce && id.nonce !== expected.nonce)) throw Error();
      }
      return {
        kind: "session",
        subject: access.sub,
        tenantId,
        accessToken: tokens.access_token,
        refreshToken: tokens.refresh_token ?? null,
        accessExpiresAt: Math.min(access.exp! * 1000, Date.now() + tokens.expires_in * 1000),
      };
    } catch {
      throw new PersonalSessionError(400, "login_invalid");
    }
  }
  private async assertMembership(token: string) {
    let response: Response;
    try {
      response = await this.fetcher(
        `${this.configuration.apiBase}${this.configuration.application === "erp" ? "/v1/identity/session" : "/v1/factory-portal/session"}`,
        {
          headers: { authorization: `Bearer ${token}` },
          cache: "no-store",
          redirect: "error",
          signal: AbortSignal.timeout(10000),
        },
      );
    } catch {
      throw new PersonalSessionError(503, "session_unavailable");
    }
    if (!response.ok) throw new PersonalSessionError(401, "login_required");
    const parsed = await readIdentityJson(
      response,
      this.configuration.application === "erp" ? 65536 : 4096,
    );
    if (
      !parsed ||
      typeof parsed !== "object" ||
      !("authenticated" in parsed) ||
      parsed.authenticated !== true
    )
      throw new PersonalSessionError(401, "login_required");
    if (
      this.configuration.application === "erp" &&
      !("canUseErp" in parsed && parsed.canUseErp === true)
    )
      throw new PersonalSessionError(403, "erp_access_denied");
  }
}
export async function readIdentityJson(response: Response, maxBytes: number) {
  if (!response.body) throw new PersonalSessionError(400, "login_invalid");
  const reader = response.body.getReader(),
    chunks: Uint8Array[] = [];
  let size = 0;
  try {
    for (;;) {
      const next = await reader.read();
      if (next.done) break;
      size += next.value.byteLength;
      if (size > maxBytes) throw new PersonalSessionError(400, "login_invalid");
      chunks.push(next.value);
    }
    return JSON.parse(Buffer.concat(chunks).toString("utf8")) as unknown;
  } catch (error) {
    throw error instanceof PersonalSessionError
      ? error
      : new PersonalSessionError(400, "login_invalid");
  } finally {
    await reader.cancel().catch(() => {});
    reader.releaseLock();
  }
}
