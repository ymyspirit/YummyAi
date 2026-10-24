import { createHash } from "node:crypto";
import { readFile, realpath, writeFile } from "node:fs/promises";
import { isAbsolute, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { expect, test, type Page, type Request, type Locator, type TestInfo } from "@playwright/test";
import { z } from "zod";
import { ErpSessionViewSchema, erpSessionAuthority } from "@yummyai/contracts/auth/session";
import { MarketplaceAuthorityWorkspaceSchema } from "@yummyai/contracts/marketplace/authority";
import { CreatePublicationPreviewInputSchema, PublicationPreviewRequestViewSchema, PublicationPreviewReceiptSchema, PublicationPreviewWorkspaceInputSchema,
  PublicationPreviewReadCheckInputSchema, PublicationPreviewLookupSchema } from "@yummyai/contracts/marketplace/publication-preview";
import { StoreNodeExecutionViewSchema } from "@yummyai/contracts/marketplace/store-node-execution";
import { requireAmazonPublicNodeEnvironment } from "../../../tools/testing/amazon-public-node-environment.mjs";
import { MarketplaceOAuthBindingSchema, marketplaceOAuthCookieName, marketplaceOAuthStateDigest, marketplaceOAuthPendingStateDigest } from "../src/features/marketplaces/marketplace-oauth";
import { loginErp } from "./erp-identity-fixture";

const isolated = requireAmazonPublicNodeEnvironment(process.env, true), root = fileURLToPath(new URL("../../../", import.meta.url)),
  Id = z.uuidv7(), Digest = z.string().regex(/^[a-f0-9]{64}$/), sha = (value: string) => createHash("sha256").update(value).digest("hex");
const Source = z.object({ listingId: Id, versionId: Id, accountId: Id, variantSkuId: Id, title: z.string(), sku: z.string() }).passthrough();
const Seed = z.object({ groupId: Id, scenario: z.enum(["public_ui", "preview_recovery"]), actorId: Id, tenantId: Id, accountId: Id.nullable(), nodeId: Id.nullable(),
  source: Source.nullable(), displayName: z.string(), initial: z.unknown() }).strict();
const Snapshot = z.object({ business: z.object({ paid: z.literal(0), publications: z.literal(0), listingSyncs: z.literal(0) }).strict(), counts: z.record(z.string(), z.int()),
  codeExchanges: z.int(), centralRefreshes: z.int(), nodeApplicationRefreshes: z.int(),
  account: z.object({ id: Id, authorizationMode: z.literal("amazon_public"), status: z.string(), credentialStatus: z.string(), authorizationGeneration: z.uuid() }).nullable(),
  snapshots: z.array(z.object({ id: Id, version: z.int(), sourceChecksum: z.string() })), requests: z.array(z.object({ id: Id, listingVersionId: Id, action: z.string(), payloadChecksum: Digest })),
  intents: z.array(z.object({ requestId: Id, requestKey: Id.nullable(), requestChecksum: Digest.nullable(), nodeExecutionId: Id.nullable() })),
  originalRequestRowsSha256: Digest }).passthrough();
const lifecycle = (page: Page) => page.getByRole("region", { name: "店铺授权状态", exact: true });
const capability = (page: Page) => page.getByRole("region", { name: "绑定节点能力同步", exact: true });
const preview = (page: Page) => page.getByRole("region", { name: "Amazon 节点校验预览", exact: true });
const detail = (page: Page) => page.getByRole("region", { name: "原发布预览详情", exact: true });
async function config() {
  const value = z.object({ nonce: z.literal(isolated.nonce), pid: z.int().positive(), origin: z.url(), key: z.string().regex(/^[A-Za-z0-9_-]{43}$/) }).strict()
    .parse(JSON.parse(await readFile(resolve(isolated.lane, "browser-control-" + isolated.nonce + ".json"), "utf8")));
  const url = new URL(value.origin); if (url.protocol !== "http:" || url.hostname !== "127.0.0.1" || !url.port || url.pathname !== "/" || url.search || url.hash || url.username || url.password)
    throw new Error("amazon_public_control_origin_invalid"); return value;
}
async function control(input: unknown, status = 200) {
  const value = await config(), response = await fetch(value.origin, { method: "POST", headers: { "content-type": "application/json", "x-fixture-control": value.key },
    body: JSON.stringify(input), redirect: "error", signal: AbortSignal.timeout(90_000) });
  expect(response.status, "Actual owned original owner or CLI control").toBe(status); return await response.json() as unknown;
}
async function fixture(scenario: "public_ui" | "preview_recovery") {
  const seed = Seed.parse(await control({ operation: "seed", scenario })); let closed = false;
  return { seed, call: (operation: string, fields: object = {}) => control({ operation, groupId: seed.groupId, ...fields }),
    async close() { if (closed) return; closed = true;
      expect(await control({ operation: "close", groupId: seed.groupId })).toEqual({ closed: true, originalAuthorizationRevoked: true, childrenExited: true }); } };
}
type Fixture = Awaited<ReturnType<typeof fixture>>;
async function oauthAction() {
  const cwd = process.env.KNOWLEDGE_BROWSER_CWD;
  if (!cwd || !isAbsolute(cwd)) throw new Error("amazon_public_browser_candidate_missing");
  const directory = resolve(cwd), match = /^\.artifacts\/local-web-releases\/([a-f0-9]{32})\/apps\/web$/.exec(relative(root, directory).replaceAll("\\", "/"));
  if (!match || (await realpath(directory)).toLowerCase() !== directory.toLowerCase()) throw new Error("amazon_public_browser_candidate_invalid");
  const metadata = z.object({ id: z.literal(match[1]!), status: z.literal("built"), scope: z.literal("local-web-runtime"), buildId: z.string(),
    artifacts: z.array(z.object({ path: z.string(), sha256: Digest, bytes: z.int() }).passthrough()) }).passthrough()
    .parse(JSON.parse(await readFile(resolve(directory, "../../manifest.json"), "utf8")));
  expect((await readFile(resolve(directory, ".next/BUILD_ID"), "utf8")).trim()).toBe(metadata.buildId);
  const bytes = await readFile(resolve(directory, ".next/server/server-reference-manifest.json")), pinned = metadata.artifacts.filter(row => row.path === ".next/server/server-reference-manifest.json");
  expect(pinned).toHaveLength(1); expect(pinned[0]!.bytes).toBe(bytes.length); expect(pinned[0]!.sha256).toBe(createHash("sha256").update(bytes).digest("hex"));
  const manifest = JSON.parse(bytes.toString("utf8")) as Record<string, unknown>, ids: string[] = [];
  for (const runtime of ["node", "edge"]) {
    const entries = manifest[runtime]; if (!entries || typeof entries !== "object") continue;
    for (const [id, raw] of Object.entries(entries)) {
      const result = z.object({ exportedName: z.literal("startMarketplaceOAuth"), filename: z.string(), workers: z.record(z.string(), z.unknown()) }).passthrough().safeParse(raw);
      if (result.success && Object.hasOwn(result.data.workers, "app/(erp)/stores/[accountId]/page") &&
        /(?:^|\/)src\/features\/marketplaces\/marketplace-actions\.ts$/.test(result.data.filename.replaceAll("\\", "/"))) ids.push(id);
    }
  }
  expect(ids).toHaveLength(1); expect(ids[0]).toMatch(/^[a-f0-9]{40,64}$/); return ids[0]!;
}

const Audit = z.object({ doc: z.uuid(), seq: z.int().positive(), urlSha: Digest, path: z.string().max(180), method: z.enum(["GET", "HEAD"]), start: z.number(),
  readKind: z.enum(["api_read", "created_store_rsc"]),
  authority: Digest.nullable(), echo: Digest.nullable(), status: z.int().optional(), resolvedAt: z.number().optional(), bodyIsNull: z.boolean().optional(),
  abortAtResolve: z.boolean().optional(), abort: z.boolean(), abortAtEof: z.boolean().nullable(), eof: z.boolean(), json: z.boolean(), bytes: z.int(), reads: z.int(),
  cancelled: z.boolean(), error: z.boolean(), fetchError: z.enum(["AbortError", "Other"]).nullable() }).strict();
type ReadAudit = z.infer<typeof Audit>;
/** New-family passive evidence only. The application retains its original Promise, Response, reader and signal. */
async function observe(page: Page) {
  const accountIds = new Set<string>(), listingIds = new Set<string>(), previewIds = new Set<string>(), audits = new Map<string, ReadAudit>();
  const sources = new Map<string, z.infer<typeof Source>>(), lookups = new Set<string>();
  const metadata = new Set(["/api/erp-auth/session", "/api/agent-native-v3/workspace", "/api/agent-native-v2/workspace", "/api/agent-native/workspace", "/api/agent-tools/workspace",
    "/api/agent-loops/workspace", "/api/agent-plans/workspace", "/api/agent-commands/workspace", "/api/agent-read/workspace", "/api/ai-assists/task-workspace", "/api/ai-assists/models", "/api/ai-assists/runs",
    "/api/agent-resources/workspace", "/api/agent-fulfillment/workspace"]);
  const safePath = (path: string) => metadata.has(path) ||
    [...accountIds].some(id => path === `/api/marketplace-accounts/${id}/authority` || path === `/api/marketplace-accounts/${id}/nodes` ||
      new RegExp(`^/api/marketplace-accounts/${id}/node-executions(?:/[a-f0-9-]{36})?$`).test(path)) ||
    [...listingIds].some(id => path === `/api/listings/${id}`) || path === "/api/erp-publication-preview/workspace" || path === "/api/erp-publication-preview/receipt" ||
    [...previewIds].some(id => path === `/api/erp-publication-preview/requests/${id}` || path === `/api/erp-publication-preview/requests/${id}/events`);
  const safeQuery = (request: Request) => {
    const url = new URL(request.url()), keys = [...url.searchParams.keys()]; if (keys.length !== new Set(keys).size) return false;
    if (url.pathname === "/api/erp-publication-preview/workspace") {
      if (request.method() === "HEAD") {
        if (!keys.every(key => ["listingId", "listingVersionId", "accountIds"].includes(key))) return false;
        const parsed = PublicationPreviewReadCheckInputSchema.safeParse({ listingId: url.searchParams.get("listingId"), listingVersionId: url.searchParams.get("listingVersionId"),
          accountIds: url.searchParams.get("accountIds") ?? "" });
        if (!parsed.success) return false; const source = sources.get(parsed.data.listingId);
        return Boolean(source && parsed.data.listingVersionId === source.versionId && (parsed.data.accountIds === "" || parsed.data.accountIds === source.accountId));
      }
      const parsed = PublicationPreviewWorkspaceInputSchema.safeParse(Object.fromEntries(url.searchParams)); if (!parsed.success) return false;
      const source = sources.get(parsed.data.listingId); return Boolean(source && source.versionId === parsed.data.listingVersionId &&
        (parsed.data.variantSkuId === undefined || parsed.data.variantSkuId === source.variantSkuId));
    }
    if (url.pathname === "/api/erp-publication-preview/receipt") { const parsed = PublicationPreviewLookupSchema.safeParse(Object.fromEntries(url.searchParams));
      return parsed.success && lookups.has(parsed.data.requestKey + ":" + parsed.data.requestChecksum); }
    return !url.search || url.pathname === "/api/ai-assists/task-workspace" && url.search === "?page=1";
  };
  await page.exposeBinding("__amazonPublicReadAudit", ({ frame }, raw: unknown) => { if (frame !== page.mainFrame()) return; const parsed = Audit.safeParse(raw);
    if (!parsed.success || audits.size >= 250 && !audits.has(parsed.data.doc + ":" + parsed.data.seq)) return; audits.set(parsed.data.doc + ":" + parsed.data.seq, parsed.data); });
  await page.addInitScript(() => {
    const original = window.fetch, doc = crypto.randomUUID(); let seq = 0;
    const hash = async (value: string) => [...new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(value)))].map(value => value.toString(16).padStart(2, "0")).join("");
    const emit = (row: object) => { try { void (window as unknown as { __amazonPublicReadAudit?: (value: object) => Promise<void> }).__amazonPublicReadAudit?.(row).catch(() => {}); } catch { /* Telemetry has no application effect. */ } };
    window.fetch = function (...args) {
      const raw = args[0], init = args[1]; let url: URL; try { url = new URL(raw instanceof Request ? raw.url : String(raw), location.href); } catch { return Reflect.apply(original, this, args); }
      const method = (init?.method ?? (raw instanceof Request ? raw.method : "GET")).toUpperCase(), headers = new Headers(init?.headers ?? (raw instanceof Request ? raw.headers : undefined)),
        queryKeys = [...url.searchParams.keys()], createdStoreRsc = method === "GET" && headers.get("rsc") === "1" && (url.pathname === "/stores" || /^\/stores\/[a-f0-9-]{36}$/.test(url.pathname)) &&
          (queryKeys.length === 0 || queryKeys.length === 1 && queryKeys[0] === "_rsc"),
        apiRead = /^\/api\/(?:erp-auth\/session|marketplace-accounts\/|erp-publication-preview\/|listings\/|agent-|ai-assists\/)/.test(url.pathname);
      if (url.origin !== location.origin || !["GET", "HEAD"].includes(method) || !createdStoreRsc && !apiRead) return Reflect.apply(original, this, args);
      const signal = init?.signal ?? (raw instanceof Request ? raw.signal : undefined),
        row: { doc: string; seq: number; urlSha: string; path: string; method: string; start: number; authority: string | null; echo: string | null; status?: number;
          resolvedAt?: number; bodyIsNull?: boolean; abortAtResolve?: boolean; abort: boolean; abortAtEof: boolean | null; eof: boolean; json: boolean; bytes: number;
          readKind: "api_read" | "created_store_rsc"; reads: number; cancelled: boolean; error: boolean; fetchError: string | null } = { doc, seq: ++seq, urlSha: "", path: url.pathname, method, start: Date.now(),
          readKind: createdStoreRsc ? "created_store_rsc" : "api_read",
          authority: null, echo: null, abort: signal?.aborted ?? false, abortAtEof: null, eof: false, json: false, bytes: 0, reads: 0, cancelled: false, error: false, fetchError: null };
      const stamp = headers.get("x-yummyai-context-authority");
      const setup = Promise.all([hash(url.href).then(value => { row.urlSha = value; }), stamp ? (/^[a-f0-9]{64}$/.test(stamp) ? Promise.resolve().then(() => { row.authority = stamp; }) : hash(stamp).then(value => { row.authority = value; })) : Promise.resolve()]);
      const record = () => { void setup.then(() => emit({ ...row })); }, eof = () => { if (!row.eof) { row.eof = true; row.abortAtEof = row.abort; } record(); };
      signal?.addEventListener("abort", () => { row.abort = true; record(); }, { once: true }); record();
      const promise = Reflect.apply(original, this, args) as Promise<Response>;
      void promise.then(response => {
        row.status = response.status; row.resolvedAt = Date.now(); row.bodyIsNull = response.body === null; row.abortAtResolve = row.abort;
        const echo = response.headers.get("x-yummyai-context-authority"); if (echo) { if (/^[a-f0-9]{64}$/.test(echo)) row.echo = echo; else void hash(echo).then(value => { row.echo = value; record(); }); } record();
        if (method === "HEAD") return;
        if (response.body) {
          const body = response.body, getReader = body.getReader;
          body.getReader = function (this: ReadableStream<Uint8Array>, ...readerArgs: Parameters<typeof getReader>) {
            const reader = Reflect.apply(getReader, this, readerArgs) as ReadableStreamDefaultReader<Uint8Array>, read = reader.read, cancel = reader.cancel;
            reader.read = function (...readArgs) { const result = Reflect.apply(read, this, readArgs) as ReturnType<typeof read>;
              void result.then(value => { row.reads++; if (value.done) eof(); else { row.bytes += value.value.byteLength; record(); } }, () => { row.error = true; record(); }); return result; };
            reader.cancel = function (...cancelArgs) { row.cancelled = true; record(); return Reflect.apply(cancel, this, cancelArgs); }; return reader;
          } as typeof body.getReader;
        }
        const json = response.json; response.json = function (...jsonArgs) { const result = Reflect.apply(json, this, jsonArgs) as ReturnType<typeof json>;
          void result.then(() => { row.json = true; eof(); }, () => { row.error = true; record(); }); return result; };
      }, error => { row.fetchError = error instanceof Error && error.name === "AbortError" ? "AbortError" : "Other"; record(); }).catch(() => {});
      return promise;
    };
  });
  type Row = { request: Request; ordinal: number; path: string; urlSha: string; method: string; generation: number; at: number; terminalAt: number | null;
    status: number | null; failed: boolean; aborted: boolean; finished: boolean; authority: string | null; echo: string | null; prefetch: boolean; resource: string; navigation: boolean;
    rsc: boolean; responseRsc: boolean; personal: string | null; timing: ReturnType<Request["timing"]> };
  const rows: Row[] = [], sessions: Array<{ generation: number; at: number; authority: string }> = [], links: Array<{ generation: number; hash: string; at: number }> = [],
    windows: Array<{ kind: string; start: number; end: number; generation: number }> = [], consoleErrors: Array<{ at: number; path: string; loss: boolean; consumed: boolean }> = [], pageErrors: string[] = [], losses = new Map<Request, { consumed: boolean; console: boolean }>();
  const createdStores: Array<{ accountId: string; authority: string; generation: number; acceptedAt: number; acceptedPageSha256: string; queryHash: string }> = [];
  let generation = 0, personal: string | null = null;
  const authHash = (raw: string | undefined) => raw ? /^[a-f0-9]{64}$/.test(raw) ? raw : sha(raw) : null;
  const canonical = (raw: string) => { const url = new URL(raw, "http://localhost:3130"); if (url.origin !== "http://localhost:3130" || url.hash || url.username || url.password) return null;
    const entries = [...url.searchParams.entries()]; if (new Set(entries.map(([key]) => key)).size !== entries.length) return null;
    return sha(JSON.stringify([url.pathname, entries.filter(([key]) => key !== "_rsc").sort(([a], [b]) => a.localeCompare(b))])); };
  page.on("request", request => { const url = new URL(request.url()); if (url.origin !== "http://localhost:3130") return;
    if (request.isNavigationRequest() && request.resourceType() === "document" && request.frame() === page.mainFrame()) generation++;
    const headers = request.headers(); rows.push({ request, ordinal: rows.length + 1, path: url.pathname, urlSha: sha(url.href), method: request.method(), generation, at: Date.now(),
      terminalAt: null, status: null, failed: false, aborted: false, finished: false, authority: authHash(headers["x-yummyai-context-authority"]), echo: null,
      prefetch: headers["next-router-prefetch"] === "1", rsc: headers.rsc === "1", responseRsc: false, resource: request.resourceType(), navigation: request.isNavigationRequest(), personal, timing: request.timing() }); });
  page.on("requestfinished", request => { const row = rows.find(value => value.request === request); if (row) { row.finished = true; row.terminalAt = Date.now(); row.timing = request.timing(); } });
  page.on("requestfailed", request => { const row = rows.find(value => value.request === request); if (row) { row.failed = true; row.aborted = request.failure()?.errorText === "net::ERR_ABORTED";
    row.terminalAt = Date.now(); row.timing = request.timing(); } });
  page.on("response", response => { const row = rows.find(value => value.request === response.request()); if (row) { row.status = response.status(); row.echo = authHash(response.headers()["x-yummyai-context-authority"]);
    row.responseRsc = /^text\/x-component(?:\s*;|$)/i.test(response.headers()["content-type"] ?? ""); } });
  page.on("console", message => { if (message.type() !== "error") return; let path = ""; try { path = new URL(message.location().url).pathname; } catch { /* No secret-bearing console text is kept. */ }
    consoleErrors.push({ at: Date.now(), path, loss: /^Failed to load resource: net::ERR_FAILED$/.test(message.text()), consumed: false }); });
  page.on("pageerror", error => pageErrors.push(sha(error.message)));
  let oauth: { request?: Request; accountId: string; actionId: string; authority: string; previousGeneration: string; matched: boolean; approved: boolean; attempts: number } | null = null;
  const validations: Promise<void>[] = [];
  page.on("request", request => {
    if (!oauth || request.method() !== "POST" || new URL(request.url()).pathname !== "/stores/" + oauth.accountId || new URL(request.url()).search || request.headers()["next-action"] !== oauth.actionId) return;
    const selected = oauth; selected.attempts++; if (selected.attempts !== 1) return; selected.request = request;
    const validate = async () => {
      try {
        const bytes = request.postDataBuffer(), type = request.headers()["content-type"] ?? ""; if (!bytes || bytes.length > 65536 || !/^multipart\/form-data;/.test(type)) return;
        const form = await new Response(new Uint8Array(bytes), { headers: { "content-type": type } }).formData(), args = form.get("0"); if (typeof args !== "string" || form.getAll("0").length !== 1) return;
        const parsed = z.tuple([Id, z.object({ message: z.literal(""), status: z.literal("idle") }).strict(), z.string().regex(/^\$K[1-9a-f][0-9a-f]*$/)]).safeParse(JSON.parse(args));
        if (!parsed.success || parsed.data[0] !== selected.accountId) return;
        const prefix = "_" + Number.parseInt(parsed.data[2].slice(2), 16) + "_", a = prefix + "__marketplaceAuthority", g = prefix + "__authorizationGeneration";
        selected.matched = [...form.entries()].length === 3 && [...form.keys()].every(key => ["0", a, g].includes(key)) && form.getAll(a).length === 1 && form.getAll(g).length === 1 &&
          form.get(a) === selected.authority && form.get(g) === selected.previousGeneration;
      } catch { /* Unknown server-action wire shape stays rejected. */ }
    }; validations.push(validate());
  });
  async function currentAuthority() {
    const response = await page.request.get("/api/erp-auth/session"); expect(response.status()).toBe(200); const value = ErpSessionViewSchema.parse(await response.json()), raw = erpSessionAuthority(value);
    personal = sha(raw); sessions.push({ generation, at: Date.now(), authority: personal });
    const observed = await page.locator("a[href]").evaluateAll(elements => elements.map(element => (element as HTMLAnchorElement).href));
    for (const raw of observed) { const hash = canonical(raw); if (hash) links.push({ generation, hash, at: Date.now() }); }
    return { session: value, raw, value: personal };
  }
  function paired(row: Row) {
    const candidates = [...audits.values()].filter(a => a.urlSha === row.urlSha && a.method === row.method && a.authority === row.authority &&
      (row.status === null ? a.status === undefined : a.status === row.status) && row.timing.startTime > 0 && Math.abs(row.timing.startTime - a.start) <= 25);
    if (candidates.length !== 1) return null; const audit = candidates[0]!;
    return rows.filter(other => other.urlSha === audit.urlSha && other.method === audit.method && other.authority === audit.authority &&
      (other.status === null ? audit.status === undefined : other.status === audit.status) && other.timing.startTime > 0 && Math.abs(other.timing.startTime - audit.start) <= 25).length === 1 ? audit : null;
  }
  function classify(row: Row) {
    if ((!row.failed && row.finished) || row.navigation && row.status !== null && [302, 303, 307, 308].includes(row.status)) return null;
    if (losses.has(row.request) && row.method === "POST" && row.path === "/api/erp-publication-preview/requests" && row.failed) return "injected_exact_original201_loss";
    if (oauth?.request === row.request && oauth.approved && oauth.matched && oauth.attempts === 1 && row.method === "POST" && row.status === 200 && (!row.failed || row.aborted)) return "controlled_exact_oauth_action_handoff_without_eof";
    if (!row.aborted || !["GET", "HEAD"].includes(row.method)) return null;
    const controlled = windows.some(window => row.at >= window.start && row.terminalAt !== null && row.terminalAt <= window.end),
      identities = [...new Set(sessions.filter(value => value.generation === row.generation).map(value => value.authority))], stamp = row.authority ?? row.personal ?? (identities.length === 1 ? identities[0]! : null),
      audit = paired(row), validAuthority = stamp !== null && identities.includes(stamp) && (row.echo === null || row.echo === stamp);
    const timing = row.timing.startTime > 0 && row.timing.responseStart >= 0 && row.timing.responseEnd >= row.timing.responseStart;
    if (controlled && row.method === "GET" && row.resource === "fetch" && !row.navigation && !row.prefetch && row.rsc && row.responseRsc && row.status === 200 &&
      row.authority === null && row.echo === null && validAuthority && timing && audit?.readKind === "created_store_rsc" && audit.eof && audit.abortAtEof === false &&
      audit.bytes > 0 && audit.reads > 0 && !audit.error && !audit.cancelled && audit.fetchError === null) {
      const url = new URL(row.request.url()), keys = [...url.searchParams.keys()], created = createdStores.filter(value => value.generation === row.generation &&
        value.authority === stamp && (row.path === "/stores/" + value.accountId && value.queryHash === canonical(url.href) ||
          row.path === "/stores" && canonical(url.href) === canonical("http://localhost:3130/stores")));
      const window = windows.filter(value => value.kind === "create_public" && row.at >= value.start && row.terminalAt !== null && row.terminalAt <= value.end &&
        created.length === 1 && created[0]!.acceptedAt >= value.start && created[0]!.acceptedAt <= value.end);
      const document = rows.filter(value => value.navigation && value.resource === "document" && value.method === "GET" && value.path === "/stores" &&
        value.generation === row.generation && value.status === 200 && value.finished && !value.failed && value.terminalAt !== null && value.terminalAt <= row.at);
      if ((keys.length === 0 || keys.length === 1 && keys[0] === "_rsc") && created.length === 1 && window.length === 1 && document.length === 1 && identities.length === 1)
        return row.path === "/stores" ? "completed_exact_original_store_index_refresh_with_terminal_abort" : "completed_exact_created_store_rsc_read_with_terminal_abort";
    }
    if (safePath(row.path) && safeQuery(row.request) && validAuthority && row.status === 200 && audit && !audit.error && !audit.cancelled && audit.fetchError === null && timing) {
      if (row.method === "HEAD" && audit.resolvedAt !== undefined && audit.abortAtResolve === false && audit.echo === stamp && row.echo === stamp)
        return "exact_head_resolved_with_driver_terminal_abort";
      if (row.method === "GET" && audit.eof && audit.abortAtEof === false && (audit.json || audit.bytes > 0 && audit.reads > 0)) return "completed_read_with_terminal_abort";
    }
    if (controlled && safePath(row.path) && safeQuery(row.request) && row.method === "GET" && validAuthority && row.status === null && audit?.abort && audit.fetchError === "AbortError" && !audit.eof && audit.bytes === 0 && !audit.error && !audit.cancelled)
      return "controlled_exact_stale_read_abort";
    const hash = canonical(row.request.url()), documents = rows.filter(value => value.navigation && value.resource === "document" && value.method === "GET" && value.generation === row.generation &&
      value.status === 200 && value.finished && !value.failed && value.terminalAt !== null && value.terminalAt <= row.terminalAt!);
    const paths = new Set(["/", "/navigation", "/stores", "/products", "/orders", "/listings", "/business-tasks", "/ai-tasks", "/settings/ai",
      ...[...accountIds].map(id => "/stores/" + id), ...[...listingIds].map(id => "/listings/" + id)]);
    if (controlled && row.method === "GET" && row.status === 200 && row.prefetch && row.resource === "fetch" && !row.navigation && row.authority === null && row.echo === null &&
      timing && paths.has(row.path) && hash && documents.length === 1 && identities.length === 1 && links.some(link => link.generation === row.generation && link.hash === hash)) return "controlled_exact_dom_prefetch_cancel";
    return null;
  }
  async function stable() { await expect.poll(() => rows.filter(row => !row.finished && !row.failed && !classify(row)).map(row => row.ordinal), { timeout: 15_000 }).toEqual([]); }
  return { accountIds, listingIds, previewIds, currentAuthority,
    registerSource(source: z.infer<typeof Source>) { sources.set(source.listingId, source); listingIds.add(source.listingId); accountIds.add(source.accountId); },
    registerPreview(value: z.infer<typeof PublicationPreviewRequestViewSchema>) { previewIds.add(value.request.id);
      if (value.intent) lookups.add(value.intent.requestKey + ":" + value.intent.requestChecksum); },
    acceptCreatedStore(value: z.infer<typeof MarketplaceAuthorityWorkspaceSchema>) {
      const url = new URL(page.url()), queryHash = canonical(url.href);
      if (!accountIds.has(value.account.id) || value.account.authorizationMode !== "amazon_public" || value.account.hasCredential || value.context.authority !== personal ||
        url.origin !== "http://localhost:3130" || url.pathname !== "/stores/" + value.account.id || url.search || url.hash || !queryHash || createdStores.length !== 0)
        throw new Error("amazon_public_created_store_not_bound_to_actual_page");
      createdStores.push({ accountId: value.account.id, authority: value.context.authority, generation, acceptedAt: Date.now(), acceptedPageSha256: sha(url.href), queryHash });
    },
    loss(request: Request) { if (request.method() !== "POST" || new URL(request.url()).pathname !== "/api/erp-publication-preview/requests") throw new Error("amazon_public_loss_wrong_request"); losses.set(request, { consumed: false, console: false }); },
    beginOAuth(accountId: string, actionId: string, authority: string, previousGeneration: string) { oauth = { accountId, actionId, authority, previousGeneration, matched: false, approved: false, attempts: 0 }; },
    async approveOAuth() { await Promise.all(validations); expect(oauth?.matched).toBe(true); expect(oauth?.attempts).toBe(1); if (!oauth) throw new Error("amazon_public_oauth_missing"); oauth.approved = true; },
    async control<T>(kind: string, action: () => Promise<T>) {
      const window = { kind, start: Date.now(), end: Number.POSITIVE_INFINITY, generation }; windows.push(window);
      try { return await action(); } finally { window.end = Date.now(); }
    }, stable,
    proof: () => ({ requests: rows.map(row => ({ ...row, request: undefined, classification: classify(row) })), audits: [...audits.values()], sessions, controls: windows, createdStores,
      oauth: oauth ? { accountId: oauth.accountId, matched: oauth.matched, approved: oauth.approved, attempts: oauth.attempts } : null }),
    check() {
      for (const [request, loss] of losses) {
        const row = rows.find(row => row.request === request); if (row?.failed && classify(row) === "injected_exact_original201_loss") {
          const matches = consoleErrors.filter(error => !error.consumed && error.loss && error.path === row.path && windows.some(window =>
            row.at >= window.start && row.terminalAt !== null && row.terminalAt <= window.end && error.at >= window.start && error.at <= window.end));
          if (matches.length === 1) { matches[0]!.consumed = true; loss.console = true; } loss.consumed = true;
        }
      }
      expect(rows.filter(row => row.status !== null && row.status >= 400).map(row => ({ ordinal: row.ordinal, status: row.status, path: row.path }))).toEqual([]);
      expect(rows.filter(row => (row.failed || !row.finished) && !classify(row)).map(row => ({ ordinal: row.ordinal, method: row.method, path: row.path, status: row.status, aborted: row.aborted }))).toEqual([]);
      expect(consoleErrors.filter(error => !error.consumed)).toEqual([]); expect(pageErrors).toEqual([]);
    } };
}

type Seen = Awaited<ReturnType<typeof observe>>;
async function authority(page: Page, id: string, seen: Seen) {
  const current = await seen.currentAuthority(), response = await page.request.get(`/api/marketplace-accounts/${id}/authority`, { headers: { "x-yummyai-context-authority": current.value } });
  expect(response.status()).toBe(200); expect(response.headers()["x-yummyai-context-authority"]).toBe(current.value);
  const value = MarketplaceAuthorityWorkspaceSchema.parse(await response.json());
  expect(value.account.id).toBe(id); expect(value.context).toEqual({ actorId: current.session.userId, tenantId: current.session.tenantId, authority: current.value }); return value;
}
async function readPreview(page: Page, id: string, seen: Seen) {
  const current = await seen.currentAuthority(), response = await page.request.get("/api/erp-publication-preview/requests/" + id, { headers: { "x-yummyai-context-authority": current.value } });
  expect(response.status()).toBe(200); expect(response.headers()["x-yummyai-context-authority"]).toBe(current.value);
  return PublicationPreviewRequestViewSchema.parse(await response.json());
}
async function picture(page: Page, info: TestInfo, name: string, target: Locator) {
  await target.scrollIntoViewIfNeeded(); await expect(target).toBeInViewport();
  await expect.poll(() => target.evaluate(element => {
    for (let current: Element | null = element; current; current = current.parentElement) if (Number(getComputedStyle(current).opacity) !== 1) return false;
    return element.getAnimations({ subtree: true }).every(animation => animation.playState !== "running" || animation.effect?.getTiming().iterations === Infinity);
  })).toBe(true);
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  const path = info.outputPath(name + ".png"); await page.screenshot({ path, fullPage: false }); await info.attach(name, { path, contentType: "image/png" });
}
async function choosePreview(page: Page, source: z.infer<typeof Source>) {
  await expect(preview(page)).toBeVisible(); await preview(page).getByRole("combobox", { name: "原批准 SKU", exact: true }).selectOption(source.variantSkuId);
  await preview(page).getByRole("combobox", { name: "原店铺与站点", exact: true }).selectOption(source.accountId + ":ATVPDKIKX0DER");
  await preview(page).getByRole("button", { name: "核对这份原预览", exact: true }).click();
  await preview(page).getByRole("checkbox", { name: "已核对原店铺 原批准版本与节点 只保存校验预览", exact: true }).check();
}
async function finalProof(page: Page, info: TestInfo, f: Fixture, seen: Seen, proof: object, primary: unknown) {
  const errors: unknown[] = primary ? [primary] : []; let networkFailed = false, cleanupFailed = false;
  try { await seen.currentAuthority(); await seen.stable(); seen.check(); } catch (error) { errors.push(error); networkFailed = true; }
  try { await f.close(); } catch (error) { errors.push(error); cleanupFailed = true; }
  const path = info.outputPath("amazon-public-node-proof.json");
  await writeFile(path, JSON.stringify({ operation: "3d7f9a21", title: info.title, groupId: f.seed.groupId, actualPersonalOidc: true, actualCliAndMtls: true,
    externalProvider: "synthetic_tls_after_original_policy", actualPlatformPublication: false, primaryFailure: Boolean(primary), networkFailed, cleanupFailed, ...proof, network: seen.proof() }));
  await info.attach("amazon-public-node-proof", { path, contentType: "application/json" });
  if (errors.length) throw new AggregateError(errors, "amazon_public_node_browser_failed");
}
// eslint-disable-next-line no-empty-pattern -- Explicit shutdown uses only the original private control and test metadata.
test.afterAll(async ({}, info) => {
  test.setTimeout(90_000);
  const value = await config(), errors: unknown[] = []; let receipt: unknown;
  try {
    expect(z.object({ accepted: z.literal(true), nonce: z.literal(isolated.nonce), pid: z.literal(value.pid) }).strict().parse(await control({ operation: "shutdown" }, 202))).toBeDefined();
    await expect.poll(async () => { try { receipt = JSON.parse(await readFile(resolve(isolated.lane, "browser-api-close-" + isolated.nonce + ".json"), "utf8")); return true; } catch { return false; } }, { timeout: 60_000 }).toBe(true);
    const closed = z.object({ nonce: z.literal(isolated.nonce), pid: z.literal(value.pid), roleRestored: z.literal(true), savedRoleDigest: Digest, restoredRoleDigest: Digest,
      databaseClosed: z.literal(true), controlClosed: z.literal(true), cleanupFailureCount: z.literal(0), apiClosed: z.literal(true), providerClosed: z.literal(true), bootstrapClosed: z.literal(true),
      childExits: z.array(z.object({ exited: z.literal(true), leaked: z.literal(false) }).passthrough()) }).strict().parse(receipt);
    expect(closed.savedRoleDigest).toBe(closed.restoredRoleDigest); expect(closed.childExits.length).toBeGreaterThan(0);
  } catch (error) { errors.push(error); }
  const path = info.outputPath("amazon-public-node-api-close.json"); await writeFile(path, JSON.stringify({ actualReceipt: receipt ?? null, failed: errors.length > 0 }));
  await info.attach("amazon-public-node-api-close", { path, contentType: "application/json" });
  if (errors.length) throw new AggregateError(errors, "amazon_public_node_actual_api_shutdown_failed");
});

test.describe("real personal Amazon public application onboarding and original node preview", () => {
  test("creates an explicit public OAuth store in the real UI then runs its original node capability and validation preview", async ({ page }, info) => {
    const f = await fixture("public_ui"), seen = await observe(page), proof: Record<string, unknown> = {}; let primary: unknown;
    let capabilityPosts = 0, previewPosts = 0;
    page.on("request", request => { const path = new URL(request.url()).pathname; if (request.method() !== "POST") return;
      if (/^\/api\/marketplace-accounts\/[a-f0-9-]{36}\/node-executions$/.test(path)) capabilityPosts++;
      if (path === "/api/erp-publication-preview/requests") previewPosts++; });
    try {
      await page.setViewportSize({ width: 1440, height: 960 });
      await seen.control("login", async () => { await loginErp(page, "operator", "/stores"); const current = await seen.currentAuthority();
        expect(current.session).toMatchObject({ userId: f.seed.actorId, tenantId: f.seed.tenantId }); await seen.stable(); });
      let accountId = "";
      await seen.control("create_public", async () => {
        await page.getByRole("button", { name: "新增店铺", exact: true }).click(); const dialog = page.getByRole("dialog", { name: "新增店铺", exact: true });
        await expect(dialog.getByRole("combobox", { name: "平台连接方式", exact: true })).toHaveValue("amazon_private");
        await dialog.getByRole("textbox", { name: "店铺名称", exact: true }).fill(f.seed.displayName);
        await dialog.getByRole("combobox", { name: "平台连接方式", exact: true }).selectOption("amazon_public");
        await dialog.getByRole("button", { name: "创建店铺档案", exact: true }).click();
        await expect(page).toHaveURL(url => /^\/stores\/[a-f0-9-]{36}$/.test(url.pathname)); accountId = Id.parse(new URL(page.url()).pathname.split("/").at(-1));
        seen.accountIds.add(accountId); expect(await f.call("register", { accountId })).toEqual({ registered: true, accountId });
        await expect(lifecycle(page)).toHaveAttribute("aria-busy", "false"); const created = await authority(page, accountId, seen);
        expect(created.account.authorizationMode).toBe("amazon_public"); seen.acceptCreatedStore(created); await seen.stable();
      });
      const before = await authority(page, accountId, seen), actionId = await oauthAction(); seen.beginOAuth(accountId, actionId, before.context.authority, before.lifecycle.authorizationGeneration);
      type Code = { state: string; code: string; sellingPartnerId: string };
      let entered!: (value: Code) => void, reject!: (error: unknown) => void;
      const consent = new Promise<Code>((yes, no) => { entered = yes; reject = no; }); void consent.catch(() => {});
      await page.route("https://sellercentral.amazon.com/apps/authorize/consent?**", async route => {
        try { const input = z.object({ state: z.string().regex(/^[A-Za-z0-9_-]{43}$/), code: z.string().startsWith("SYNTHETIC-AMAZON-CODE-"), sellingPartnerId: z.string().startsWith("SYNTHETIC-") }).strict()
          .parse(await f.call("oauth", { authorizationUrl: route.request().url() }));
          await route.fulfill({ status: 200, contentType: "text/html", body: "<!doctype html><title>Synthetic Amazon consent</title><h1>Synthetic Amazon consent</h1>" }); entered(input);
        } catch (error) { reject(error); }
      }, { times: 1 });
      await seen.control("oauth", async () => {
        await page.getByRole("region", { name: "设置", exact: true }).getByRole("button", { name: "前往平台授权", exact: true }).click(); const input = await consent;
        await expect(page.getByRole("heading", { name: "Synthetic Amazon consent", exact: true })).toBeVisible();
        const cookies = (await page.context().cookies()).filter(cookie => cookie.name === marketplaceOAuthCookieName(input.state)); expect(cookies).toHaveLength(1);
        const cookie = cookies[0]!, binding = MarketplaceOAuthBindingSchema.parse(JSON.parse(decodeURIComponent(cookie.value))), pending = await authority(page, accountId, seen);
        expect(cookie).toMatchObject({ httpOnly: true, secure: true, domain: "localhost", path: "/stores/oauth/callback", sameSite: "Lax" });
        expect(binding).toMatchObject({ accountId, actorId: f.seed.actorId, tenantId: f.seed.tenantId, platform: "amazon", stateDigest: marketplaceOAuthStateDigest(input.state),
          authority: before.context.authority, authorizationGeneration: pending.lifecycle.authorizationGeneration });
        expect(Date.parse(binding.expiresAt)).toBeGreaterThan(Date.now()); expect(pending.lifecycle.authorizationGeneration).not.toBe(before.lifecycle.authorizationGeneration);
        expect(pending.lifecycle.pendingOAuthStateDigest).toBe(marketplaceOAuthPendingStateDigest(input.state)); expect(pending.account.hasCredential).toBe(false);
        await page.goto("/stores/oauth/callback?" + new URLSearchParams({ state: input.state, spapi_oauth_code: input.code, selling_partner_id: input.sellingPartnerId }));
        await expect(page).toHaveURL(url => url.pathname === "/stores/" + accountId && url.search === "?oauth=success"); await expect(lifecycle(page)).toHaveAttribute("aria-busy", "false");
        const authorized = await authority(page, accountId, seen); expect(authorized.account.hasCredential).toBe(true); expect(authorized.lifecycle.refreshState).toBe("known");
        expect(authorized.lifecycle.authorizationGeneration).toBe(binding.authorizationGeneration); expect(authorized.lifecycle.pendingOAuthStateDigest).toBeNull();
        expect((await page.context().cookies()).filter(cookie => cookie.name === marketplaceOAuthCookieName(input.state))).toHaveLength(0);
        const snapshot = Snapshot.parse(await f.call("snapshot")); expect(snapshot.codeExchanges).toBe(1); expect(snapshot.centralRefreshes).toBe(0);
        await seen.approveOAuth(); await seen.stable(); proof.oauthCookieBoundAndConsumed = true;
      });
      const bound = z.object({ nodeId: Id, actualCli: z.literal(true) }).strict().parse(await f.call("bind"));
      await seen.control("capability_review", async () => {
        await capability(page).getByRole("button", { name: "重新读取执行状态", exact: true }).click();
        const guidance = capability(page).locator("details").filter({ has: page.locator("summary").filter({ hasText: /^公开应用节点运行指引$/ }) });
        await guidance.locator("summary").click(); await expect(guidance).toContainText("STORE_NODE_AMAZON_APP_CLIENT_ID"); await expect(guidance).toContainText("STORE_NODE_AMAZON_APP_CLIENT_SECRET");
        await capability(page).locator("summary").filter({ hasText: /^准备本店能力同步$/ }).click();
        await capability(page).getByRole("textbox", { name: "Amazon Product Types", exact: true }).fill("HOME");
        await capability(page).getByRole("button", { name: "核对本次同步", exact: true }).click();
        await capability(page).getByRole("checkbox", { name: "已核对本店 原绑定节点和本次能力范围", exact: true }).check();
        const saved = page.waitForResponse(response => response.request().method() === "POST" && new URL(response.url()).pathname === `/api/marketplace-accounts/${accountId}/node-executions`)
          .then(async response => ({ status: response.status(), value: StoreNodeExecutionViewSchema.parse(await response.json()) }));
        await capability(page).getByRole("button", { name: "保存并交绑定节点同步", exact: true }).click(); const queued = await saved;
        expect(queued.status).toBe(201); expect(queued.value.nodeId).toBe(bound.nodeId); expect(capabilityPosts).toBe(1);
        await f.call("work"); await expect.poll(async () => {
          const current = await seen.currentAuthority(), response = await page.request.get(`/api/marketplace-accounts/${accountId}/node-executions/${queued.value.id}`, { headers: { "x-yummyai-context-authority": current.value } });
          expect(response.status()).toBe(200); return StoreNodeExecutionViewSchema.parse(await response.json()).state;
        }, { timeout: 60_000 }).toBe("succeeded");
        await capability(page).getByRole("button", { name: "重新读取原任务", exact: true }).click();
        await expect(capability(page).getByRole("region", { name: "本任务原能力快照", exact: true })).toBeVisible(); await seen.currentAuthority(); await seen.stable();
        proof.capabilityExecutionId = queued.value.id;
      });
      const source = Source.parse(await f.call("source")); seen.registerSource(source);
      await seen.control("open_listing", async () => { await page.goto("/listings/" + source.listingId + "?" + new URLSearchParams({ listingVersionId: source.versionId, tab: "Publish" }));
        await choosePreview(page, source); await seen.currentAuthority(); await seen.stable(); });
      const saved = page.waitForResponse(response => response.request().method() === "POST" && new URL(response.url()).pathname === "/api/erp-publication-preview/requests")
        .then(async response => ({ status: response.status(), value: PublicationPreviewRequestViewSchema.parse(await response.json()) }));
      await preview(page).getByRole("button", { name: "保存原节点预览", exact: true }).click(); const queued = await saved; expect(queued.status).toBe(201);
      seen.registerPreview(queued.value); expect(queued.value.request.listingVersionId).toBe(source.versionId); expect(previewPosts).toBe(1);
      await expect.poll(async () => (await readPreview(page, queued.value.request.id, seen)).execution?.state, { timeout: 60_000 }).toBe("succeeded");
      await seen.control("refresh_preview", async () => { await detail(page).getByRole("button", { name: "重新读取原预览", exact: true }).click();
        await expect(detail(page).getByRole("heading", { name: "校验通过 未发布", exact: true })).toBeVisible(); await seen.currentAuthority(); await seen.stable(); });
      const final = Snapshot.parse(await f.call("snapshot")); expect(final.snapshots).toHaveLength(1); expect(final.requests).toHaveLength(1); expect(final.codeExchanges).toBe(1);
      expect(final.centralRefreshes).toBe(0); expect(final.nodeApplicationRefreshes).toBe(2); expect(final.counts.amazon_lwa).toBe(2); expect(final.counts.amazon_listing_validation_preview).toBe(1);
      expect(capabilityPosts).toBe(1); expect(previewPosts).toBe(1); expect(await page.locator("body").innerText()).not.toMatch(/SYNTHETIC-(?:CENTRAL|NODE|PUBLIC-REFRESH|PUBLIC-ACCESS)-/);
      await picture(page, info, "public-preview-desktop", detail(page).getByRole("heading", { name: "校验通过 未发布", exact: true }));
      await page.setViewportSize({ width: 390, height: 844 }); await picture(page, info, "public-preview-mobile", detail(page).getByRole("heading", { name: "校验通过 未发布", exact: true }));
      Object.assign(proof, { accountId, originalRequestId: queued.value.request.id, originalVersionId: source.versionId, publicModeSelectedInRealDialog: true,
        capabilityPosts, previewPosts, centralCodeExchange: 1, distinctLocalRefreshes: 2, business: final.business });
    } catch (error) { primary = error; }
    await finalProof(page, info, f, seen, proof, primary);
  });

  test("recovers one lost public preview response after remount by original receipt GET without another POST or provider request", async ({ page }, info) => {
    const f = await fixture("preview_recovery"), source = Source.parse(f.seed.source), seen = await observe(page), proof: Record<string, unknown> = {}; let primary: unknown;
    seen.registerSource(source); let posts = 0, stored: z.infer<typeof PublicationPreviewRequestViewSchema> | undefined;
    page.on("request", request => { if (request.method() === "POST" && new URL(request.url()).pathname === "/api/erp-publication-preview/requests") posts++; });
    try {
      await seen.control("login", async () => { await loginErp(page, "operator", "/listings/" + source.listingId + "?" + new URLSearchParams({ listingVersionId: source.versionId, tab: "Publish" }));
        const current = await seen.currentAuthority(); expect(current.session).toMatchObject({ userId: f.seed.actorId, tenantId: f.seed.tenantId }); await seen.stable(); });
      await seen.control("preview_review", async () => { await choosePreview(page, source); await seen.currentAuthority(); await seen.stable(); });
      const before = Snapshot.parse(await f.call("snapshot"));
      let released!: () => void; const lost = new Promise<void>(done => { released = done; });
      await page.route("**/api/erp-publication-preview/requests", async route => {
        const request = route.request(); expect(request.method()).toBe("POST"); const input = CreatePublicationPreviewInputSchema.parse(request.postDataJSON());
        expect(input.accountId).toBe(source.accountId); expect(input.listingVersionId).toBe(source.versionId);
        const response = await route.fetch(); expect(response.status()).toBe(201); stored = PublicationPreviewRequestViewSchema.parse(await response.json());
        expect(stored.intent).toMatchObject({ requestKey: input.requestKey, requestChecksum: input.requestChecksum }); expect(stored.request.listingVersionId).toBe(source.versionId);
        seen.registerPreview(stored); seen.loss(request); await route.abort("failed"); released();
      }, { times: 1 });
      await seen.control("save_preview_with_lost201", async () => { await preview(page).getByRole("button", { name: "保存原节点预览", exact: true }).click(); await lost;
        await expect(preview(page).getByRole("region", { name: "本人原发布预览恢复", exact: true })).toBeVisible(); await seen.currentAuthority(); await seen.stable(); });
      expect(posts).toBe(1); const id = stored!.request.id;
      await seen.control("reload_preview", async () => { await page.reload(); await expect(preview(page).getByRole("region", { name: "本人原发布预览恢复", exact: true })).toBeVisible();
        await seen.currentAuthority(); await seen.stable(); });
      await expect(preview(page).getByRole("button", { name: "核对这份原预览", exact: true })).toBeDisabled();
      const read = page.waitForResponse(response => response.request().method() === "GET" && new URL(response.url()).pathname === "/api/erp-publication-preview/receipt")
        .then(async response => ({ status: response.status(), value: PublicationPreviewReceiptSchema.parse(await response.json()) }));
      await preview(page).getByRole("button", { name: "只读取原预览回执", exact: true }).click(); const recovered = await read;
      expect(recovered.status).toBe(200); expect(recovered.value.request?.request.id).toBe(id); expect(posts).toBe(1);
      const restored = Snapshot.parse(await f.call("snapshot")); expect(restored.counts).toEqual(before.counts); expect(restored.requests).toHaveLength(1);
      expect(restored.intents).toHaveLength(1); expect(restored.intents[0]!.requestKey).toBe(stored!.intent!.requestKey);
      await f.call("work"); await expect.poll(async () => (await readPreview(page, id, seen)).execution?.state, { timeout: 60_000 }).toBe("succeeded");
      await seen.control("refresh_preview", async () => { await detail(page).getByRole("button", { name: "重新读取原预览", exact: true }).click();
        await expect(detail(page).getByRole("heading", { name: "校验通过 未发布", exact: true })).toBeVisible(); await seen.currentAuthority(); await seen.stable(); });
      const final = Snapshot.parse(await f.call("snapshot")); expect(final.requests).toHaveLength(1); expect(final.snapshots).toHaveLength(1); expect(final.centralRefreshes).toBe(0);
      expect((final.counts.amazon_lwa ?? 0) - (before.counts.amazon_lwa ?? 0)).toBe(1);
      expect((final.counts.amazon_listing_validation_preview ?? 0) - (before.counts.amazon_listing_validation_preview ?? 0)).toBe(1);
      const current = await seen.currentAuthority(), reread = page.waitForResponse(response => response.request().method() === "GET" && new URL(response.url()).pathname === "/api/erp-publication-preview/receipt")
        .then(async response => PublicationPreviewReceiptSchema.parse(await response.json()));
      await preview(page).getByRole("button", { name: "只读取原预览回执", exact: true }).click(); expect((await reread).request?.request.id).toBe(id);
      expect(Snapshot.parse(await f.call("snapshot")).counts).toEqual(final.counts); expect(posts).toBe(1);
      expect(current.value).toBe((await seen.currentAuthority()).value);
      await picture(page, info, "recovered-public-desktop", detail(page).getByRole("heading", { name: "校验通过 未发布", exact: true }));
      await page.setViewportSize({ width: 390, height: 844 }); await picture(page, info, "recovered-public-mobile", detail(page).getByRole("heading", { name: "校验通过 未发布", exact: true }));
      Object.assign(proof, { originalRequestId: id, originalRequestKey: stored!.intent!.requestKey, originalChecksum: stored!.intent!.requestChecksum,
        originalVersionId: source.versionId, previewPosts: posts, recoveryProviderDelta: 0, previewPhysicalHttp: 2, business: final.business });
    } catch (error) { primary = error; }
    await finalProof(page, info, f, seen, proof, primary);
  });
});
