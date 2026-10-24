import { createHash, randomBytes } from "node:crypto";
import { createServer, request as httpsRequest } from "node:https";
import { readFile, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import type { Duplex } from "node:stream";
import type { StoreNodeExecutionRequestClass } from "@yummyai/contracts/marketplace/store-node-execution";
import { publicationPreviewPayloadText } from "@yummyai/contracts/marketplace/publication-preview";

export function executionLatch() { let release!: () => void; const promise = new Promise<void>(done => { release = done; }); return { promise, release }; }
export async function executionBounded<T>(promise: Promise<T>, code: string, ms = 30_000): Promise<T> {
  let timer: NodeJS.Timeout | undefined;
  try { return await Promise.race([promise, new Promise<never>((_, fail) => { timer = setTimeout(() => fail(new Error(code)), ms); })]); }
  finally { if (timer) clearTimeout(timer); }
}
type RequestKind = StoreNodeExecutionRequestClass | "etsy_oauth" | "amazon_oauth";
type Fault = "none" | "lose" | "unauthorized" | "rate_limited" | "upstream" | "timeout" | "redirect" | "secret" | "oversized";
type ProviderRecord = { ordinal: number; kind: RequestKind; method: string; status: number | null; node: boolean; credentialAccepted: boolean; responseFinished: boolean;
  originalPreviewTarget?: boolean; originalPreviewBody?: boolean; originalSubmissionTarget?: boolean; originalSubmissionBody?: boolean;
  originalStatusTarget?: boolean; targetSha256?: string; application?: "central" | "node" | "private" };
/** Only an external HTTPS boundary. All facts are still parsed by the original HTTP capability gateway. */
export async function startPublicationNodePreviewProvider(files: { key: Buffer; cert: string; ca: string }, directory: string,
  options: { amazonPublic?: boolean; publicationSubmit?: boolean } = {}) {
  const suffix = randomBytes(18).toString("hex");
  const secrets = { centralApp: "SYNTHETIC-CENTRAL-" + suffix, nodeApp: "SYNTHETIC-NODE-" + suffix,
    privateClient: "SYNTHETIC-PRIVATE-" + suffix, privateRefresh: "SYNTHETIC-PRIVATE-REFRESH-" + suffix,
    privateSecret: "SYNTHETIC-PRIVATE-SECRET-" + suffix, error: "SYNTHETIC-PROVIDER-ERROR-" + suffix };
  const clientId = "synthetic-execution-client-" + suffix, sellerId = "SYNTHETIC-SELLER-" + suffix;
  const codes = new Map<string, { verifier: string; redirect: string; client: string; user: number }>();
  const amazonCodes = new Map<string, { client: string; redirect: string; seller: string }>(), amazonRefreshes = new Map<string, string>();
  const amazonApplicationId = "synthetic-public-application-" + suffix, amazonRedirectUri = "https://synthetic-erp.invalid/stores/oauth/callback";
  const refreshes = new Map<string, number>(), access = new Map<string, number>();
  const needles = new Set<string>(Object.values(secrets));
  const records: ProviderRecord[] = [], sockets = new Set<Duplex>();
  const previews = new Map<string, { marketplaceId: string; locale: string; productType: string; attributes: Record<string, unknown> }>();
  const submissions = new Map<string, { marketplaceId: string; locale: string; productType: string; attributes: Record<string, unknown>; submissionId: string }>();
  const received = new Set<string>();
  let user = 20_000_000 + randomBytes(3).readUIntBE(0, 3), gate: { kind: RequestKind; entered: ReturnType<typeof executionLatch>; release: ReturnType<typeof executionLatch>; used: boolean } | undefined;
  const controls = { fault: "none" as Fault, faultKind: null as RequestKind | null, schemaOutsideDefinition: false, validationStatus: "ACCEPTED" as "ACCEPTED" | "INVALID",
    submissionStatus: "ACCEPTED" as "ACCEPTED" | "INVALID", listingStatus: "BUYABLE" as "BUYABLE" | "PROCESSING" | "DELETED" | "BLOCKED" };
  const schema = { $schema: "https://json-schema.org/draft/2020-12/schema", type: "object", properties: { item_name: { type: "string", minLength: 1 },
    fixture_unit_amount_minor: { const: 12345 }, fixture_currency: { const: "USD" } }, required: ["item_name"], additionalProperties: false };
  const metaSchema = { $schema: "https://json-schema.org/draft/2020-12/schema", title: "Synthetic original Amazon meta schema", type: "object" };
  const sha = (value: unknown) => createHash("sha256").update(JSON.stringify(value)).digest("hex");
  const kindFor = (path: string, method: string, body: URLSearchParams, query: URLSearchParams): RequestKind | undefined => {
    if (method === "POST" && path === "/auth/o2/token") return body.get("grant_type") === "authorization_code" ? "amazon_oauth" : "amazon_lwa";
    if (method === "POST" && path === "/v3/public/oauth/token") return body.get("grant_type") === "authorization_code" ? "etsy_oauth" : "etsy_refresh";
    if (method === "PUT" && /^\/listings\/2021-08-01\/items\/[^/]+\/[^/]+$/.test(path))
      return query.has("mode") ? "amazon_listing_validation_preview" : options.publicationSubmit ? "amazon_listing_submit" : undefined;
    if (method !== "GET") return undefined;
    if (options.publicationSubmit && /^\/listings\/2021-08-01\/items\/[^/]+\/[^/]+$/.test(path)) return "amazon_listing_status";
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
      const bytes = Buffer.concat(chunks), body = new URLSearchParams(bytes.toString("utf8")), kind = kindFor(url.pathname, request.method ?? "", body, url.searchParams);
      if (!kind) { response.writeHead(404); response.end(); return; }
      const node = request.headers["x-synthetic-node-transport"] === "1";
      record = { ordinal: records.length + 1, kind, method: request.method!, status: null, node, credentialAccepted: false, responseFinished: false }; records.push(record);
      response.once("finish", () => { record!.responseFinished = true; });
      if (kind === "amazon_listing_validation_preview") {
        const selected = previews.get(url.pathname), keys = [...url.searchParams.keys()];
        record.originalPreviewTarget = Boolean(selected && keys.length === 3 && new Set(keys).size === 3 &&
          url.searchParams.get("marketplaceIds") === selected.marketplaceId && url.searchParams.get("issueLocale") === selected.locale.replace("-", "_") && url.searchParams.get("mode") === "VALIDATION_PREVIEW");
        try { const parsed = JSON.parse(bytes.toString("utf8")) as Record<string, unknown>;
          record.originalPreviewBody = Boolean(selected && Object.keys(parsed).sort().join(",") === "attributes,productType,requirements" &&
            parsed.productType === selected.productType && parsed.requirements === "LISTING" &&
            publicationPreviewPayloadText(parsed) === publicationPreviewPayloadText({ productType: selected.productType, requirements: "LISTING", attributes: selected.attributes }));
        } catch { record.originalPreviewBody = false; }
        record.credentialAccepted = access.has(String(request.headers["x-amz-access-token"] ?? ""));
        if (!record.originalPreviewTarget || !record.originalPreviewBody || !record.credentialAccepted) {
          record.status = 400; response.writeHead(400, { "content-type": "application/json" }); response.end('{"code":"synthetic_original_preview_mismatch"}'); return;
        }
        received.add(url.pathname);
      }
      if (kind === "amazon_listing_submit" || kind === "amazon_listing_status") {
        const selected = submissions.get(url.pathname), keys = [...url.searchParams.keys()];
        record.targetSha256 = createHash("sha256").update(url.pathname).digest("hex");
        const target = Boolean(selected && keys.length === (kind === "amazon_listing_submit" ? 2 : 3) && new Set(keys).size === keys.length &&
          url.searchParams.get("marketplaceIds") === selected.marketplaceId && url.searchParams.get("issueLocale") === selected.locale.replace("-", "_") &&
          !url.searchParams.has("mode") && (kind === "amazon_listing_submit" ? keys.every(key => ["marketplaceIds", "issueLocale"].includes(key))
            : url.searchParams.get("includedData") === "summaries,issues"));
        if (kind === "amazon_listing_submit") {
          record.originalSubmissionTarget = target;
          try { const parsed = JSON.parse(bytes.toString("utf8")) as Record<string, unknown>;
            record.originalSubmissionBody = Boolean(selected && Object.keys(parsed).sort().join(",") === "attributes,productType,requirements" &&
              parsed.productType === selected.productType && parsed.requirements === "LISTING" && publicationPreviewPayloadText(parsed) ===
              publicationPreviewPayloadText({ productType: selected.productType, requirements: "LISTING", attributes: selected.attributes }));
          } catch { record.originalSubmissionBody = false; }
        } else record.originalStatusTarget = target && bytes.length === 0;
        record.credentialAccepted = access.has(String(request.headers["x-amz-access-token"] ?? ""));
        if (!node || !target || !record.credentialAccepted || (kind === "amazon_listing_submit" ? !record.originalSubmissionBody : !record.originalStatusTarget)) {
          record.status = 400; response.writeHead(400, { "content-type": "application/json" }); response.end('{"code":"synthetic_original_submission_mismatch"}'); return;
        }
      }
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
      if (kind === "amazon_oauth") {
        const code = body.get("code") ?? "", selected = amazonCodes.get(code);
        if (!options.amazonPublic || node || !selected || body.get("client_id") !== selected.client || body.get("client_secret") !== secrets.centralApp ||
          body.get("redirect_uri") !== selected.redirect || [...body.keys()].sort().join(",") !== "client_id,client_secret,code,grant_type,redirect_uri") { send(401, {}); return; }
        amazonCodes.delete(code); record.credentialAccepted = true; record.application = "central";
        const refresh = "SYNTHETIC-PUBLIC-REFRESH-" + randomBytes(24).toString("hex"), token = "SYNTHETIC-PUBLIC-ACCESS-" + randomBytes(24).toString("hex");
        amazonRefreshes.set(refresh, selected.seller); access.set(token, 1); needles.add(refresh); needles.add(token);
        send(200, { access_token: token, refresh_token: refresh, token_type: "Bearer", expires_in: 3600 }); return;
      }
      if (kind === "amazon_lwa") {
        const publicRefresh = amazonRefreshes.has(body.get("refresh_token") ?? "");
        if (publicRefresh) {
          if (!options.amazonPublic || !node || body.get("client_id") !== clientId || body.get("client_secret") !== secrets.nodeApp ||
            body.get("grant_type") !== "refresh_token" || [...body.keys()].sort().join(",") !== "client_id,client_secret,grant_type,refresh_token") { send(401, {}); return; }
          record.application = "node";
        } else {
          if (body.get("client_id") !== secrets.privateClient || body.get("client_secret") !== secrets.privateSecret || body.get("refresh_token") !== secrets.privateRefresh) { send(401, {}); return; }
          record.application = "private";
        }
        record.credentialAccepted = true; const token = "SYNTHETIC-AMAZON-ACCESS-" + randomBytes(16).toString("hex"); access.set(token, 1); needles.add(token);
        send(200, { access_token: token, token_type: "Bearer", expires_in: 3600 }); return;
      }
      if (kind === "amazon_listing_validation_preview") {
        response.setHeader("x-amzn-RateLimit-Limit", "5.5");
        send(200, { sku: decodeURIComponent(url.pathname.split("/").at(-1)!), status: controls.validationStatus,
          submissionId: "SYNTHETIC-VALIDATION-ONLY", issues: controls.validationStatus === "INVALID"
            ? [{ code: "SYNTHETIC_REQUIRED", message: "Original synthetic provider reports missing attribute", severity: "ERROR", attributeNames: ["item_name"] }] : [] }); return;
      }
      if (kind === "amazon_listing_submit") {
        response.setHeader("x-amzn-RateLimit-Limit", "5.5");
        send(200, { sku: decodeURIComponent(url.pathname.split("/").at(-1)!), status: controls.submissionStatus,
          submissionId: submissions.get(url.pathname)!.submissionId, issues: controls.submissionStatus === "INVALID"
            ? [{ code: "SYNTHETIC_SUBMIT_REJECTED", message: "Synthetic provider rejected the original submission", severity: "ERROR", attributeNames: ["item_name"] }] : [] }); return;
      }
      if (kind === "amazon_listing_status") {
        response.setHeader("x-amzn-RateLimit-Limit", "3.25");
        send(200, { sku: decodeURIComponent(url.pathname.split("/").at(-1)!), summaries: [{ marketplaceId: submissions.get(url.pathname)!.marketplaceId,
          status: [controls.listingStatus === "BLOCKED" ? "PROCESSING" : controls.listingStatus] }], issues: controls.listingStatus === "BLOCKED"
            ? [{ code: "SYNTHETIC_STATUS_BLOCKED", message: "Synthetic provider reports an original Listing issue", severity: "ERROR", attributeNames: ["item_name"] }] : [] }); return;
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
  const environment: Record<string, string> = { ETSY_APP_KEYSTRING: clientId, ETSY_APP_SHARED_SECRET: secrets.centralApp, ETSY_OAUTH_REDIRECT_URI: "https://synthetic-erp.invalid/callback" },
    nodeEnvironment: Record<string, string> = { STORE_NODE_ETSY_APP_KEYSTRING: clientId, STORE_NODE_ETSY_APP_SHARED_SECRET: secrets.nodeApp };
  if (options.amazonPublic) {
    Object.assign(environment, { AMAZON_SPAPI_APPLICATION_ID: amazonApplicationId, AMAZON_SPAPI_LWA_CLIENT_ID: clientId, AMAZON_SPAPI_LWA_CLIENT_SECRET: secrets.centralApp,
      AMAZON_SPAPI_OAUTH_REDIRECT_URI: amazonRedirectUri, AMAZON_SPAPI_AUTH_BASE_URL_NA: "https://sellercentral.amazon.com" });
    Object.assign(nodeEnvironment, { STORE_NODE_AMAZON_APP_CLIENT_ID: clientId, STORE_NODE_AMAZON_APP_CLIENT_SECRET: secrets.nodeApp });
  }
  return { origin, caPath, clientId, sellerId, controls, secrets, records, schema, metaSchema,
    expectPreview(value: { sellerId: string; sku: string; marketplaceId: string; locale: string; productType: string; attributes: Record<string, unknown> }) {
      const path = `/listings/2021-08-01/items/${encodeURIComponent(value.sellerId)}/${encodeURIComponent(value.sku)}`;
      if (previews.has(path)) throw new Error("publication_preview_provider_target_already_registered");
      previews.set(path, { marketplaceId: value.marketplaceId, locale: value.locale, productType: value.productType, attributes: value.attributes });
      return { get physicallyReceived() { return received.has(path); } };
    },
    expectSubmission(value: { sellerId: string; sku: string; marketplaceId: string; locale: string; productType: string; attributes: Record<string, unknown> }) {
      if (!options.publicationSubmit) throw new Error("publication_submit_provider_requires_its_owned_family");
      const path = `/listings/2021-08-01/items/${encodeURIComponent(value.sellerId)}/${encodeURIComponent(value.sku)}`;
      if (submissions.has(path)) throw new Error("publication_submit_provider_target_already_registered");
      const submissionId = "SYNTHETIC-SUBMISSION-" + randomBytes(16).toString("hex");
      submissions.set(path, { marketplaceId: value.marketplaceId, locale: value.locale, productType: value.productType, attributes: value.attributes, submissionId });
      const targetSha256 = createHash("sha256").update(path).digest("hex");
      return { submissionId, targetSha256,
        get physicalSubmitCount() { return records.filter(row => row.kind === "amazon_listing_submit" && row.targetSha256 === targetSha256).length; },
        get physicalStatusCount() { return records.filter(row => row.kind === "amazon_listing_status" && row.targetSha256 === targetSha256).length; } };
    },
    get secretValues() { return [...needles]; },
    privateInput: { clientId: secrets.privateClient, clientSecret: secrets.privateSecret, refreshToken: secrets.privateRefresh, sellingPartnerId: sellerId },
    environment, nodeEnvironment, request,
    amazonCode(raw: string, sellingPartnerId: string) {
      const url = new URL(raw), keys = [...url.searchParams.keys()];
      if (!options.amazonPublic || url.origin !== "https://sellercentral.amazon.com" || url.pathname !== "/apps/authorize/consent" || url.hash || url.username || url.password ||
        keys.some(key => !["application_id", "state", "version"].includes(key) || url.searchParams.getAll(key).length !== 1) ||
        url.searchParams.get("application_id") !== amazonApplicationId || !/^[A-Za-z0-9_-]{43}$/.test(url.searchParams.get("state") ?? "") ||
        url.searchParams.has("version") && url.searchParams.get("version") !== "beta" || !/^SYNTHETIC-[A-Za-z0-9-]{1,150}$/.test(sellingPartnerId))
        throw new Error("store_node_provider_expected_original_amazon_authorization");
      const code = "SYNTHETIC-AMAZON-CODE-" + randomBytes(24).toString("hex"); needles.add(code);
      amazonCodes.set(code, { client: clientId, redirect: amazonRedirectUri, seller: sellingPartnerId });
      return { state: url.searchParams.get("state")!, code, sellingPartnerId };
    },
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
