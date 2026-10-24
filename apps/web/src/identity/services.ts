import { createHash } from "node:crypto";
import {
  PersonalSessionError,
  PersonalIdentitySessions,
  type PersonalIdentityConfiguration,
} from "./core";
import { RedisPersonalSessionStore } from "./store";
import { identitySetting as setting, trustedIdentityUrl } from "./http";
const cached = new Map<
  string,
  { fingerprint: string; service: PersonalIdentitySessions; store: RedisPersonalSessionStore }
>();
export function personalIdentity(application: "factory" | "erp") {
  const rawKey = setting(
      application === "factory" ? "FACTORY_SESSION_ENCRYPTION_KEY" : "ERP_SESSION_ENCRYPTION_KEY",
    ),
    other =
      process.env[
        application === "factory" ? "ERP_SESSION_ENCRYPTION_KEY" : "FACTORY_SESSION_ENCRYPTION_KEY"
      ];
  if (!/^[A-Za-z0-9_-]{43}$/.test(rawKey) || other === rawKey)
    throw new PersonalSessionError(503, "session_unavailable");
  const issuer = trustedIdentityUrl(setting("OIDC_ISSUER")),
    origin = trustedIdentityUrl(
      setting(application === "factory" ? "FACTORY_PORTAL_ORIGIN" : "WEB_ORIGIN"),
      true,
    ),
    clientId = setting(application === "factory" ? "FACTORY_OIDC_CLIENT_ID" : "OIDC_WEB_CLIENT_ID"),
    audience = setting("OIDC_AUDIENCE"),
    redisUrl = setting("REDIS_URL"),
    apiBase = setting("API_BASE_URL").replace(/\/$/, "");
  try {
    const api = new URL(apiBase);
    if (
      !["http:", "https:"].includes(api.protocol) ||
      api.username ||
      api.password ||
      api.search ||
      api.hash
    )
      throw Error();
  } catch {
    throw new PersonalSessionError(503, "session_unavailable");
  }
  const configuration: PersonalIdentityConfiguration = {
    application,
    origin,
    issuer,
    clientId,
    audience,
    jwksUri: trustedIdentityUrl(
      process.env.OIDC_JWKS_URI ?? `${issuer}/protocol/openid-connect/certs`,
    ),
    apiBase,
    sessionKey: Buffer.from(rawKey, "base64url"),
  };
  const fingerprint = createHash("sha256")
      .update(JSON.stringify([application, configuration, rawKey, redisUrl]))
      .digest("hex"),
    old = cached.get(application);
  if (old?.fingerprint === fingerprint && !old.store.closed) return old.service;
  if (old) void old.store.close();
  const namespace = `yummyai:${application}-auth:v1:${createHash("sha256").update(`${origin}|${issuer}|${clientId}`).digest("hex")}`,
    store = new RedisPersonalSessionStore(redisUrl, namespace),
    service = new PersonalIdentitySessions(configuration, store);
  cached.set(application, { fingerprint, store, service });
  return service;
}
