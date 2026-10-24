import { createHash, randomUUID } from "node:crypto";
import fs from "node:fs/promises";
import net from "node:net";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { parseEnv } from "node:util";

const ROOT = fileURLToPath(new URL("../../", import.meta.url));
const OWNED_ROOT = path.join(ROOT, "tmp/ordinary-adoption-20261023-c8e4a173");
const VERSION = "ordinary-adoption-oidc-client-v1";
const CALLBACK = "http://127.0.0.1:3130/api/erp-auth/callback";
const WEB_ORIGIN = "http://127.0.0.1:3130";
const ORIGINAL_CALLBACK = "http://localhost:3000/api/erp-auth/callback";
const DIGEST = /^[a-f0-9]{64}$/;
const NONCE = /^[a-f0-9]{32}$/;
const RESOURCE = /^[a-zA-Z0-9_-]{1,100}$/;
type Operation = "create" | "readback" | "cleanup";
type State = "prepared" | "create_unknown" | "created" | "delete_unknown" | "deleted" | "absent";
type ObjectValue = Record<string, unknown>;
type Code = "invalid_arguments" | "unsupported_platform" | "manager_busy" | "configuration_invalid" |
  "receipt_path_invalid" | "receipt_missing" | "receipt_invalid" | "receipt_write_failed" |
  "admin_auth_failed" | "admin_request_failed" | "admin_response_invalid" | "admin_session_close_failed" |
  "original_client_invalid" | "original_client_changed" | "client_collision" | "client_missing" |
  "client_configuration_changed" | "client_create_unknown" | "client_delete_unknown" | "manager_failed";

export interface OrdinaryAdoptionOidcClientInput {
  operation: Operation;
  nonce: string;
  receiptPath?: string;
}
interface Receipt {
  version: typeof VERSION;
  nonce: string;
  clientId: string;
  audience: string;
  issuer: string;
  environmentSha256: string;
  originalClientId: string;
  originalResourceId: string;
  originalConfigurationSha256: string;
  desiredConfigurationSha256: string;
  resourceId: string | null;
  createdConfigurationSha256: string | null;
  state: State;
  creationAttemptedAt: string | null;
  deletionAttemptedAt: string | null;
  createdAt: string;
  updatedAt: string;
}
export interface OrdinaryAdoptionOidcClientReport {
  version: typeof VERSION;
  operation: Operation;
  nonce: string;
  clientId: string;
  audience: string;
  receiptPath: string;
  ok: boolean;
  outcome: State | "failed";
  resourceId: string | null;
  configurationSha256: string | null;
  originalConfigurationSha256: string | null;
  originalClientUnchanged: boolean;
  adminAuthenticationAttempted: boolean;
  adminSessionClosed: boolean;
  managerGateClosed: boolean;
  failures: Code[];
}
interface Configuration {
  issuer: string;
  origin: string;
  realm: string;
  originalClientId: string;
  adminUsername: string;
  adminPassword: string;
  environmentSha256: string;
}
class ManagerError extends Error {
  constructor(readonly code: Code) { super(code); this.name = "OrdinaryAdoptionOidcClientError"; }
}
function fail(code: Code): never { throw new ManagerError(code); }
const sha = (value: string | Uint8Array) => createHash("sha256").update(value).digest("hex");
const object = (value: unknown): value is ObjectValue => value !== null && typeof value === "object" && !Array.isArray(value);
const now = () => new Date().toISOString();
function canonical(value: unknown): string {
  if (value === null || typeof value === "string" || typeof value === "boolean") return JSON.stringify(value);
  if (typeof value === "number" && Number.isFinite(value)) return JSON.stringify(value);
  if (Array.isArray(value)) return "[" + value.map(canonical).join(",") + "]";
  if (object(value)) return "{" + Object.keys(value).sort().map(key => JSON.stringify(key) + ":" + canonical(value[key])).join(",") + "}";
  return fail("admin_response_invalid");
}
function strings(value: unknown): string[] {
  if (!Array.isArray(value) || value.length > 200 || value.some(item => typeof item !== "string" || item.length > 2000)) fail("admin_response_invalid");
  return [...value as string[]].sort();
}
function bool(value: unknown): boolean {
  if (typeof value !== "boolean") fail("admin_response_invalid");
  return value;
}
function resourceId(value: unknown): string {
  if (typeof value !== "string" || !RESOURCE.test(value)) fail("admin_response_invalid");
  return value;
}
function clientId(nonce: string) { return "ymy-adoption-c8e4a173-" + nonce; }
function audience(nonce: string) { return "ymy-adoption-api-c8e4a173-" + nonce; }
function desiredClient(nonce: string) {
  return {
    clientId: clientId(nonce), protocol: "openid-connect", enabled: true, publicClient: true,
    standardFlowEnabled: true, implicitFlowEnabled: false, directAccessGrantsEnabled: false,
    serviceAccountsEnabled: false, bearerOnly: false, redirectUris: [CALLBACK], webOrigins: [WEB_ORIGIN],
    attributes: { "pkce.code.challenge.method": "S256" },
    protocolMappers: [
      { name: "ERP original tenant attribute", protocol: "openid-connect", protocolMapper: "oidc-usermodel-attribute-mapper",
        config: { "user.attribute": "tenant_id", "claim.name": "tenant_id", "jsonType.label": "String", "access.token.claim": "true", "id.token.claim": "true", multivalued: "false" } },
      { name: "ERP adoption clone API audience", protocol: "openid-connect", protocolMapper: "oidc-audience-mapper",
        config: { "included.custom.audience": audience(nonce), "access.token.claim": "true" } },
    ],
  };
}
/** Only the explicitly controlled client policy, independent of Keycloak-generated mapper IDs. */
function controlledClient(raw: unknown) {
  if (!object(raw) || typeof raw.clientId !== "string" || raw.protocol !== "openid-connect" || !object(raw.attributes) || !Array.isArray(raw.protocolMappers) || raw.protocolMappers.length !== 2)
    fail("admin_response_invalid");
  const mappers = raw.protocolMappers.map(mapper => {
    if (!object(mapper) || typeof mapper.name !== "string" || mapper.protocol !== "openid-connect" || typeof mapper.protocolMapper !== "string" || !object(mapper.config) ||
      Object.values(mapper.config).some(value => typeof value !== "string")) fail("admin_response_invalid");
    const config = { ...mapper.config };
    // Keycloak materializes this mapper's true default during creation. Only
    // that exact default is normalized; false and every unknown setting remain
    // in the controlled comparison. The full configuration hash below keeps
    // the materialized setting, so a later change still blocks deletion.
    if (mapper.protocolMapper === "oidc-usermodel-attribute-mapper" && config["userinfo.token.claim"] === "true")
      delete config["userinfo.token.claim"];
    return { name: mapper.name, protocol: mapper.protocol, protocolMapper: mapper.protocolMapper, config };
  }).sort((a, b) => a.name.localeCompare(b.name));
  return {
    clientId: raw.clientId, protocol: raw.protocol, enabled: bool(raw.enabled), publicClient: bool(raw.publicClient),
    standardFlowEnabled: bool(raw.standardFlowEnabled), implicitFlowEnabled: bool(raw.implicitFlowEnabled),
    directAccessGrantsEnabled: bool(raw.directAccessGrantsEnabled), serviceAccountsEnabled: bool(raw.serviceAccountsEnabled),
    bearerOnly: bool(raw.bearerOnly), redirectUris: strings(raw.redirectUris), webOrigins: strings(raw.webOrigins),
    attributes: { "pkce.code.challenge.method": raw.attributes["pkce.code.challenge.method"] }, protocolMappers: mappers,
  };
}
/** No credential field is saved. Other public configuration changes still invalidate the recorded hash. */
function publicConfigurationHash(raw: unknown): string {
  if (!object(raw)) fail("admin_response_invalid");
  const excluded = new Set(["secret", "registrationAccessToken", "access", "registeredNodes"]);
  const value = Object.fromEntries(Object.entries(raw).filter(([key]) => !excluded.has(key)));
  for (const key of ["redirectUris", "webOrigins", "defaultClientScopes", "optionalClientScopes"])
    if (value[key] !== undefined) value[key] = strings(value[key]);
  if (Array.isArray(value.protocolMappers)) value.protocolMappers = [...value.protocolMappers].sort((a, b) => canonical(a).localeCompare(canonical(b)));
  return sha(canonical(value));
}
function assertOwnedClient(raw: unknown, nonce: string, id?: string): ObjectValue {
  if (!object(raw) || raw.clientId !== clientId(nonce) || id !== undefined && raw.id !== id) fail("client_configuration_changed");
  resourceId(raw.id);
  if (canonical(controlledClient(raw)) !== canonical(controlledClient(desiredClient(nonce)))) fail("client_configuration_changed");
  return raw;
}
async function configuration(): Promise<Configuration> {
  const envPath = path.join(ROOT, ".env");
  let bytes: Buffer | undefined;
  try {
    const stat = await fs.lstat(envPath);
    if (!stat.isFile() || stat.isSymbolicLink() || stat.size > 1024 * 1024) fail("configuration_invalid");
    bytes = await fs.readFile(envPath);
    const environmentSha256 = sha(bytes), env = parseEnv(new TextDecoder("utf-8", { fatal: true }).decode(bytes));
    const issuer = new URL(env.OIDC_ISSUER ?? "invalid:");
    const realm = /^\/realms\/([A-Za-z0-9_-]+)\/?$/.exec(issuer.pathname)?.[1];
    if (!["http:", "https:"].includes(issuer.protocol) || !["localhost", "127.0.0.1", "[::1]"].includes(issuer.hostname) ||
      issuer.username || issuer.password || issuer.search || issuer.hash || !realm || !env.OIDC_WEB_CLIENT_ID ||
      env.OIDC_WEB_CLIENT_ID.startsWith("ymy-adoption-") || !env.KEYCLOAK_ADMIN || !env.KEYCLOAK_ADMIN_PASSWORD) fail("configuration_invalid");
    const result = { issuer: issuer.href.replace(/\/$/, ""), origin: issuer.origin, realm,
      originalClientId: env.OIDC_WEB_CLIENT_ID, adminUsername: env.KEYCLOAK_ADMIN, adminPassword: env.KEYCLOAK_ADMIN_PASSWORD, environmentSha256 };
    for (const key of Object.keys(env)) delete env[key];
    return result;
  } catch { return fail("configuration_invalid"); }
  finally { bytes?.fill(0); }
}
function insideOwned(file: string) {
  const relative = path.relative(OWNED_ROOT, file);
  return relative.length > 0 && !relative.startsWith("..") && !path.isAbsolute(relative);
}
async function receiptPathFor(input: OrdinaryAdoptionOidcClientInput): Promise<string> {
  const file = input.receiptPath ?? path.join(OWNED_ROOT, "identity", input.nonce, "oidc-client.json");
  if (!path.isAbsolute(file) || !insideOwned(path.resolve(file)) || path.extname(file) !== ".json") fail("receipt_path_invalid");
  let current = path.resolve(file);
  while (true) {
    try { if ((await fs.lstat(current)).isSymbolicLink()) fail("receipt_path_invalid"); }
    catch (error) { if (error instanceof ManagerError) throw error; if ((error as NodeJS.ErrnoException).code !== "ENOENT") fail("receipt_path_invalid"); }
    const parent = path.dirname(current); if (parent === current) break; current = parent;
  }
  return path.resolve(file);
}
function parseReceipt(raw: unknown, input: OrdinaryAdoptionOidcClientInput, config: Configuration): Receipt {
  const keys = ["version", "nonce", "clientId", "audience", "issuer", "environmentSha256", "originalClientId", "originalResourceId", "originalConfigurationSha256", "desiredConfigurationSha256", "resourceId", "createdConfigurationSha256", "state", "creationAttemptedAt", "deletionAttemptedAt", "createdAt", "updatedAt"];
  if (!object(raw) || Object.keys(raw).length !== keys.length || keys.some(key => !(key in raw)) || raw.version !== VERSION || raw.nonce !== input.nonce ||
    raw.clientId !== clientId(input.nonce) || raw.audience !== audience(input.nonce) || raw.issuer !== config.issuer || typeof raw.environmentSha256 !== "string" || !DIGEST.test(raw.environmentSha256) ||
    raw.originalClientId !== config.originalClientId || typeof raw.originalResourceId !== "string" || !RESOURCE.test(raw.originalResourceId) ||
    [raw.originalConfigurationSha256, raw.desiredConfigurationSha256].some(value => typeof value !== "string" || !DIGEST.test(value)) ||
    raw.desiredConfigurationSha256 !== sha(canonical(controlledClient(desiredClient(input.nonce)))) ||
    raw.resourceId !== null && (typeof raw.resourceId !== "string" || !RESOURCE.test(raw.resourceId)) ||
    raw.createdConfigurationSha256 !== null && (typeof raw.createdConfigurationSha256 !== "string" || !DIGEST.test(raw.createdConfigurationSha256)) ||
    !["prepared", "create_unknown", "created", "delete_unknown", "deleted", "absent"].includes(String(raw.state)) ||
    [raw.createdAt, raw.updatedAt].some(value => typeof value !== "string" || !Number.isFinite(Date.parse(value))) ||
    [raw.creationAttemptedAt, raw.deletionAttemptedAt].some(value => value !== null && (typeof value !== "string" || !Number.isFinite(Date.parse(value)))) ||
    raw.state === "created" && (raw.resourceId === null || raw.createdConfigurationSha256 === null || raw.creationAttemptedAt === null) ||
    raw.state === "deleted" && (raw.resourceId === null || raw.deletionAttemptedAt === null)) fail("receipt_invalid");
  return raw as unknown as Receipt;
}
async function readReceipt(file: string, input: OrdinaryAdoptionOidcClientInput, config: Configuration) {
  try {
    const stat = await fs.lstat(file); if (!stat.isFile() || stat.isSymbolicLink() || stat.size > 32 * 1024) fail("receipt_invalid");
    return parseReceipt(JSON.parse(await fs.readFile(file, "utf8")), input, config);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
    if (error instanceof ManagerError) throw error;
    return fail("receipt_invalid");
  }
}
async function saveReceipt(file: string, receipt: Receipt, fresh = false) {
  const temporary = file + ".tmp-" + randomUUID();
  let handle: Awaited<ReturnType<typeof fs.open>> | undefined;
  try {
    await fs.mkdir(path.dirname(file), { recursive: true });
    handle = await fs.open(fresh ? file : temporary, "wx", 0o600);
    await handle.writeFile(JSON.stringify(receipt, null, 2) + "\n", "utf8"); await handle.sync(); await handle.close(); handle = undefined;
    if (!fresh) await fs.rename(temporary, file);
  } catch { fail("receipt_write_failed"); }
  finally { await handle?.close().catch(() => {}); if (!fresh) await fs.unlink(temporary).catch(() => {}); }
}
async function boundedJson(response: Response, limit: number): Promise<unknown> {
  if (!response.headers.get("content-type")?.toLowerCase().includes("application/json")) { await response.body?.cancel(); fail("admin_response_invalid"); }
  const reader = response.body?.getReader(); if (!reader) fail("admin_response_invalid");
  const chunks: Uint8Array[] = []; let total = 0;
  try {
    while (true) { const next = await reader.read(); if (next.done) break; total += next.value.byteLength;
      if (total > limit) { await reader.cancel(); fail("admin_response_invalid"); } chunks.push(next.value); }
    return JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(Buffer.concat(chunks)));
  } catch { return fail("admin_response_invalid"); } finally { reader.releaseLock(); }
}
class Administrator {
  private access: string | undefined;
  private refresh: string | undefined;
  attempted = false;
  constructor(private readonly config: Configuration) {}
  private async fetch(relative: string, init: RequestInit) {
    try { return await fetch(this.config.origin + relative, { ...init, redirect: "error", cache: "no-store", credentials: "omit", signal: AbortSignal.timeout(8000) }); }
    catch { return fail("admin_request_failed"); }
  }
  async login() {
    this.attempted = true;
    const response = await this.fetch("/realms/master/protocol/openid-connect/token", { method: "POST", headers: { "content-type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({ client_id: "admin-cli", grant_type: "password", username: this.config.adminUsername, password: this.config.adminPassword }) });
    if (response.status !== 200) { await response.body?.cancel(); fail("admin_auth_failed"); }
    const raw = await boundedJson(response, 64 * 1024);
    if (!object(raw)) fail("admin_auth_failed");
    if (typeof raw.access_token === "string" && raw.access_token.length <= 32 * 1024) this.access = raw.access_token;
    if (typeof raw.refresh_token === "string" && raw.refresh_token.length <= 32 * 1024) this.refresh = raw.refresh_token;
    if (!this.access || !this.refresh) fail("admin_auth_failed");
  }
  private base() { return "/admin/realms/" + encodeURIComponent(this.config.realm) + "/clients"; }
  private async request(relative: string, method: "GET" | "POST" | "DELETE", body?: unknown) {
    if (!this.access) fail("admin_auth_failed");
    return this.fetch(relative, { method, headers: { authorization: "Bearer " + this.access, ...(body === undefined ? {} : { "content-type": "application/json" }) },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
  }
  async find(id: string): Promise<ObjectValue | null> {
    const response = await this.request(this.base() + "?" + new URLSearchParams({ clientId: id }), "GET");
    if (response.status !== 200) { await response.body?.cancel(); fail("admin_request_failed"); }
    const raw = await boundedJson(response, 512 * 1024);
    if (!Array.isArray(raw) || raw.length > 1 || raw.some(value => !object(value) || value.clientId !== id)) fail("admin_response_invalid");
    const item = raw[0]; if (!item) return null; resourceId(item.id); return item;
  }
  async read(id: string): Promise<ObjectValue | null> {
    const response = await this.request(this.base() + "/" + encodeURIComponent(resourceId(id)), "GET");
    if (response.status === 404) { await response.body?.cancel(); return null; }
    if (response.status !== 200) { await response.body?.cancel(); fail("admin_request_failed"); }
    const raw = await boundedJson(response, 512 * 1024);
    if (!object(raw) || raw.id !== id) fail("admin_response_invalid"); return raw;
  }
  async create(nonce: string): Promise<string> {
    const response = await this.request(this.base(), "POST", desiredClient(nonce));
    if (response.status !== 201) { await response.body?.cancel(); fail("client_create_unknown"); }
    const location = response.headers.get("location"); await response.body?.cancel();
    if (!location) fail("client_create_unknown");
    let value: URL; try { value = new URL(location, this.config.origin); } catch { return fail("client_create_unknown"); }
    const prefix = this.base() + "/", id = value.pathname.slice(prefix.length);
    if (value.origin !== this.config.origin || !value.pathname.startsWith(prefix) || value.search || value.hash || !RESOURCE.test(id)) fail("client_create_unknown");
    return id;
  }
  async remove(id: string) {
    const response = await this.request(this.base() + "/" + encodeURIComponent(resourceId(id)), "DELETE");
    if (response.status !== 204 && response.status !== 404) { await response.body?.cancel(); fail("client_delete_unknown"); }
    await response.body?.cancel();
  }
  async close(): Promise<boolean> {
    try {
      if (!this.attempted) return true; if (!this.refresh) return false;
      const response = await this.fetch("/realms/master/protocol/openid-connect/logout", { method: "POST", headers: { "content-type": "application/x-www-form-urlencoded" },
        body: new URLSearchParams({ client_id: "admin-cli", refresh_token: this.refresh }) });
      await response.body?.cancel(); return response.status === 204;
    } catch { return false; } finally { this.access = undefined; this.refresh = undefined; this.config.adminPassword = ""; }
  }
}
async function originalUnchanged(admin: Administrator, config: Configuration, receipt: Receipt) {
  const original = await admin.read(receipt.originalResourceId);
  if (!original || original.clientId !== config.originalClientId || publicConfigurationHash(original) !== receipt.originalConfigurationSha256) fail("original_client_changed");
}
async function gate(nonce: string) {
  if (process.platform !== "win32") fail("unsupported_platform");
  const server = net.createServer(socket => socket.destroy());
  try {
    await new Promise<void>((resolve, reject) => {
      server.once("error", () => reject(new ManagerError("manager_busy")));
      server.listen({ path: "\\\\.\\pipe\\yummyai-adoption-oidc-" + sha(ROOT.toLowerCase() + ":" + nonce).slice(0, 32), exclusive: true }, resolve);
    });
  } catch { if (server.listening) await new Promise<void>(resolve => server.close(() => resolve())); return fail("manager_busy"); }
  return server;
}

/** No work runs on import. The only remote mutation is the exact nonce client create/delete. */
export async function manageOrdinaryAdoptionOidcClient(input: OrdinaryAdoptionOidcClientInput): Promise<OrdinaryAdoptionOidcClientReport> {
  if (!object(input) || Object.keys(input).some(key => !["operation", "nonce", "receiptPath"].includes(key)) ||
    !["create", "readback", "cleanup"].includes(input.operation) || typeof input.nonce !== "string" || !NONCE.test(input.nonce) ||
    input.receiptPath !== undefined && typeof input.receiptPath !== "string") fail("invalid_arguments");
  const file = await receiptPathFor(input), server = await gate(input.nonce);
  const report: OrdinaryAdoptionOidcClientReport = { version: VERSION, operation: input.operation, nonce: input.nonce, clientId: clientId(input.nonce), audience: audience(input.nonce),
    receiptPath: path.relative(ROOT, file).replaceAll("\\", "/"), ok: false, outcome: "failed", resourceId: null, configurationSha256: null, originalConfigurationSha256: null,
    originalClientUnchanged: false, adminAuthenticationAttempted: false, adminSessionClosed: false, managerGateClosed: false, failures: [] };
  let config: Configuration | undefined, admin: Administrator | undefined, receipt: Receipt | null = null;
  try {
    config = await configuration(); admin = new Administrator(config); receipt = await readReceipt(file, input, config);
    if (!receipt && input.operation !== "create") fail("receipt_missing");
    await admin.login();
    if (!receipt) {
      const originalMatch = await admin.find(config.originalClientId);
      const original = originalMatch ? await admin.read(resourceId(originalMatch.id)) : null;
      if (!original || !strings(original.redirectUris).includes(ORIGINAL_CALLBACK)) fail("original_client_invalid");
      if (await admin.find(clientId(input.nonce))) fail("client_collision");
      const time = now(); receipt = { version: VERSION, nonce: input.nonce, clientId: clientId(input.nonce), audience: audience(input.nonce), issuer: config.issuer,
        environmentSha256: config.environmentSha256, originalClientId: config.originalClientId, originalResourceId: resourceId(original.id), originalConfigurationSha256: publicConfigurationHash(original),
        desiredConfigurationSha256: sha(canonical(controlledClient(desiredClient(input.nonce)))), resourceId: null, createdConfigurationSha256: null, state: "prepared",
        creationAttemptedAt: null, deletionAttemptedAt: null, createdAt: time, updatedAt: time };
      await saveReceipt(file, receipt, true);
    }
    await originalUnchanged(admin, config, receipt); report.originalClientUnchanged = true;
    if (input.operation === "create" && receipt.state === "prepared" && receipt.creationAttemptedAt === null) {
      if (await admin.find(receipt.clientId)) fail("client_collision");
      receipt.state = "create_unknown"; receipt.creationAttemptedAt = now(); receipt.updatedAt = now(); await saveReceipt(file, receipt);
      receipt.resourceId = await admin.create(input.nonce); receipt.updatedAt = now(); await saveReceipt(file, receipt);
    }
    let current: ObjectValue | null;
    if (receipt.resourceId) {
      current = await admin.read(receipt.resourceId);
      if (!current && await admin.find(receipt.clientId)) fail("client_collision");
    } else {
      const match = await admin.find(receipt.clientId);
      current = match ? await admin.read(resourceId(match.id)) : null;
    }
    if (current) {
      if (receipt.creationAttemptedAt === null) fail("client_collision");
      assertOwnedClient(current, input.nonce, receipt.resourceId ?? undefined);
      const currentHash = publicConfigurationHash(current);
      if (receipt.createdConfigurationSha256 !== null && currentHash !== receipt.createdConfigurationSha256) fail("client_configuration_changed");
      receipt.resourceId = resourceId(current.id); receipt.createdConfigurationSha256 = currentHash;
      receipt.state = "created"; receipt.updatedAt = now(); await saveReceipt(file, receipt);
    } else if (input.operation !== "cleanup" && !["deleted", "absent"].includes(receipt.state)) {
      fail(receipt.creationAttemptedAt === null ? "client_missing" : "client_create_unknown");
    }
    if (input.operation === "cleanup") {
      if (current) {
        await originalUnchanged(admin, config, receipt);
        receipt.state = "delete_unknown"; receipt.deletionAttemptedAt = now(); receipt.updatedAt = now(); await saveReceipt(file, receipt);
        await admin.remove(receipt.resourceId!);
        current = await admin.read(receipt.resourceId!); if (current) fail("client_delete_unknown");
        if (await admin.find(receipt.clientId)) fail("client_collision");
        receipt.state = "deleted";
      } else receipt.state = "absent";
      receipt.updatedAt = now(); await saveReceipt(file, receipt);
    }
    await originalUnchanged(admin, config, receipt);
    report.outcome = receipt.state;
  } catch (error) {
    report.failures.push(error instanceof ManagerError ? error.code : "manager_failed");
    if (report.failures.includes("original_client_changed")) report.originalClientUnchanged = false;
  } finally {
    report.adminAuthenticationAttempted = admin?.attempted ?? false;
    report.adminSessionClosed = admin ? await admin.close() : true;
    if (config) config.adminPassword = "";
    if (!report.adminSessionClosed) report.failures.push("admin_session_close_failed");
    report.managerGateClosed = await new Promise<boolean>(resolve => server.close(error => resolve(!error)));
    if (!report.managerGateClosed) report.failures.push("manager_failed");
    if (receipt) { report.resourceId = receipt.resourceId; report.configurationSha256 = receipt.createdConfigurationSha256; report.originalConfigurationSha256 = receipt.originalConfigurationSha256;
      if (report.failures.length) report.outcome = receipt.state; }
  }
  report.ok = report.failures.length === 0 && report.originalClientUnchanged && report.adminSessionClosed && report.managerGateClosed;
  return report;
}
function cliInput(args: string[]): OrdinaryAdoptionOidcClientInput {
  const operation = args[0]; if (!["create", "readback", "cleanup"].includes(operation ?? "")) fail("invalid_arguments");
  const values = new Map<string, string>();
  for (const argument of args.slice(1)) {
    const match = /^--(nonce|receipt)=(.+)$/.exec(argument); if (!match || values.has(match[1]!)) fail("invalid_arguments"); values.set(match[1]!, match[2]!);
  }
  const nonce = values.get("nonce"); if (!nonce || !NONCE.test(nonce)) fail("invalid_arguments");
  return { operation: operation as Operation, nonce, ...(values.has("receipt") ? { receiptPath: values.get("receipt")! } : {}) };
}
if (process.argv[1] && pathToFileURL(path.resolve(process.argv[1])).href === import.meta.url) {
  void (async () => {
    try {
      const report = await manageOrdinaryAdoptionOidcClient(cliInput(process.argv.slice(2)));
      process.stdout.write(JSON.stringify(report) + "\n"); if (!report.ok) process.exitCode = 1;
    } catch (error) {
      process.stderr.write(JSON.stringify({ ok: false, code: error instanceof ManagerError ? error.code : "manager_failed" }) + "\n"); process.exitCode = 1;
    }
  })();
}
