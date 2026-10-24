import { createHash, randomBytes } from "node:crypto";
import { createServer, request as httpsRequest } from "node:https";
import { readFile, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import type { Duplex } from "node:stream";
import type { StoreNodeExecutionRequestClass } from "@yummyai/contracts/marketplace/store-node-execution";

export function executionLatch() { let release!: () => void; const promise = new Promise<void>(done => { release = done; }); return { promise, release }; }
export async function executionBounded<T>(promise: Promise<T>, code: string, ms = 30_000): Promise<T> {
  let timer: NodeJS.Timeout | undefined;
  try { return await Promise.race([promise, new Promise<never>((_, fail) => { timer = setTimeout(() => fail(new Error(code)), ms); })]); }
  finally { if (timer) clearTimeout(timer); }
}
type RequestKind = StoreNodeExecutionRequestClass | "etsy_oauth";
type Fault = "none" | "lose" | "unauthorized" | "rate_limited" | "upstream" | "timeout" | "redirect" | "secret" | "oversized";
type ProviderRecord = { ordinal: number; kind: RequestKind; method: string; status: number | null; node: boolean; credentialAccepted: boolean; responseFinished: boolean };
/** Only an external HTTPS boundary. All facts are still parsed by the original HTTP capability gateway. */
export async function startStoreNodeExecutionProvider(files: { key: Buffer; cert: string; ca: string }, directory: string) {
  const suffix = randomBytes(18).toString("hex");
  const secrets = { centralApp: "SYNTHETIC-CENTRAL-" + suffix, nodeApp: "SYNTHETIC-NODE-" + suffix,
    privateClient: "SYNTHETIC-PRIVATE-" + suffix, privateRefresh: "SYNTHETIC-PRIVATE-REFRESH-" + suffix,
    privateSecret: "SYNTHETIC-PRIVATE-SECRET-" + suffix, error: "SYNTHETIC-PROVIDER-ERROR-" + suffix };
  const clientId = "synthetic-execution-client-" + suffix, sellerId = "SYNTHETIC-SELLER-" + suffix;
  const codes = new Map<string, { verifier: string; redirect: string; client: string; user: number }>();
  const refreshes = new Map<string, number>(), access = new Map<string, number>();
  const needles = new Set<string>(Object.values(secrets));
  const records: ProviderRecord[] = [], sockets = new Set<Duplex>();
  let user = 20_000_000 + randomBytes(3).readUIntBE(0, 3), gate: { kind: RequestKind; entered: ReturnType<typeof executionLatch>; release: ReturnType<typeof executionLatch>; used: boolean } | undefined;
  const controls = { fault: "none" as Fault, faultKind: null as RequestKind | null, schemaOutsideDefinition: false };
  const schema = { $schema: "https://json-schema.org/draft/2020-12/schema", type: "object", properties: { item_name: { type: "string", minLength: 1 },
    fixture_unit_amount_minor: { const: 12345 }, fixture_currency: { const: "USD" } }, required: ["item_name"], additionalProperties: false };
  const metaSchema = { $schema: "https://json-schema.org/draft/2020-12/schema", title: "Synthetic original Amazon meta schema", type: "object" };
  const sha = (value: unknown) => createHash("sha256").update(JSON.stringify(value)).digest("hex");
  const kindFor = (path: string, method: string, body: URLSearchParams): RequestKind | undefined => {
    if (method === "POST" && path === "/auth/o2/token") return "amazon_lwa";
    if (method === "POST" && path === "/v3/public/oauth/token") return body.get("grant_type") === "authorization_code" ? "etsy_oauth" : "etsy_refresh";
    if (method !== "GET") return undefined;
    if (path === "/sellers/v1/marketplaceParticipations") return "amazon_participations";
    if (/^\/definitions\/2020-09-01\/productTypes\/[A-Z0-9_]+$/.test(path)) return "amazon_product_definition";
    if (path === "/synthetic-bound-schema/schema.json") return "amazon_schema";
    if (path === "/synthetic-bound-schema/meta.json") return "amazon_meta_schema";
    if (/^\/v3\/application\/users\/\d+\/shops$/.test(path)) return "etsy_shop";
    if (/\/sections$/.test(path)) return "etsy_sections";
    if (/\/policies\/return$/.test(path)) return "etsy_return_policies";
    if (/\/shipping-profiles$/.test(path)) return "etsy_shipping_profiles";
    if (/\/readiness-state-definitions$/.test(path)) return "etsy_readiness_profiles";
    if (/\/seller-taxonomy\/nodes\/\d+\/properties$/.test(path)) return "etsy_taxonomy_properties";
    if (path === "/v3/application/seller-taxonomy/nodes") return "etsy_taxonomy";
    return undefined;
  };
  const server = createServer({ key: files.key, cert: files.cert, minVersion: "TLSv1.3" }, async (request, response) => {
    let record: ProviderRecord | undefined;
    try {
      const url = new URL(request.url ?? "/", "https://127.0.0.1"), chunks: Buffer[] = []; let size = 0;
      for await (const chunk of request) { size += chunk.length; if (size > 131072) throw new Error("bounded_provider_input"); chunks.push(Buffer.from(chunk)); }
      const body = new URLSearchParams(Buffer.concat(chunks).toString("utf8")), kind = kindFor(url.pathname, request.method ?? "", body);
      if (!kind) { response.writeHead(404); response.end(); return; }
      const node = request.headers["x-synthetic-node-transport"] === "1";
      record = { ordinal: records.length + 1, kind, method: request.method!, status: null, node, credentialAccepted: false, responseFinished: false }; records.push(record);
      response.once("finish", () => { record!.responseFinished = true; });
      const held = gate; if (held?.kind === kind && !held.used) { held.used = true; held.entered.release(); await held.release.promise; }
      const send = (status: number, output: unknown) => { record!.status = status; response.writeHead(status, { "content-type": "application/json", ...(status === 429 ? { "retry-after": "1" } : {}) }); response.end(JSON.stringify(output)); };
      if (controls.fault !== "none" && controls.faultKind === kind) {
        if (controls.fault === "timeout") { await new Promise<void>(done => { response.once("close", done); request.once("aborted", done); }); return; }
        if (controls.fault === "lose") { record.status = 200; response.destroy(); return; }
        if (controls.fault === "redirect") { record.status = 302; response.writeHead(302, { location: "https://exfiltration.invalid/stolen" }); response.end(); return; }
        if (controls.fault === "oversized") { send(200, { results: ["X".repeat(17 * 1024 * 1024)] }); return; }
        if (controls.fault === "secret") { send(200, { count: 1, results: [{ note: secrets.nodeApp }] }); return; }
        send(controls.fault === "unauthorized" ? 401 : controls.fault === "rate_limited" ? 429 : 503, { error: secrets.error }); return;
      }
      if (kind === "amazon_lwa") {
        if (body.get("client_id") !== secrets.privateClient || body.get("client_secret") !== secrets.privateSecret || body.get("refresh_token") !== secrets.privateRefresh) { send(401, {}); return; }
        record.credentialAccepted = true; const token = "SYNTHETIC-AMAZON-ACCESS-" + randomBytes(16).toString("hex"); access.set(token, 1); needles.add(token);
        send(200, { access_token: token, token_type: "Bearer", expires_in: 3600 }); return;
      }
      if (kind === "etsy_oauth" || kind === "etsy_refresh") {
        let id: number | undefined;
        if (kind === "etsy_oauth") { const code = codes.get(body.get("code") ?? ""); codes.delete(body.get("code") ?? "");
          if (code && code.verifier === createHash("sha256").update(body.get("code_verifier") ?? "").digest("base64url") && code.redirect === body.get("redirect_uri") && code.client === body.get("client_id")) id = code.user;
        } else { const previous = body.get("refresh_token") ?? ""; id = refreshes.get(previous); refreshes.delete(previous); }
        if (!id || body.get("client_id") !== clientId) { send(400, { error: secrets.error }); return; }
        record.credentialAccepted = true; const refresh = "SYNTHETIC-ROTATED-" + randomBytes(24).toString("hex"), token = id + "." + randomBytes(24).toString("hex");
        refreshes.set(refresh, id); access.set(token, id); needles.add(refresh); needles.add(token);
        send(200, { access_token: token, refresh_token: refresh, expires_in: 3600, token_type: "Bearer" }); return;
      }
      if (kind.startsWith("etsy_")) {
        const id = access.get(String(request.headers.authorization ?? "").replace(/^Bearer /, ""));
        if (!id || request.headers["x-api-key"] !== clientId + ":" + secrets.nodeApp) { send(401, { error: secrets.error }); return; }
        record.credentialAccepted = true;
        if (kind === "etsy_shop") { if (!url.pathname.includes("/users/" + id + "/")) { send(403, {}); return; }
          send(200, { shop_id: id + 1_000_000, user_id: id, shop_name: "Synthetic original Etsy node shop" });
        } else send(200, { count: 1, results: [{ id: kind === "etsy_taxonomy_properties" ? Number(/nodes\/(\d+)/.exec(url.pathname)?.[1]) : 42,
          name: "Synthetic original " + kind, fixture_unit_amount_minor: 12345, fixture_currency: "USD" }] });
        return;
      }
      if (kind !== "amazon_schema" && kind !== "amazon_meta_schema" && !access.has(String(request.headers["x-amz-access-token"] ?? ""))) { send(401, {}); return; }
      record.credentialAccepted = true;
      if (kind === "amazon_participations") send(200, { payload: [{ marketplace: { id: "ATVPDKIKX0DER", countryCode: "US", name: "Synthetic Amazon US" }, participation: { isParticipating: true, hasSuspendedListings: false } }] });
      else if (kind === "amazon_product_definition") send(200, { marketplaceIds: ["ATVPDKIKX0DER"], productType: url.pathname.split("/").at(-1), productTypeVersion: { version: "synthetic-original-1" }, requirements: "LISTING", requirementsEnforced: "ENFORCED",
        schema: { link: { resource: controls.schemaOutsideDefinition ? "https://outside.invalid/schema.json" : "https://schema.amazonaws.com/synthetic-bound-schema/schema.json", checksum: sha(schema) } },
        metaSchema: { link: { resource: "https://schema.amazonaws.com/synthetic-bound-schema/meta.json", checksum: sha(metaSchema) } } });
      else send(200, kind === "amazon_schema" ? schema : metaSchema);
    } catch { if (!response.headersSent) response.writeHead(500, { "content-type": "application/json" }); response.end('{"error":"synthetic_provider_boundary_failed"}'); }
  });
  server.on("connection", socket => { sockets.add(socket); socket.once("close", () => sockets.delete(socket)); });
  await new Promise<void>((done, fail) => { server.once("error", fail); server.listen(0, "127.0.0.1", done); });
  const address = server.address(); if (!address || typeof address === "string") throw new Error("store_node_provider_address_invalid");
  const origin = `https://127.0.0.1:${address.port}`;
  const request: typeof fetch = async (input, init) => {
    const url = new URL(input instanceof Request ? input.url : String(input));
    if (!["https://api.amazon.com", "https://api.etsy.com", "https://openapi.etsy.com", "https://sellingpartnerapi-na.amazon.com", "https://schema.amazonaws.com"].includes(url.origin)) throw new Error("store_node_provider_origin_not_registered");
    const headers = new Headers(init?.headers), data = init?.body == null ? undefined : String(init.body);
    return new Promise<Response>((done, fail) => { const remote = httpsRequest(origin + url.pathname + url.search, { method: init?.method ?? "GET", headers: Object.fromEntries(headers), ca: files.ca, rejectUnauthorized: true, signal: init?.signal ?? undefined }, response => {
      const parts: Buffer[] = []; response.on("data", (part: Buffer) => parts.push(part)); response.once("error", () => fail(new Error("store_node_provider_response_failed")));
      response.once("end", () => done(new Response(Buffer.concat(parts), { status: response.statusCode, headers: Object.fromEntries(Object.entries(response.headers).filter(([, v]) => typeof v === "string")) as Record<string, string> }))); });
      remote.once("error", () => fail(new Error("store_node_provider_transport_failed"))); remote.end(data);
    });
  };
  const caPath = resolve(directory, "provider-ca.pem"); await writeFile(caPath, files.ca, { flag: "wx", mode: 0o600 });
  return { origin, caPath, clientId, sellerId, controls, secrets, records, schema, metaSchema,
    get secretValues() { return [...needles]; },
    privateInput: { clientId: secrets.privateClient, clientSecret: secrets.privateSecret, refreshToken: secrets.privateRefresh, sellingPartnerId: sellerId },
    environment: { ETSY_APP_KEYSTRING: clientId, ETSY_APP_SHARED_SECRET: secrets.centralApp, ETSY_OAUTH_REDIRECT_URI: "https://synthetic-erp.invalid/callback" },
    nodeEnvironment: { STORE_NODE_ETSY_APP_KEYSTRING: clientId, STORE_NODE_ETSY_APP_SHARED_SECRET: secrets.nodeApp }, request,
    code(raw: string) { const url = new URL(raw); if (url.origin !== "https://www.etsy.com" || url.pathname !== "/oauth/connect" || url.searchParams.get("code_challenge_method") !== "S256") throw new Error("store_node_provider_expected_real_pkce");
      const code = "SYNTHETIC-CODE-" + randomBytes(24).toString("hex"); needles.add(code); codes.set(code, { client: url.searchParams.get("client_id")!, verifier: url.searchParams.get("code_challenge")!, redirect: url.searchParams.get("redirect_uri")!, user: ++user });
      return { state: url.searchParams.get("state")!, code }; },
    arm(kind: RequestKind) { if (gate && !gate.used) throw new Error("store_node_provider_gate_unused"); gate = { kind, entered: executionLatch(), release: executionLatch(), used: false }; return gate; },
    counts(nodeOnly = true) { return records.filter(value => !nodeOnly || value.node).reduce((all, value) => { all[value.kind] = (all[value.kind] ?? 0) + 1; return all; }, {} as Partial<{ [K in RequestKind]: number }>); },
    installAuthorizationTransport() { const original = globalThis.fetch;
      const bridge: typeof fetch = (input, init) => { const url = new URL(input instanceof Request ? input.url : String(input));
        return ["api.amazon.com", "api.etsy.com"].includes(url.hostname) ? request(input, init) : original(input, init); };
      globalThis.fetch = bridge; return () => { if (globalThis.fetch === bridge) globalThis.fetch = original; }; },
    async close() { gate?.release.release(); for (const socket of sockets) socket.destroy(); await new Promise<void>((done, fail) => server.close(error => error ? fail(error) : done())); },
    async assertEncryptedFiles(paths: readonly string[]) { for (const path of paths) { const bytes = await readFile(path); if ([...needles].some(secret => bytes.includes(Buffer.from(secret)))) throw new Error("store_node_secret_in_owned_file"); } },
  };
}
