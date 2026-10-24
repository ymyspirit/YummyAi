import { createHash, randomUUID } from "node:crypto";
import { writeFile } from "node:fs/promises";
import { expect, test, type Locator, type Page, type Request, type Route, type TestInfo } from "@playwright/test";
import { z } from "zod";
import { eq, sql } from "drizzle-orm";
import { Permission } from "@yummyai/authz";
import { TenantContextSchema } from "@yummyai/contracts";
import { ErpSessionViewSchema, erpSessionAuthority } from "@yummyai/contracts/auth/session";
import { canonicalJson } from "@yummyai/contracts/common/canonical-json";
import { AGENT_COMMAND_VERSION, AgentCommandViewSchema, PrepareAgentCommandSchema, ConfirmAgentCommandSchema, CancelAgentCommandSchema } from "@yummyai/contracts/ai/agent-command";
import { AGENT_DEPENDENCY_PLAN_INTENT_PREFIX, AGENT_DEPENDENCY_PLAN_VERSION, AgentDependencyPlanIntentSchema, AgentDependencyPlanReceiptSchema, AgentDependencyPlanViewSchema,
  CreateAgentDependencyPlanSchema, PrepareAgentDependencyPlanSchema } from "@yummyai/contracts/ai/agent-dependency-plan";
import { AGENT_RESOURCES_VERSION, AgentResourceDefinitionRequestSchema, AgentResourceCandidatesQuerySchema } from "@yummyai/contracts/ai/agent-resources";
import { AGENT_TOOLS_VERSION, AgentToolDefinitionRequestSchema } from "@yummyai/contracts/ai/agent-tools";
import { IncomingCommandViewSchema, type PrepareIncomingCommand } from "@yummyai/contracts/procurement/incoming-command";
import { IncomingWorkspaceViewSchema } from "@yummyai/contracts/procurement/incoming";
import { connectDatabase, roles, withTenant } from "@yummyai/database";
import { requireAgentDependencyPlanEnvironment } from "../../../tools/testing/require-agent-dependency-plan-environment.mjs";
import { actors, loginErp } from "./erp-identity-fixture";

const isolated = requireAgentDependencyPlanEnvironment(process.env, "current", true), sha = (value: string) => createHash("sha256").update(value).digest("hex");
const apiOrigin = process.env.API_BASE_URL!, prefix = AGENT_DEPENDENCY_PLAN_INTENT_PREFIX;
const hashValue = (value: unknown) => sha(canonicalJson(value));
const detail = (page: Page) => page.getByRole("region", { name: "跨域依赖计划详情", exact: true });
const original = (page: Page) => page.getByRole("region", { name: "核对 Agent 原操作", exact: true });

/** All source facts use existing authenticated HTTP owners. The only mutable
 * fixture data is this disposable runner actor's role, restored with exact CAS.
 * No direct invoice/bill/proof insert, model, queue or Worker is used. */
async function browserFixture() {
  const identityResponse = await fetch(new URL("/v1/identity/session", apiOrigin), { headers: { authorization: "Bearer " + process.env.API_ACCESS_TOKEN }, redirect: "error" });
  expect(identityResponse.status).toBe(200); const context = TenantContextSchema.parse(await identityResponse.json()), actor = actors().operator;
  expect(context.userId).toBe(actor.userId); expect(context.tenantId).toBe(actor.tenantId);
  const database = connectDatabase(isolated.url), owned = new Set<string>();
  let beforeRole: { permissions: string[]; dataScope: "self" | "team" | "tenant" };
  try {
    const [row] = await withTenant(database.db, context, tx => tx.select({ permissions: roles.permissions, dataScope: roles.dataScope }).from(roles).where(eq(roles.id, actor.roleId)));
    if (!row) throw new Error("dependency_browser_original_role_missing"); beforeRole = { permissions: [...row.permissions], dataScope: z.enum(["self", "team", "tenant"]).parse(row.dataScope) };
  } catch (error) { await database.client.end(); throw error; }
  let writtenRole = [...beforeRole.permissions], closed = false;
  async function api(path: string, body?: unknown) {
    if (!/^(?:identity\/session|sourcing\/suppliers|inventory\/(?:warehouses|locations|stock-items)|procurement\/(?:purchase-orders(?:\/[a-f0-9-]+\/reviews)?|incoming\/(?:commands(?:\/[a-f0-9-]+\/(?:execute|acknowledge))?|orders\/[a-f0-9-]+))|agent-commands\/(?:prepare|requests\/[a-f0-9-]+(?:\/(?:confirm|cancel|acknowledge))?)|agent-dependency-plans\/(?:requests(?:\/[a-f0-9-]+)?|receipts\?[a-zA-Z0-9=&-]+))$/.test(path))
      throw new Error("dependency_browser_http_path_invalid");
    const response = await fetch(new URL("/v1/" + path, apiOrigin), { method: body === undefined ? "GET" : "POST", redirect: "error", headers: {
      authorization: "Bearer " + process.env.API_ACCESS_TOKEN, ...(body === undefined ? {} : { "content-type": "application/json" }),
    }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
    if (!response.ok) throw new Error("dependency_browser_original_http_" + response.status); return response.json() as Promise<unknown>;
  }
  async function incoming(input: PrepareIncomingCommand) {
    const value = IncomingCommandViewSchema.parse(await api("procurement/incoming/commands", input));
    const completed = IncomingCommandViewSchema.parse(await api(`procurement/incoming/commands/${value.id}/execute`, {}));
    expect(completed.status).toBe("succeeded"); expect(completed.result?.kind).toBe(input.kind);
    expect(IncomingCommandViewSchema.parse(await api(`procurement/incoming/commands/${value.id}/acknowledge`, {})).acknowledged).toBe(true);
    return completed.result!.id;
  }
  async function seed() {
    const code = "DEPENDENCY-" + randomUUID().slice(0, 8).toUpperCase();
    const supplier = z.object({ id: z.uuidv7() }).parse(await api("sourcing/suppliers", { name: "Synthetic " + code, kind: "manual", regionCode: "US", settlementCurrency: "USD" }));
    const warehouse = z.object({ id: z.uuidv7() }).parse(await api("inventory/warehouses", { code: code + "-WH", name: "Synthetic actual receiving", type: "owned", countryCode: "US", timeZone: "UTC" }));
    const location = z.object({ id: z.uuidv7() }).parse(await api("inventory/locations", { warehouseId: warehouse.id, code: code + "-LOC", name: "Synthetic receiving location" }));
    const stock = z.object({ id: z.uuidv7() }).parse(await api("inventory/stock-items", { skuId: null, code: code + "-MAT", name: "Synthetic dependency material", baseUnit: "gram", materialKind: "material" }));
    const order = z.object({ id: z.uuidv7() }).parse(await api("procurement/purchase-orders", { code: code + "-PO", supplierId: supplier.id, requisitionId: null, quoteId: null,
      currency: "USD", expectedAt: new Date(Date.now() + 86_400_000).toISOString(), lines: [{ lineKey: "LINE-1", stockItemId: stock.id, destinationLocationId: location.id,
        quantity: "0.25", unit: "kilogram", unitCostMinor: 1200, priceBasisQuantity: 1 }], idempotencyKey: randomUUID() }));
    await api(`procurement/purchase-orders/${order.id}/reviews`, { expectedVersion: 1, decision: "approved", reasonCode: "SYNTHETIC", idempotencyKey: randomUUID() });
    const at = new Date().toISOString(), standard = await incoming({ kind: "publish_standard", targetId: stock.id, input: { code: code + "-STD", stockItemId: stock.id, expectedVersion: 0,
      title: "Synthetic actual width observation", sourceReference: "Disposable actual receiving only no external supplier interaction",
      criteria: [{ code: "WIDTH", label: "Synthetic width", kind: "numeric_range", unit: "mm", minimum: "9", maximum: "11" }], idempotencyKey: randomUUID() } });
    const arrival = await incoming({ kind: "record_arrival", targetId: order.id, input: { code: code + "-ARR", expectedPurchaseOrderVersion: 1, arrivedAt: at,
      externalReference: "Synthetic actual measured receiving", lines: [{ lineKey: "LINE-1", quantity: 200, unit: "gram", holdingLocationId: location.id, lotCode: code + "-LOT", expiresAt: null }], idempotencyKey: randomUUID() } });
    const receiving = IncomingWorkspaceViewSchema.parse(await api("procurement/incoming/orders/" + order.id)), line = receiving.arrivals.find(row => row.id === arrival)!.lines[0]!;
    const inspection = await incoming({ kind: "record_inspection", targetId: line.id, input: { expectedInspectionVersion: 0, standardVersionId: standard, acceptedQuantity: 200, rejectedQuantity: 0,
      sampleQuantity: 1, rejectionReason: null, measuredAt: at, readings: [{ criterionCode: "WIDTH", value: "10", unit: "mm" }], notes: null, idempotencyKey: randomUUID() } });
    const approval = await incoming({ kind: "review_inspection", targetId: line.id, input: { expectedInspectionVersion: 1, inspectionId: inspection, decision: "approved", reason: "Synthetic actual observation checked", idempotencyKey: randomUUID() } });
    await incoming({ kind: "post_inspection", targetId: line.id, input: { expectedInspectionVersion: 1, approvalId: approval, acceptedQuantity: 200, rejectedQuantity: 0, rejectionLocationId: null,
      ownershipConfirmation: "merchant_received", postedAt: at, idempotencyKey: randomUUID() } });
    const input = PrepareAgentCommandSchema.parse({ version: AGENT_COMMAND_VERSION, requestId: randomUUID(), original: { domain: "procurement", command: { kind: "invoice_record", targetId: order.id,
      input: { expectedVersion: 1, invoiceNumber: code + "-INV", currency: "USD", issuedAt: at, lines: [{ lineKey: "LINE-1", invoicedQuantity: "0.1", unitCostMinor: 1200 }], idempotencyKey: randomUUID() } } } });
    const parent = AgentCommandViewSchema.parse(await api("agent-commands/prepare", input)); owned.add(parent.id);
    expect(parent).toMatchObject({ state: "prepared", kind: "invoice_record", domain: "procurement" }); expect(parent.snapshot?.native.view.status).toBe("prepared");
    return { parent, input, marker: code + "-INV", orderId: order.id };
  }
  async function state() {
    return withTenant(database.db, context, async tx => {
      const tables: Record<string, { count: number; sha256: string }> = {};
      for (const name of ["inventory_supplier_invoices", "inventory_supplier_invoice_lines", "inventory_supplier_invoice_requests", "inventory_supplier_invoice_allocations", "inventory_movements",
        "inventory_balances", "finance_payable_bills", "finance_payable_payments", "finance_original_write_proofs", "orders", "production_orders", "ai_budget_ledger", "ai_assist_runs", "agent_loop_runs"] ) {
        const [row] = await tx.execute<{ count: number; canonical: string }>(sql`select count(*)::int as count,coalesce(jsonb_agg(to_jsonb(t) order by to_jsonb(t)::text)::text,'[]') canonical from ${sql.identifier(name)} t`);
        if (!row) throw new Error("dependency_browser_snapshot_missing"); tables[name] = { count: row.count, sha256: sha(row.canonical) };
      }
      return tables;
    });
  }
  async function grant(values: string[]) {
    const changed = await withTenant(database.db, context, tx => tx.update(roles).set({ permissions: values }).where(eq(roles.id, actor.roleId)).returning({ id: roles.id }));
    if (changed.length !== 1) throw new Error("dependency_browser_original_role_changed"); writtenRole = [...values];
  }
  async function close() {
    if (closed) return; closed = true; const failures: unknown[] = [];
    try {
      const [actual] = await withTenant(database.db, context, tx => tx.select({ permissions: roles.permissions, dataScope: roles.dataScope }).from(roles).where(eq(roles.id, actor.roleId)));
      if (!actual || actual.dataScope !== beforeRole.dataScope || canonicalJson([...actual.permissions].sort()) !== canonicalJson([...writtenRole].sort())) throw new Error("dependency_browser_role_restore_cas_failed");
      await grant([...beforeRole.permissions]);
      const [restored] = await withTenant(database.db, context, tx => tx.select({ permissions: roles.permissions, dataScope: roles.dataScope }).from(roles).where(eq(roles.id, actor.roleId)));
      expect(restored).toEqual(beforeRole);
      for (const id of owned) {
        let value = AgentCommandViewSchema.parse(await api("agent-commands/requests/" + id));
        if (value.canCancel && value.ownerCommandId) value = AgentCommandViewSchema.parse(await api(`agent-commands/requests/${id}/cancel`, CancelAgentCommandSchema.parse({ version: AGENT_COMMAND_VERSION, requestId: value.requestId, ownerCommandId: value.ownerCommandId })));
        if (value.snapshot && value.ownerCommandId && value.snapshot.native.view.status !== "prepared" && !value.snapshot.native.view.acknowledged)
          await api(`agent-commands/requests/${id}/acknowledge`, { version: AGENT_COMMAND_VERSION, requestId: value.requestId, ownerCommandId: value.ownerCommandId });
      }
    } catch (error) { failures.push(error); }
    try { await database.client.end(); } catch (error) { failures.push(error); }
    if (failures.length) throw new AggregateError(failures, "dependency_browser_cleanup_failed");
  }
  return { seed, state, grant, originalPermissions: [...beforeRole.permissions], api, own(id: string) { owned.add(id); }, close };
}

const mountPosts = [
  { kind: "resource_definition", path: "/api/agent-resources/definition", body: AgentResourceDefinitionRequestSchema.parse({ version: AGENT_RESOURCES_VERSION, tool: "research.evidence" }) },
  { kind: "tool_definition", path: "/api/agent-tools/definition", body: AgentToolDefinitionRequestSchema.parse({ version: AGENT_TOOLS_VERSION, selection: { kind: "read", tool: "knowledge.search" } }) },
  { kind: "research_candidates", path: "/api/agent-resources/candidates", body: AgentResourceCandidatesQuerySchema.parse({ version: AGENT_RESOURCES_VERSION, tool: "research.evidence", q: "" }) },
] as const;
const fixedReads = ["/api/erp-auth/session", "/api/agent-loops/workspace", "/api/agent-plans/workspace", "/api/agent-native/workspace", "/api/agent-native-v2/workspace", "/api/agent-native-v3/workspace", "/api/agent-tools/workspace", "/api/agent-resources/workspace", "/api/agent-commands/workspace", "/api/agent-dependency-plans/workspace", "/api/agent-read/workspace", "/api/agent-reads/workspace", "/api/agent-fulfillment/workspace", "/api/ai-assists/models", "/api/ai-assists/runs", "/api/ai-assists/task-workspace"];
const families = ["loop", "plan", "native_v1", "native_v2", "native_v3"] as const;
const ReadAudit = z.object({ document: z.uuid(), sequence: z.int().positive(), key: z.string().regex(/^[a-f0-9]{64}$/), method: z.enum(["GET", "POST"]), start: z.number().finite(), status: z.int().nullable(),
  eof: z.boolean(), bytes: z.int().nonnegative(), reads: z.int().nonnegative(), abortAt: z.number().nullable(), abortAtEof: z.boolean().nullable(), cancel: z.boolean(), bodyError: z.boolean(), fetchError: z.enum(["AbortError", "Other"]).nullable(), fetchErrorAt: z.number().nullable() }).strict();
type Audit = z.infer<typeof ReadAudit> & { generation: number };
type Row = { request: Request; ordinal: number; generation: number; at: number; terminalAt: number | null; path: string; key: string; method: string; erp: boolean; bodyHash: string | null; authority: string | null; echo: string | null; status: number | null; document: boolean; resource: string; prefetch: boolean; rsc: boolean; mime: string | null; finished: boolean; failed: boolean; aborted: boolean; failure: "aborted" | "reset" | "failed" | "other" | null; classification: string | null; pair: string | null };
type AuthorityTransition = { planId: string; planPath: string; documentKey: string; oldGeneration: number; oldAuthority: string; mutationAt: number | null; focusAt: number | null;
  newGeneration: number | null; newAuthority: string | null; documentOrdinal: number | null; freshPlanOrdinal: number | null; privateAvailable: false | null; closedAt: number | null };
/** Only these existing original reads receive passive reader instrumentation.
 * The original Promise, response, signal and reader calls are preserved. */
async function observe(page: Page) {
  const origin = new URL(test.info().project.use.baseURL as string).origin, rows: Row[] = [], audits = new Map<string, Audit>(), documentIds = new Map<string, number>();
  const controls: Array<{ name: string; start: number; end: number; firstGeneration: number; lastGeneration: number }> = [], sessions: Array<{ at: number; generation: number; hash: string }> = [];
  const links: Array<{ at: number; generation: number; path: string; key: string }> = [], dom: Array<{ at: number; generation: number; authority: string; resource: string | null; tool: string | null; candidates: boolean }> = [];
  const writes: Array<{ path: string; bodyHash: string; status: number; request?: Request; loss: boolean; committed: boolean }> = [], held = new Map<Request, { path: string; oldAuthority: string; newAuthority: string | null; fetched: boolean; released: boolean }>();
  const clicked: Array<{ key: string; generation: number; at: number; arrivedAt: number; authority: string; commandId: string; planId: string }> = [];
  const authorityTransitions: AuthorityTransition[] = [], transitionPairs: Array<{ kind: "old_document_abort" | "new_document_initial_replacement"; ordinal: number; audit: string; successor: number; successorAudit: string; documentOrdinal: number }> = [];
  const errors: Array<{ kind: string; hash: string; at: number; path: string | null; network: "reset" | "failed" | null }> = []; let generation = 0, authority = "";
  const key = (url: URL) => { const entries = [...url.searchParams.entries()]; return new Set(entries.map(([name]) => name)).size === entries.length ? hashValue([url.pathname, entries.filter(([name]) => name !== "_rsc").sort(([a], [b]) => a.localeCompare(b))]) : ""; };
  const read = (url: URL) => !url.search && (fixedReads.includes(url.pathname) || families.some(family => url.pathname === "/api/agent-readiness/" + family || url.pathname === "/api/agent-runtime-readiness/" + family))
    || url.pathname === "/api/ai-assists/task-workspace" && url.search === "?page=1"
    || /^\/api\/agent-(?:dependency-plans|commands)\/(?:requests(?:\/[a-f0-9-]+)?|receipts)$/.test(url.pathname);
  await page.exposeBinding("__dependencyReadAudit", ({ frame }, raw: unknown) => {
    if (frame !== page.mainFrame()) return; const value = ReadAudit.safeParse(raw); if (!value.success) return;
    if (!documentIds.has(value.data.document)) documentIds.set(value.data.document, generation);
    audits.set(value.data.document + ":" + value.data.sequence, { ...value.data, generation: documentIds.get(value.data.document)! });
  });
  await page.addInitScript(({ reads, family, posts }) => {
    if (window !== window.top) return;
    const originalFetch = window.fetch, document = crypto.randomUUID(); let sequence = 0;
    const digest = async (value: string) => [...new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(value)))].map(value => value.toString(16).padStart(2, "0")).join("");
    const emit = (state: Omit<z.infer<typeof ReadAudit>, "key"> & { key: string }) => { if (!state.key) return; const binding = (window as unknown as { __dependencyReadAudit?: (state: unknown) => Promise<void> }).__dependencyReadAudit;
      if (binding) void binding({ ...state }).catch(() => {}); };
    window.fetch = function (...args) {
      let state: z.infer<typeof ReadAudit> | undefined;
      try {
        const input = args[0], options = args[1], url = new URL(input instanceof Request ? input.url : String(input), location.href), method = (options?.method ?? (input instanceof Request ? input.method : "GET")).toUpperCase();
        const post = method === "POST" && !url.search && posts.some(post => post.path === url.pathname && post.body === options?.body);
        const get = method === "GET" && (!url.search && (reads.includes(url.pathname) || family.some(family => url.pathname === "/api/agent-readiness/" + family || url.pathname === "/api/agent-runtime-readiness/" + family))
          || url.pathname === "/api/ai-assists/task-workspace" && url.search === "?page=1" || /^\/api\/agent-(?:dependency-plans|commands)\/(?:requests(?:\/[a-f0-9-]+)?|receipts)$/.test(url.pathname));
        if (url.origin === location.origin && (post || get)) {
          state = { document, sequence: ++sequence, key: "", method: post ? "POST" : "GET", start: Date.now(), status: null, eof: false, bytes: 0, reads: 0, abortAt: null, abortAtEof: null, cancel: false, bodyError: false, fetchError: null, fetchErrorAt: null };
          const observed = state, signal = options?.signal ?? (input instanceof Request ? input.signal : null);
          if (signal?.aborted) observed.abortAt = observed.start;
          signal?.addEventListener("abort", () => { observed.abortAt ??= Date.now(); emit(observed); }, { once: true });
          const entries = [...url.searchParams.entries()]; if (new Set(entries.map(([name]) => name)).size === entries.length)
            void digest(JSON.stringify([url.pathname, entries.filter(([name]) => name !== "_rsc").sort(([a], [b]) => a.localeCompare(b))])).then(hash => { observed.key = hash; emit(observed); });
        }
      } catch { /* Unknown input remains unclassified. */ }
      const pending = Reflect.apply(originalFetch, this, args) as Promise<Response>;
      if (state) { const observed = state;
        void pending.then(response => {
          observed.status = response.status; emit(observed);
          const eof = () => { if (!observed.eof) { observed.eof = true; observed.abortAtEof = observed.abortAt !== null; } emit(observed); };
          const json = response.json; response.json = function (...args) { const result = Reflect.apply(json, this, args) as Promise<unknown>; void result.then(eof, () => { observed.bodyError = true; emit(observed); }); return result; };
          if (response.body) { const getReader = response.body.getReader;
            response.body.getReader = function (this: ReadableStream<Uint8Array>, ...args: Parameters<typeof getReader>) {
              const reader = Reflect.apply(getReader, this, args) as ReadableStreamDefaultReader<Uint8Array>, read = reader.read, cancel = reader.cancel;
              reader.read = function (...args) { const result = Reflect.apply(read, this, args) as Promise<ReadableStreamReadResult<Uint8Array>>; void result.then(part => { observed.reads++; if (part.done) eof(); else { observed.bytes += part.value.byteLength; emit(observed); } }, () => { observed.bodyError = true; emit(observed); }); return result; };
              reader.cancel = function (...args) { observed.cancel = true; emit(observed); return Reflect.apply(cancel, this, args); }; return reader;
            } as typeof getReader;
          }
        }, error => { observed.fetchError = error instanceof DOMException && error.name === "AbortError" ? "AbortError" : "Other"; observed.fetchErrorAt = Date.now(); emit(observed); });
      }
      return pending;
    };
  }, { reads: fixedReads, family: families, posts: mountPosts.map(post => ({ path: post.path, body: JSON.stringify(post.body) })) });
  page.on("request", request => {
    const url = new URL(request.url()), header = request.headers(), document = request.isNavigationRequest() && request.resourceType() === "document" && request.frame() === page.mainFrame(); if (document) generation++;
    rows.push({ request, ordinal: rows.length + 1, generation, at: Date.now(), terminalAt: null, path: url.pathname, key: key(url), method: request.method(), erp: url.origin === origin,
      bodyHash: request.method() === "POST" ? (() => { try { return hashValue(request.postDataJSON()); } catch { return null; } })() : null,
      authority: header["x-yummyai-context-authority"] ? sha(header["x-yummyai-context-authority"]) : null, echo: null, status: null, document, resource: request.resourceType(), prefetch: header["next-router-prefetch"] === "1", rsc: header.rsc === "1", mime: null,
      finished: false, failed: false, aborted: false, failure: null, classification: null, pair: null });
  });
  page.on("response", response => { const row = rows.find(row => row.request === response.request()); if (row) { row.status = response.status(); const header = response.headers(); row.echo = header["x-yummyai-context-authority"] ? sha(header["x-yummyai-context-authority"]) : null;
    row.mime = header["content-type"]?.split(";", 1)[0]?.trim().toLowerCase() ?? null; } });
  page.on("requestfinished", request => { const row = rows.find(row => row.request === request); if (row) { row.finished = true; row.terminalAt = Date.now(); } });
  page.on("requestfailed", request => { const row = rows.find(row => row.request === request); if (row) { row.failed = true; const error = request.failure()?.errorText; row.aborted = error === "net::ERR_ABORTED";
    row.failure = row.aborted ? "aborted" : error === "net::ERR_CONNECTION_RESET" ? "reset" : error === "net::ERR_FAILED" ? "failed" : "other"; row.terminalAt = Date.now(); } });
  page.on("pageerror", error => errors.push({ kind: "page", hash: sha(error.name + ":" + error.message), at: Date.now(), path: null, network: null }));
  page.on("console", message => { if (message.type() !== "error") return; let path: string | null = null; try { const url = new URL(message.location().url); if (url.origin === origin) path = url.pathname; } catch { /* Unknown source remains an error. */ }
    const known = /^Failed to load resource: net::ERR_(CONNECTION_RESET|FAILED)$/.exec(message.text());
    errors.push({ kind: "console", hash: sha(message.text()), at: Date.now(), path, network: known?.[1] === "CONNECTION_RESET" ? "reset" : known?.[1] === "FAILED" ? "failed" : null }); });
  async function sampleLinks() {
    for (const href of await page.getByRole("link").evaluateAll(nodes => nodes.map(node => (node as HTMLAnchorElement).href))) { const url = new URL(href);
      if (url.origin === origin && ["/", "/navigation", "/ai-tasks", "/business-tasks", "/orders", "/settings/ai"].includes(url.pathname) && key(url)) links.push({ at: Date.now(), generation, path: url.pathname, key: key(url) }); }
  }
  async function current() {
    const response = await page.request.get("/api/erp-auth/session"); expect(response.status()).toBe(200); const session = ErpSessionViewSchema.parse(await response.json());
    expect(session.userId).toBe(actors().operator.userId); expect(session.tenantId).toBe(actors().operator.tenantId); authority = sha(erpSessionAuthority(session)); sessions.push({ at: Date.now(), generation, hash: authority });
    await sampleLinks();
    const resource = page.getByRole("region", { name: "业务资源读取", exact: true }), tools = page.getByRole("region", { name: "原生工具与命令目录", exact: true });
    async function definition(region: Locator, name: string, selected: string) { const shown = region.locator('button[aria-pressed="true"]').filter({ hasText: selected }), code = region.getByRole("region", { name, exact: true }).locator("details").filter({ has: page.getByText("固定定义校验值", { exact: true }) }).locator("code");
      if (await shown.count() !== 1 || await code.count() !== 1) return null; const text = (await code.textContent())?.trim(); return text && /^[a-f0-9]{64}$/.test(text) ? text : null; }
    const resourceHash = await definition(resource, "所选业务资源定义", "research.evidence"), toolHash = await definition(tools, "所选严格工具定义", "knowledge.search"), picker = resource.getByRole("region", { name: "原业务对象候选", exact: true });
    const search = resource.getByRole("textbox", { name: "搜索原业务对象", exact: true }), choice = picker.getByRole("combobox", { name: "选择原业务对象", exact: true });
    const candidates = !!resourceHash && await picker.getAttribute("aria-busy") === "false" && await search.count() === 1 && await choice.count() === 1 && await search.inputValue() === "" && await choice.inputValue() === ""
      && await picker.getByText(/^本页 \d+ 项 · 原服务报告总数 (?:\d+|未知) · 当前候选始终为有界范围 不称全量$/).count() === 1 && await picker.getByRole("alert").count() === 0;
    dom.push({ at: Date.now(), generation, authority, resource: resourceHash, tool: toolHash, candidates }); return authority;
  }
  const complete = (audit: Audit | null): audit is Audit => !!audit?.eof && audit.abortAtEof === false && !audit.cancel && !audit.bodyError && !audit.fetchError;
  const zeroTiming = (row: Row) => { const timing = row.request.timing(); return row.status === null && timing.startTime === 0 && timing.requestStart === -1 && timing.responseStart === -1 && timing.responseEnd === -1; };
  function pair(row: Row, unresolved = false) {
    const timing = row.request.timing(), fallback = unresolved && zeroTiming(row), started = fallback ? row.at : timing.startTime;
    if (!fallback && (started <= 0 || timing.responseStart < 0)) return null;
    const values = [...audits.values()].filter(value => value.generation === row.generation && value.key === row.key && value.method === row.method && value.status === row.status && Math.abs(value.start - started) <= 25);
    if (values.length !== 1) return null; const value = values[0]!;
    return rows.filter(other => other.generation === row.generation && other.key === value.key && other.method === value.method && other.status === value.status && Math.abs((fallback && zeroTiming(other) ? other.at : other.request.timing().startTime) - value.start) <= 25).length === 1 ? value : null;
  }
  async function stable() { await expect.poll(() => rows.filter(row => !row.finished && !row.failed).length, { timeout: 25_000, message: "Every original network request must actually terminate" }).toBe(0); }
  async function control(name: string, action: () => Promise<void>) { const item = { name, start: Date.now(), end: 0, firstGeneration: generation, lastGeneration: generation }; controls.push(item);
    try { await action(); await current(); await stable(); await current(); } finally { item.end = Date.now(); item.lastGeneration = generation; } }
  async function clickOriginal(link: Locator, commandId: string, planId: string) {
    const href = await link.getAttribute("href"); if (!href) throw new Error("dependency_original_href_missing"); const url = new URL(href, page.url());
    expect(url.origin).toBe(origin); expect(url.pathname).toBe("/ai-tasks"); expect(url.searchParams.getAll("agentCommand")).toEqual([commandId]); expect(url.searchParams.getAll("agentDependencyPlan")).toEqual([planId]);
    const value = { key: key(url), generation, at: Date.now(), arrivedAt: 0, authority, commandId, planId }; if (!value.key || !authority) throw new Error("dependency_original_link_identity_missing"); clicked.push(value);
    await link.click(); await expect.poll(() => key(new URL(page.url()))).toBe(value.key); await expect(original(page)).toContainText(commandId); value.arrivedAt = Date.now();
  }
  function beginAuthorityTransition(planId: string) {
    const url = new URL(page.url());
    if (url.origin !== origin || url.pathname !== "/ai-tasks" || url.searchParams.getAll("agentDependencyPlan").length !== 1 || url.searchParams.get("agentDependencyPlan") !== planId || !authority || !key(url))
      throw new Error("dependency_transition_original_page_invalid");
    const item: AuthorityTransition = { planId, planPath: "/api/agent-dependency-plans/requests/" + planId, documentKey: key(url), oldGeneration: generation, oldAuthority: authority,
      mutationAt: null, focusAt: null, newGeneration: null, newAuthority: null, documentOrdinal: null, freshPlanOrdinal: null, privateAvailable: null, closedAt: null };
    authorityTransitions.push(item); return item;
  }
  function observeTransitionDocument(item: AuthorityTransition, request: Request, freshAuthority: string) {
    const row = rows.find(row => row.request === request);
    if (!row || !row.document || !row.erp || row.method !== "GET" || row.path !== "/ai-tasks" || row.key !== item.documentKey || row.status !== 200 || !row.finished || row.failed
      || item.focusAt === null || row.at < item.focusAt || row.generation !== item.oldGeneration + 1 || freshAuthority === item.oldAuthority)
      throw new Error("dependency_transition_actual_document_invalid");
    item.newGeneration = row.generation; item.newAuthority = freshAuthority; item.documentOrdinal = row.ordinal;
  }
  async function observeFreshPlan(item: AuthorityTransition, request: Request) {
    const row = rows.find(row => row.request === request);
    if (!row || row.path !== item.planPath || row.generation !== item.newGeneration || row.authority !== item.newAuthority || row.echo !== item.newAuthority || row.status !== 200)
      throw new Error("dependency_transition_fresh_plan_invalid");
    await expect.poll(() => complete(pair(row)), { timeout: 15_000, message: "The existing fresh plan GET must reach its original reader EOF before drawer close" }).toBe(true);
    item.freshPlanOrdinal = row.ordinal; item.privateAvailable = false;
  }
  function transitionDocument(item: AuthorityTransition, window: typeof controls[number]) {
    if (window.name !== "withdraw_actual_permission" || item.mutationAt === null || item.focusAt === null || item.mutationAt < window.start || item.focusAt < item.mutationAt || item.focusAt > window.end
      || item.oldGeneration !== window.firstGeneration || item.newGeneration !== window.lastGeneration || item.newGeneration !== item.oldGeneration + 1 || !item.newAuthority || item.newAuthority === item.oldAuthority) return null;
    const oldSessions = [...new Set(sessions.filter(session => session.generation === item.oldGeneration && session.at <= item.focusAt!).map(session => session.hash))];
    const newSessions = [...new Set(sessions.filter(session => session.generation === item.newGeneration).map(session => session.hash))];
    const oldDocuments = rows.filter(row => row.document && row.erp && row.method === "GET" && row.path === "/ai-tasks" && row.generation === item.oldGeneration && row.status === 200 && row.finished && !row.failed && row.terminalAt !== null && row.terminalAt < item.mutationAt!);
    const nextDocuments = rows.filter(row => row.document && row.erp && row.method === "GET" && row.path === "/ai-tasks" && row.key === item.documentKey && row.at >= item.focusAt! && row.at <= window.end);
    const doc = nextDocuments[0];
    if (oldSessions.length !== 1 || oldSessions[0] !== item.oldAuthority || newSessions.length !== 1 || newSessions[0] !== item.newAuthority || oldDocuments.length !== 1 || nextDocuments.length !== 1
      || !doc || doc.ordinal !== item.documentOrdinal || doc.generation !== item.newGeneration || doc.status !== 200 || !doc.finished || doc.failed || doc.terminalAt === null || doc.terminalAt > window.end
      || !sessions.some(session => session.generation === item.newGeneration && session.hash === item.newAuthority && session.at >= doc.terminalAt! && session.at <= window.end)) return null;
    return doc;
  }
  function allowWrite(path: string, body: unknown, status: number, loss = false) { const value: typeof writes[number] = { path, bodyHash: hashValue(body), status, loss, committed: false }; writes.push(value); return value; }
  function check() {
    const acceptedPosts = new Set<Request>();
    // Establish this existing EOF category first so a later completed original
    // GET can serve as replacement evidence without rewriting raw finished.
    for (const row of rows) {
      const identities = [...new Set(sessions.filter(session => session.generation === row.generation).map(session => session.hash))], audit = pair(row);
      if (row.erp && row.method === "GET" && row.aborted && row.status === 200 && identities.length === 1 && row.authority === identities[0] && row.echo === identities[0] && read(new URL(row.request.url())) && complete(audit)) {
        row.classification = "original_read_eof_before_terminal_abort"; row.pair = audit.document + ":" + audit.sequence;
      }
    }
    for (const row of rows) {
      const known = [...new Set(sessions.filter(session => session.generation === row.generation).map(session => session.hash))], personal = known.length === 1 ? known[0] : null;
      const documents = rows.filter(doc => doc.document && doc.erp && doc.generation === row.generation && doc.finished && doc.status === 200 && doc.terminalAt !== null && doc.terminalAt <= row.at);
      const windows = controls.filter(control => control.start <= row.at && control.end >= (row.terminalAt ?? Infinity) && row.generation >= control.firstGeneration && row.generation <= control.lastGeneration), audit = pair(row), timing = row.request.timing();
      const mounted = mountPosts.find(post => post.path === row.path && hashValue(post.body) === row.bodyHash);
      if (row.erp && row.method === "POST" && mounted && personal && row.authority === personal && row.echo === personal && row.status === 200 && row.mime === "application/json" && documents.length === 1 && windows.length === 1 && complete(audit)) {
        const shown = dom.filter(value => value.generation === row.generation && value.authority === personal && value.at >= (row.terminalAt ?? Infinity) && value.at <= windows[0]!.end);
        const definitions = shown.map(value => mounted.kind === "tool_definition" ? value.tool : value.resource).filter(value => value !== null);
        if (definitions.length && new Set(definitions).size === 1 && (mounted.kind !== "research_candidates" || shown.some(value => value.candidates))) { acceptedPosts.add(row.request); row.pair = audit.document + ":" + audit.sequence; }
      }
      const write = writes.filter(value => value.path === row.path && value.bodyHash === row.bodyHash);
      if (row.erp && row.method === "POST" && write.length === 1 && rows.filter(other => other.erp && other.method === "POST" && other.path === row.path && other.bodyHash === row.bodyHash).length === 1
        && row.authority && personal === row.authority && (row.finished && row.status === write[0]!.status || write[0]!.loss && write[0]!.committed && write[0]!.request === row.request && row.failed)) {
        acceptedPosts.add(row.request); if (row.failed) row.classification = "explicit_actual_committed_original_response_loss";
      }
      if (!row.failed) continue;
      if (row.erp && row.method === "GET" && row.aborted && row.status === 200 && personal && row.authority === personal && row.echo === personal && read(new URL(row.request.url())) && complete(audit)) { row.classification = "original_read_eof_before_terminal_abort"; row.pair = audit.document + ":" + audit.sequence; continue; }
      const replacementTransition = windows.length === 1 ? authorityTransitions.find(item => item.newGeneration === row.generation && item.newAuthority === personal && transitionDocument(item, windows[0]!) !== null) : undefined;
      if (row.erp && row.method === "GET" && row.aborted && row.status === null && row.authority === personal && personal && documents.length === 1 && windows.length === 1
        && (["personal_login", "reload_original_unknown"].includes(windows[0]!.name) || replacementTransition) && zeroTiming(row)) {
        const url = new URL(row.request.url()), matched = /^\/api\/agent-(runtime-)?readiness\/(loop|plan|native_v1|native_v2|native_v3)$/.exec(url.pathname), old = pair(row, true);
        const workspace = matched ? { loop: "/api/agent-loops/workspace", plan: "/api/agent-plans/workspace", native_v1: "/api/agent-native/workspace", native_v2: "/api/agent-native-v2/workspace", native_v3: "/api/agent-native-v3/workspace" }[matched[2] as (typeof families)[number]] : null;
        const basis = rows.filter(value => value.erp && value.generation === row.generation && value.path === workspace && value.method === "GET" && value.finished && value.status === 200 && value.authority === personal && value.echo === personal && value.at <= row.at && value.terminalAt !== null && value.terminalAt >= (row.terminalAt ?? Infinity) && value.terminalAt <= windows[0]!.end);
        const next = rows.filter(value => value !== row && value.erp && value.generation === row.generation && value.key === row.key && value.method === "GET"
          && (value.finished || value.classification === "original_read_eof_before_terminal_abort") && value.status === 200 && value.authority === personal && value.echo === personal
          && value.at >= (row.terminalAt ?? Infinity) && value.terminalAt !== null && value.terminalAt <= windows[0]!.end && complete(pair(value)));
        if (matched && !url.search && old && old.fetchError === "AbortError" && old.abortAt !== null && old.fetchErrorAt !== null && old.abortAt <= old.fetchErrorAt && old.bytes === 0 && old.reads === 0 && !old.eof && !old.cancel && !old.bodyError && basis.length === 1 && next.length === 1 && basis[0]!.terminalAt! <= next[0]!.at) {
          row.classification = "initial_read_replaced_after_original_workspace"; row.pair = old.document + ":" + old.sequence;
          if (replacementTransition) { const successor = pair(next[0]!); if (successor) transitionPairs.push({ kind: "new_document_initial_replacement", ordinal: row.ordinal, audit: row.pair, successor: next[0]!.ordinal, successorAudit: successor.document + ":" + successor.sequence, documentOrdinal: replacementTransition.documentOrdinal! }); }
          continue;
        }
      }
      if (row.erp && row.method === "GET" && row.resource === "fetch" && row.aborted && row.status === null && row.authority && row.echo === null && row.bodyHash === null && !row.prefetch && !row.rsc
        && windows.length === 1 && windows[0]!.name === "withdraw_actual_permission" && zeroTiming(row)) {
        const item = authorityTransitions.find(item => item.oldGeneration === row.generation && item.oldAuthority === row.authority), doc = item ? transitionDocument(item, windows[0]!) : null;
        const old = pair(row, true), url = new URL(row.request.url());
        const exactTarget = !!item && (!url.search && ["/api/agent-native-v3/workspace", "/api/agent-runtime-readiness/loop", "/api/agent-runtime-readiness/plan", item.planPath].includes(row.path)
          || row.path === "/api/ai-assists/task-workspace" && url.search === "?page=1");
        if (item && doc && exactTarget && item.focusAt !== null && row.at >= item.focusAt && row.at <= doc.at && row.terminalAt !== null && row.terminalAt >= doc.at && row.terminalAt <= doc.terminalAt!
          && old && old.start >= item.focusAt && old.status === null && old.abortAt !== null && old.abortAt >= item.focusAt && old.fetchError === "AbortError" && old.fetchErrorAt !== null && old.abortAt <= old.fetchErrorAt && old.fetchErrorAt <= row.terminalAt
          && !old.eof && old.bytes === 0 && old.reads === 0 && !old.cancel && !old.bodyError) {
          const next = rows.filter(value => value.erp && value.method === "GET" && value.generation === item.newGeneration && value.key === row.key && value.authority === item.newAuthority && value.echo === item.newAuthority && value.status === 200
            && (value.finished || value.classification === "original_read_eof_before_terminal_abort") && value.at >= doc.terminalAt! && value.terminalAt !== null && value.terminalAt <= windows[0]!.end && complete(pair(value)));
          if (next.length === 1 && (row.path !== item.planPath || item.privateAvailable === false && item.freshPlanOrdinal === next[0]!.ordinal)) {
            const successor = pair(next[0]!); if (successor) { row.classification = "original_read_aborted_by_explicit_authority_document_replacement"; row.pair = old.document + ":" + old.sequence;
              transitionPairs.push({ kind: "old_document_abort", ordinal: row.ordinal, audit: row.pair, successor: next[0]!.ordinal, successorAudit: successor.document + ":" + successor.sequence, documentOrdinal: doc.ordinal }); continue; }
          }
        }
      }
      if (row.erp && row.method === "GET" && row.aborted && row.status === 200 && row.resource === "fetch" && row.prefetch && row.rsc && row.mime === "text/x-component" && !row.authority && !row.echo
        && personal && documents.length === 1 && windows.length === 1 && timing.startTime > 0 && timing.responseStart >= 0 && timing.responseEnd >= timing.responseStart
        && links.some(link => link.generation === row.generation && link.path === row.path && link.key === row.key && link.at >= windows[0]!.start && link.at <= windows[0]!.end)) row.classification = "literal_dom_rsc_prefetch_cancel_without_eof_claim";
      if (row.erp && row.method === "GET" && row.path === "/ai-tasks" && row.aborted && row.status === 200 && row.resource === "fetch" && !row.prefetch && row.rsc && row.mime === "text/x-component" && !row.authority && !row.echo
        && personal && documents.length === 1 && windows.length === 1 && ["first_original_confirmation", "second_original_confirmation"].includes(windows[0]!.name)
        && timing.startTime > 0 && timing.responseStart >= 0 && timing.responseEnd >= timing.responseStart
        && clicked.filter(value => value.generation === row.generation && value.authority === personal && value.key === row.key && value.at >= windows[0]!.start && value.at <= row.at && value.arrivedAt > value.at && value.arrivedAt <= windows[0]!.end).length === 1)
        row.classification = "actual_original_link_navigation_cancel_without_eof_claim";
      const ownHeld = held.get(row.request);
      if (ownHeld && row.method === "GET" && row.path === ownHeld.path && row.authority === ownHeld.oldAuthority && ownHeld.newAuthority && ownHeld.newAuthority !== ownHeld.oldAuthority && ownHeld.fetched && ownHeld.released && row.failed
        && controls.some(control => control.name === "withdraw_actual_permission" && row.at >= control.start && row.terminalAt !== null && row.terminalAt <= control.end)
        && sessions.some(session => session.hash === ownHeld.newAuthority && session.generation > row.generation)) row.classification = "explicit_held_original_200_discarded_after_actual_membership_change";
    }
    const safe = (selected: Row[]) => selected.map(({ request, ...row }) => { void request; return row; });
    expect(safe(rows.filter(row => row.status !== null && row.status >= 400)), "Unexpected HTTP errors remain failures").toEqual([]);
    expect(safe(rows.filter(row => (row.failed || !row.finished) && !row.classification)), "Unknown cancellations remain failures").toEqual([]);
    expect(safe(rows.filter(row => row.erp && row.method === "POST" && !acceptedPosts.has(row.request))), "Unknown or paid POSTs remain failures").toEqual([]);
    expect(errors.filter(error => !(error.kind === "console" && error.path && error.network && rows.filter(row => row.classification === "explicit_actual_committed_original_response_loss"
      && row.path === error.path && row.failure === error.network && row.terminalAt !== null && Math.abs(error.at - row.terminalAt) <= 2000).length === 1)), "All unknown page and console errors remain failures").toEqual([]);
  }
  return { control, current, sampleLinks, stable, check, allowWrite, held, rows, clickOriginal, beginAuthorityTransition, observeTransitionDocument, observeFreshPlan, proof: () => ({ requests: rows.map(({ request, ...row }) => ({ ...row, timing: request.timing() })), audits: [...audits.values()], controls, sessions, links, clicked, dom, errors, authorityTransitions, transitionPairs,
    held: [...held].map(([request, value]) => ({ ordinal: rows.find(row => row.request === request)?.ordinal, ...value })), writes: writes.map(({ request, ...value }) => ({ ...value, ordinal: rows.find(row => row.request === request)?.ordinal ?? null })) }) };
}

async function markers(page: Page) { return (await page.evaluate(prefix => Object.keys(sessionStorage).filter(key => key.startsWith(prefix)).map(key => sessionStorage.getItem(key)), prefix)).map(value => AgentDependencyPlanIntentSchema.parse(JSON.parse(value!))); }
async function beginPlan(page: Page, parentId: string) {
  const section = page.getByRole("region", { name: "跨域依赖计划", exact: true });
  await section.locator("summary").filter({ hasText: /^登记采购发票到财务账单计划$/ }).click();
  const form = section.getByRole("form", { name: "登记跨域依赖计划", exact: true }), choice = form.getByRole("combobox", { name: "真实前置采购发票原命令", exact: true });
  await expect(choice).toBeEnabled(); await expect(choice.locator(`option[value="${parentId}"]`)).toHaveCount(1); await choice.selectOption(parentId);
  await expect(form.getByRole("region", { name: "已选前置原命令", exact: true })).toContainText(parentId);
  await expect(form.getByRole("combobox", { name: "后继账单到期时间", exact: true })).toHaveValue("none");
  await form.getByRole("checkbox", { name: "已核对真实前置命令及到期时间 只登记协调计划 不执行业务", exact: true }).check(); return form;
}
async function confirmOriginal(page: Page, seen: Awaited<ReturnType<typeof observe>>, value: z.infer<typeof AgentCommandViewSchema>) {
  const sessionResponse = await page.request.get("/api/erp-auth/session"); expect(sessionResponse.status()).toBe(200);
  const session = ErpSessionViewSchema.parse(await sessionResponse.json()); expect(session.userId).toBe(actors().operator.userId); expect(session.tenantId).toBe(actors().operator.tenantId);
  const authority = erpSessionAuthority(session), actualResponse = await page.request.get("/api/agent-commands/requests/" + value.id, { headers: { "x-yummyai-context-authority": authority } });
  expect(actualResponse.status()).toBe(200); expect(sha(actualResponse.headers()["x-yummyai-context-authority"] ?? "")).toBe(sha(authority));
  const actual = AgentCommandViewSchema.parse(await actualResponse.json()); expect(actual.id).toBe(value.id); expect(sha(actual.contextAuthority)).toBe(sha(authority));
  await expect(original(page).getByRole("region", { name: "完整原业务填写核对", exact: true })).toBeVisible();
  await expect(page.getByRole("dialog", { name: "核对 Agent 原操作", exact: true }).getByRole("button", { name: "确认执行这笔原操作", exact: true })).toBeDisabled();
  await original(page).getByRole("checkbox", { name: /^我已核对这笔原目标/ }).check();
  const request = page.waitForRequest(request => new URL(request.url()).pathname === `/api/agent-commands/requests/${actual.id}/confirm` && request.method() === "POST");
  const response = page.waitForResponse(response => new URL(response.url()).pathname === `/api/agent-commands/requests/${actual.id}/confirm` && response.request().method() === "POST");
  const click = page.getByRole("dialog", { name: "核对 Agent 原操作", exact: true }).getByRole("button", { name: "确认执行这笔原操作", exact: true }).click();
  const sent = await request, input = ConfirmAgentCommandSchema.parse(sent.postDataJSON());
  expect(input).toMatchObject({ version: AGENT_COMMAND_VERSION, requestId: actual.requestId, ownerCommandId: actual.ownerCommandId, originalChecksum: actual.originalChecksum, decision: "execute_original" });
  expect(input.confirmationToken.length).toBeGreaterThan(0); seen.allowWrite(`/api/agent-commands/requests/${actual.id}/confirm`, input, 200); await click;
  const returned = await response; expect(returned.status()).toBe(200); const result = AgentCommandViewSchema.parse(await returned.json()); expect(result.state).toBe("succeeded"); expect(result.ownerCommandId).toBe(actual.ownerCommandId); return result;
}
async function capture(page: Page, info: TestInfo, name: string) {
  await detail(page).scrollIntoViewIfNeeded();
  const states: unknown[] = [];
  for (const width of [1440, 390]) {
    await page.setViewportSize({ width, height: width === 390 ? 844 : 960 });
    await expect.poll(() => detail(page).evaluate(element => {
      const root = element.closest('[role="dialog"]') ?? element, visible = [root, element, ...element.querySelectorAll(".adp-steps,.adp-source,.adp-actions,[role=status]")].filter(node => node.getClientRects().length > 0), active = (animation: Animation) => animation.pending || animation.playState === "running";
      return visible.every(node => Number(getComputedStyle(node).opacity) === 1) && root.getAnimations({ subtree: true }).every(animation => !active(animation)) && document.getAnimations().every(animation => {
        const effect = animation.effect, pseudo = effect && "pseudoElement" in effect ? effect.pseudoElement : null; return !(typeof pseudo === "string" && pseudo.startsWith("::view-transition") && active(animation));
      });
    }), { timeout: 7_000, message: "Real dependency drawer and ViewTransition animations must settle" }).toBe(true);
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1)).toBe(true);
    expect(await detail(page).evaluate(element => element.scrollWidth <= element.clientWidth + 1)).toBe(true);
    await page.screenshot({ path: info.outputPath(`${name}-${width}.png`) }); states.push({ width, animationsActuallySettled: true, horizontalOverflow: false });
  }
  return states;
}
async function leaf(page: Page, info: TestInfo, action: (f: Awaited<ReturnType<typeof browserFixture>>, seen: Awaited<ReturnType<typeof observe>>, evidence: Record<string, unknown>) => Promise<void>) {
  const seen = await observe(page), failures: unknown[] = [], evidence: Record<string, unknown> = { operation: "3f7c2a91", nonce: isolated.nonce, modelCalls: 0, providerCalls: 0, workerProcesses: 0, queueDispatches: 0,
    syntheticAdmission: "real_original_http_receiving_and_invoice_inputs_only", immutableHistoryCleanup: "retained_only_until_outer_disposable_database_teardown" };
  let fixture: Awaited<ReturnType<typeof browserFixture>> | undefined, primaryFailure = false, networkFailed = false, cleanupFailed = false;
  try { fixture = await browserFixture(); await action(fixture, seen, evidence); } catch (error) { primaryFailure = true; failures.push(error); }
  try { await seen.current(); await seen.stable(); seen.check(); } catch (error) { networkFailed = true; failures.push(error); }
  try { await fixture?.close(); } catch (error) { cleanupFailed = true; failures.push(error); }
  const path = info.outputPath("agent-dependency-plan-proof.json"); await writeFile(path, JSON.stringify({ ...evidence, primaryFailure, networkFailed, cleanupFailed, network: seen.proof() }, null, 2));
  await info.attach("agent-dependency-plan-proof", { path, contentType: "application/json" });
  if (failures.length) throw new AggregateError(failures, "dependency_personal_browser_failed");
}

test("personal_dependency_positive needs the real invoice and two separate original confirmations at 1440 and 390", async ({ page }, info) => {
  await leaf(page, info, async (f, seen, evidence) => {
    const source = await f.seed(), before = await f.state();
    await seen.control("personal_login", () => loginErp(page, "operator", "/ai-tasks"));
    let waiting!: z.infer<typeof AgentDependencyPlanViewSchema>;
    await seen.control("register_waiting_dependency", async () => {
      const form = await beginPlan(page, source.parent.id), response = page.waitForResponse(response => new URL(response.url()).pathname === "/api/agent-dependency-plans/requests" && response.request().method() === "POST");
      const request = page.waitForRequest(request => new URL(request.url()).pathname === "/api/agent-dependency-plans/requests" && request.method() === "POST");
      const click = form.getByRole("button", { name: "登记两步协调计划", exact: true }).click(); const sent = await request, input = CreateAgentDependencyPlanSchema.parse(sent.postDataJSON());
      expect(input).toMatchObject({ version: AGENT_DEPENDENCY_PLAN_VERSION, parentAgentCommandId: source.parent.id, kind: "procurement_invoice_to_finance_bill", dueAt: null });
      seen.allowWrite("/api/agent-dependency-plans/requests", input, 201); await click;
      const returned = await response; expect(returned.status()).toBe(201); waiting = AgentDependencyPlanViewSchema.parse(await returned.json());
      expect(waiting.state).toBe("waiting_predecessor"); expect(waiting.source).toBeNull(); expect(waiting.childAgentCommandId).toBeNull();
      await expect(detail(page)).toContainText("等待采购原操作完成"); expect(await f.state()).toEqual(before);
    });
    let parent!: z.infer<typeof AgentCommandViewSchema>;
    await seen.control("first_original_confirmation", async () => {
      const link = detail(page).getByRole("link", { name: "核对前置原采购操作", exact: true }); const href = await link.getAttribute("href"); if (!href) throw new Error("dependency_original_link_missing");
      const target = new URL(href, page.url()); expect(target.searchParams.get("agentCommand")).toBe(source.parent.id); expect(target.searchParams.get("agentDependencyPlan")).toBe(waiting.id);
      await seen.clickOriginal(link, source.parent.id, waiting.id); await expect(original(page)).toContainText(source.marker); parent = await confirmOriginal(page, seen, source.parent);
      const actualInvoice = parent.snapshot?.native;
      if (!actualInvoice || actualInvoice.domain !== "procurement" || actualInvoice.view.kind !== "invoice_record" || !actualInvoice.view.invoiceResult)
        throw new Error("dependency_browser_actual_invoice_result_missing");
      expect(actualInvoice.view.result?.id).toBe(actualInvoice.view.invoiceResult.id); await page.getByRole("dialog", { name: "核对 Agent 原操作", exact: true }).getByRole("button", { name: "关闭操作核对", exact: true }).click();
      await detail(page).getByRole("button", { name: "只重新读取原计划", exact: true }).click(); await expect(detail(page).getByRole("region", { name: "真实采购发票来源", exact: true })).toContainText(source.marker);
    });
    const afterParent = await f.state(); expect(afterParent.inventory_supplier_invoices!.count).toBe(before.inventory_supplier_invoices!.count + 1); expect(afterParent.finance_payable_bills).toEqual(before.finance_payable_bills);
    let prepared!: z.infer<typeof AgentDependencyPlanViewSchema>;
    await seen.control("explicit_child_preparation", async () => {
      await detail(page).getByRole("checkbox", { name: "已核对真实发票来源与固定账单草稿 只保存后继原准备 不执行业务", exact: true }).check();
      const path = `/api/agent-dependency-plans/requests/${waiting.id}/prepare`, request = page.waitForRequest(request => new URL(request.url()).pathname === path && request.method() === "POST"), response = page.waitForResponse(response => new URL(response.url()).pathname === path && response.request().method() === "POST");
      const click = detail(page).getByRole("button", { name: "保存后继财务原准备", exact: true }).click(); const sent = await request, input = PrepareAgentDependencyPlanSchema.parse(sent.postDataJSON());
      expect(input.requestId).toBe(waiting.requestId); seen.allowWrite(path, input, 201); await click;
      const returned = await response; expect(returned.status()).toBe(201); prepared = AgentDependencyPlanViewSchema.parse(await returned.json()); f.own(prepared.childAgentCommandId!);
      expect(prepared.source?.sourceChecksum).toBe(input.sourceChecksum);
      expect(prepared.child?.state).toBe("prepared"); expect(prepared.child?.resultId).toBeNull(); expect(await f.state()).toEqual(afterParent);
      await expect(detail(page)).toContainText("财务原命令已准备 尚须确认执行"); evidence.visuals = await capture(page, info, "dependency-prepared");
    });
    let child!: z.infer<typeof AgentCommandViewSchema>;
    await seen.control("second_original_confirmation", async () => {
      const link = detail(page).getByRole("link", { name: "核对后继原财务操作", exact: true }); const href = await link.getAttribute("href"); if (!href) throw new Error("dependency_child_link_missing");
      const target = new URL(href, page.url()); expect(target.searchParams.get("agentCommand")).toBe(prepared.childAgentCommandId); expect(target.searchParams.get("agentDependencyPlan")).toBe(waiting.id);
      await seen.clickOriginal(link, prepared.childAgentCommandId!, waiting.id); const actual = AgentCommandViewSchema.parse(await f.api("agent-commands/requests/" + prepared.childAgentCommandId));
      expect(actual.snapshot?.original).toMatchObject(prepared.childDraft!); child = await confirmOriginal(page, seen, actual);
      await page.getByRole("dialog", { name: "核对 Agent 原操作", exact: true }).getByRole("button", { name: "关闭操作核对", exact: true }).click();
      await detail(page).getByRole("button", { name: "只重新读取原计划", exact: true }).click(); await expect(detail(page)).toContainText("财务原账单实际已登记");
    });
    const after = await f.state(); expect(after.finance_payable_bills!.count).toBe(before.finance_payable_bills!.count + 1); expect(after.finance_original_write_proofs!.count).toBe(before.finance_original_write_proofs!.count + 1);
    for (const table of ["inventory_movements", "inventory_balances", "finance_payable_payments", "orders", "production_orders", "ai_budget_ledger", "ai_assist_runs", "agent_loop_runs"]) expect(after[table]).toEqual(before[table]);
    expect(after.inventory_supplier_invoices).toEqual(afterParent.inventory_supplier_invoices);
    const actualBill = child.snapshot?.native;
    if (!actualBill || actualBill.domain !== "finance" || actualBill.view.kind !== "bill_record" || actualBill.view.result?.kind !== "bill_record")
      throw new Error("dependency_browser_actual_finance_bill_result_missing");
    evidence.original = { planId: waiting.id, requestId: waiting.requestId, parentId: parent.id, parentOwnerId: parent.ownerCommandId, invoiceId: prepared.source!.invoiceId, childId: child.id, childOwnerId: child.ownerCommandId, billId: actualBill.view.result.id };
    evidence.twoExplicitOriginalConfirmations = true;
  });
});

test("personal_dependency_recovery uses GET after lost201 and removes a late private invoice after actual permission withdrawal at 1440 and 390", async ({ page }, info) => {
  await leaf(page, info, async (f, seen, evidence) => {
    const source = await f.seed(); await seen.control("personal_login", () => loginErp(page, "operator", "/ai-tasks"));
    let committed!: z.infer<typeof AgentDependencyPlanViewSchema>, lossSettled = false;
    const lose = async (route: Route) => {
      const request = route.request(), input = CreateAgentDependencyPlanSchema.parse(request.postDataJSON());
      expect(input).toMatchObject({ version: AGENT_DEPENDENCY_PLAN_VERSION, parentAgentCommandId: source.parent.id, kind: "procurement_invoice_to_finance_bill", dueAt: null });
      const expected = seen.allowWrite("/api/agent-dependency-plans/requests", input, 201, true); expected.request = request;
      try { const response = await route.fetch(); expect(response.status()).toBe(201); committed = AgentDependencyPlanViewSchema.parse(await response.json()); expected.committed = true; }
      finally { await route.abort("connectionreset"); lossSettled = true; }
    };
    await seen.control("lose_original_201", async () => {
      const form = await beginPlan(page, source.parent.id); await page.route("**/api/agent-dependency-plans/requests", lose);
      try { await form.getByRole("button", { name: "登记两步协调计划", exact: true }).click(); await expect.poll(() => lossSettled).toBe(true); }
      finally { await page.unroute("**/api/agent-dependency-plans/requests", lose); }
      const saved = await markers(page); expect(saved).toHaveLength(1); expect(saved[0]).toMatchObject({ requestId: committed.requestId, requestChecksum: committed.requestChecksum, planId: null, state: "unknown" }); expect(Object.keys(saved[0]!)).toHaveLength(7);
    });
    const committedState = await f.state();
    await seen.control("reload_original_unknown", async () => {
      await page.reload(); const intent = page.getByRole("article", { name: "原依赖计划请求 " + committed.requestId, exact: true }); await expect(intent).toBeVisible();
      await intent.getByRole("button", { name: "只读取原计划回执", exact: true }).click();
      const receipt = AgentDependencyPlanReceiptSchema.parse(await f.api("agent-dependency-plans/receipts?" + new URLSearchParams({ requestId: committed.requestId, requestChecksum: committed.requestChecksum })));
      expect(receipt).toMatchObject({ disposition: "known", id: committed.id });
      await page.getByRole("region", { name: "已找回的原依赖计划回执", exact: true }).getByRole("button", { name: "读取找回的原计划", exact: true }).click(); await expect(detail(page)).toContainText("等待采购原操作完成");
      expect(await f.state()).toEqual(committedState);
    });
    await seen.control("first_original_confirmation", async () => {
      await seen.clickOriginal(detail(page).getByRole("link", { name: "核对前置原采购操作", exact: true }), source.parent.id, committed.id); await confirmOriginal(page, seen, source.parent);
      await page.getByRole("dialog", { name: "核对 Agent 原操作", exact: true }).getByRole("button", { name: "关闭操作核对", exact: true }).click();
      await detail(page).getByRole("button", { name: "只重新读取原计划", exact: true }).click(); await expect(detail(page).getByRole("region", { name: "真实采购发票来源", exact: true })).toContainText(source.marker);
      evidence.visuals = await capture(page, info, "dependency-recovered");
    });
    const beforeWithdrawal = await f.state(), path = "/api/agent-dependency-plans/requests/" + committed.id;
    let release!: () => void, entered!: () => void; const held = new Promise<void>(done => { release = done; }), arrived = new Promise<void>(done => { entered = done; });
    let heldRequest: Request | undefined, lateSettled = false;
    const late = async (route: Route) => {
      const request = route.request(); if (request.method() !== "GET" || heldRequest) { await route.continue(); return; }
      heldRequest = request; const oldAuthority = request.headers()["x-yummyai-context-authority"]; if (!oldAuthority) throw new Error("dependency_old_read_authority_missing");
      const response = await route.fetch(); expect(response.status()).toBe(200); const actual = AgentDependencyPlanViewSchema.parse(await response.json()); expect(actual.source?.invoiceNumber).toBe(source.marker);
      const entry = { path, oldAuthority: sha(oldAuthority), newAuthority: null as string | null, fetched: true, released: false }; seen.held.set(request, entry); entered(); await held; entry.released = true;
      try { await route.fulfill({ response }); } finally { lateSettled = true; }
    };
    await seen.control("withdraw_actual_permission", async () => {
      const transition = seen.beginAuthorityTransition(committed.id);
      await page.route("**" + path, late);
      try {
        const click = detail(page).getByRole("button", { name: "只重新读取原计划", exact: true }).click(); await arrived; await click;
        await f.grant(f.originalPermissions.filter(bit => bit !== Permission.ProcurementRead));
        transition.mutationAt = Date.now();
        // Observe the existing new-document GET. This wait sends no request and
        // cannot use the held old response or a loading empty state as proof.
        const freshPlanResponse = page.waitForResponse(response => {
          const request = response.request(), row = seen.rows.find(row => row.request === request), header = request.headers()["x-yummyai-context-authority"];
          return request.method() === "GET" && new URL(request.url()).pathname === path && !new URL(request.url()).search && !!row && row.generation > transition.oldGeneration && !!header && sha(header) !== transition.oldAuthority;
        });
        void freshPlanResponse.catch(() => {});
        const nextDocument = page.waitForEvent("requestfinished", { predicate: request => request.isNavigationRequest() && request.resourceType() === "document" && request.frame() === page.mainFrame() && new URL(request.url()).pathname === "/ai-tasks" });
        transition.focusAt = await page.evaluate(() => { const at = Date.now(); window.dispatchEvent(new Event("focus")); return at; });
        const actualDocument = await nextDocument; await page.waitForLoadState("domcontentloaded");
        const fresh = await seen.current(); const entry = heldRequest && seen.held.get(heldRequest); if (!entry) throw new Error("dependency_original_hold_missing"); entry.newAuthority = fresh; expect(fresh).not.toBe(entry.oldAuthority);
        seen.observeTransitionDocument(transition, actualDocument, fresh);
        const response = await freshPlanResponse; expect(response.status()).toBe(200); expect(sha(response.headers()["x-yummyai-context-authority"] ?? "")).toBe(fresh);
        const denied = AgentDependencyPlanViewSchema.parse(await response.json());
        expect(denied.id).toBe(committed.id); expect(sha(denied.contextAuthority)).toBe(fresh); expect(denied.privateAvailable).toBe(false); expect(denied.source).toBeNull(); expect(denied.childDraft).toBeNull();
        await seen.observeFreshPlan(transition, response.request()); await expect(detail(page)).toHaveAttribute("aria-busy", "false");
        await seen.sampleLinks();
        await expect(detail(page).getByRole("region", { name: "真实采购发票来源", exact: true })).toHaveCount(0);
        await expect(detail(page).getByRole("checkbox", { name: "已核对真实发票来源与固定账单草稿 只保存后继原准备 不执行业务", exact: true })).toHaveCount(0);
        await page.getByRole("dialog", { name: "核对跨域依赖计划", exact: true }).getByRole("button", { name: "关闭依赖计划核对", exact: true }).click();
        transition.closedAt = Date.now();
        await expect(detail(page)).toHaveCount(0); expect(new URL(page.url()).searchParams.has("agentDependencyPlan")).toBe(false);
        release(); await expect.poll(() => lateSettled).toBe(true); await expect(detail(page)).toHaveCount(0);
        expect(new URL(page.url()).searchParams.has("agentDependencyPlan")).toBe(false);
        await expect(page.getByRole("region", { name: "跨域依赖计划", exact: true }).filter({ hasText: source.marker })).toHaveCount(0);
        expect(await f.state()).toEqual(beforeWithdrawal);
      } finally { release(); await page.unroute("**" + path, late); }
    });
    expect(seen.rows.filter(row => row.method === "POST" && row.path === "/api/agent-dependency-plans/requests")).toHaveLength(1);
    expect(seen.rows.filter(row => row.method === "POST" && /\/agent-dependency-plans\/requests\/[a-f0-9-]+\/prepare$/.test(row.path))).toHaveLength(0);
    evidence.original = { planId: committed.id, requestId: committed.requestId, requestChecksum: committed.requestChecksum, parentId: committed.parentAgentCommandId };
    evidence.lost201AfterRealCommit = true; evidence.recoveryWasOnlyGet = true; evidence.sameOriginalPlanAfterRemount = true; evidence.latePrivateSourceDiscarded = true; evidence.deniedDrawerClosedBeforeLateResponseAndNotReopened = true;
  });
});
