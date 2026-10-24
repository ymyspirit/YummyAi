import { expect, test, type Page, type Request, type TestInfo } from "@playwright/test";
import { createHash } from "node:crypto";
import { readFile, writeFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { z } from "zod";
import { ErpSessionViewSchema, erpSessionAuthority } from "@yummyai/contracts/auth/session";
import { StoreNodeEnrollmentCreatedSchema, StoreNodeEnrollmentBundleSchema, StoreNodeWorkspaceSchema } from "@yummyai/contracts/marketplace/store-node";
import { StoreNodeExecutionWorkspaceSchema, StoreNodeExecutionViewSchema, StoreNodeExecutionReceiptSchema, CreateStoreNodeExecutionInputSchema,
  type StoreNodeExecutionView } from "@yummyai/contracts/marketplace/store-node-execution";
import { requireStoreNodeExecutionEnvironment } from "../../../tools/testing/require-store-node-execution-environment.mjs";
import { loginErp, actors } from "./erp-identity-fixture";

const { nonce } = requireStoreNodeExecutionEnvironment(process.env, "current", true), sha = (value: string) => createHash("sha256").update(value).digest("hex");
const Id = z.uuidv7(), Digest = z.string().regex(/^[a-f0-9]{64}$/);
const Seed = z.object({ groupId: Id, ids: z.tuple([Id, Id]), actorId: Id, tenantId: Id }).strict();
const Key = z.object({ keyId: Id, publicKeyPem: z.string().startsWith("-----BEGIN PUBLIC KEY-----\n") }).strict();
const Snapshot = z.object({ business: z.object({ paid: z.int(), publications: z.int(), listingSyncs: z.int() }).strict(),
  accounts: z.array(z.object({ id: Id, status: z.string(), credentialVersion: z.int(), refreshState: z.string(), snapshots: z.array(z.object({ id: Id, version: z.int(), sourceChecksum: z.string() }).strict()), originalRowsSha: Digest }).strict()),
  counts: z.record(z.string(), z.int()), children: z.array(z.object({ command: z.string(), exited: z.boolean(), leaked: z.boolean() }).passthrough()) }).strict();
type Source = z.infer<typeof Seed>;
async function control(input: Record<string, unknown>) {
  const path = fileURLToPath(new URL(`../../../tmp/store-node-execution-20261022-e6f2c8a1/qa/browser-control-${nonce}.json`, import.meta.url));
  const data = z.object({ nonce: z.literal(nonce), pid: z.int().positive(), origin: z.url(), key: z.string().regex(/^[A-Za-z0-9_-]{43}$/) }).strict().parse(JSON.parse(await readFile(path, "utf8")));
  const url = new URL(data.origin); if (url.protocol !== "http:" || url.hostname !== "127.0.0.1" || url.pathname !== "/" || url.search || url.hash || url.username || url.password) throw new Error("store_node_execution_control_origin_invalid");
  const response = await fetch(url, { method: "POST", headers: { "content-type": "application/json", "x-fixture-control": data.key }, body: JSON.stringify(input), redirect: "error", signal: AbortSignal.timeout(60_000) });
  if (response.status !== 200) { await response.body?.cancel(); throw new Error("store_node_execution_control_rejected"); } return await response.json() as unknown;
}
const snapshot = async (source: Source) => Snapshot.parse(await control({ operation: "snapshot", groupId: source.groupId }));
const nodePanel = (page: Page) => page.getByRole("region", { name: "本店独立节点", exact: true });
const panel = (page: Page) => page.getByRole("region", { name: "绑定节点能力同步", exact: true });
const task = (page: Page) => panel(page).getByRole("region", { name: "原节点同步任务详情", exact: true });
async function session(page: Page) { const response = await page.request.get("/api/erp-auth/session"); expect(response.status()).toBe(200);
  const value = ErpSessionViewSchema.parse(await response.json()); expect(value.userId).toBe(actors().operator.userId); expect(value.tenantId).toBe(actors().operator.tenantId);
  return { value, authority: erpSessionAuthority(value), hash: sha(erpSessionAuthority(value)) }; }

const Audit = z.object({ doc: z.string().regex(/^[a-f0-9-]{36}$/), seq: z.int().positive(), path: z.string().regex(/^\/api\/[a-z0-9/-]+$/), started: z.number().positive(),
  authority: Digest.nullable(), responseAuthority: Digest.nullable(), status: z.int().min(100).max(599).optional(), eofAt: z.number().positive().optional(),
  bytes: z.int().nonnegative(), reads: z.int().nonnegative(), abortSeenAtEof: z.boolean().optional(), cancelSeenAtEof: z.boolean().optional(), signalAbortAt: z.number().positive().optional(),
  cancelled: z.boolean(), error: z.boolean() }).strict();
type AuditRow = z.infer<typeof Audit>;
/** Observes only reads the real application already performs. No extra read, clone, tee, response replacement or signal change. */
async function observe(page: Page, source: Source) {
  const allowed = new Set(source.ids.flatMap(id => [`/api/marketplace-accounts/${id}/authority`, `/api/marketplace-accounts/${id}/nodes`, `/api/marketplace-accounts/${id}/node-executions`]));
  const eligiblePath = (path: string) => allowed.has(path) || source.ids.some(id => new RegExp(`^/api/marketplace-accounts/${id}/node-executions/[a-f0-9-]{36}$`).test(path));
  const audit = new Map<string, AuditRow>();
  await page.exposeBinding("__storeNodeExecutionReadAudit", ({ frame }, raw: unknown) => { if (frame !== page.mainFrame()) return;
    const value = Audit.safeParse(raw); if (!value.success || !eligiblePath(value.data.path) || audit.size >= 250 && !audit.has(value.data.doc + ":" + value.data.seq)) return;
    audit.set(value.data.doc + ":" + value.data.seq, value.data); });
  await page.addInitScript(({ accountIds }) => {
    const send = (value: object) => { const target = (window as unknown as { __storeNodeExecutionReadAudit?: (value: object) => Promise<unknown> }).__storeNodeExecutionReadAudit;
      try { void target?.(value).catch(() => {}); } catch { /* Passive diagnostics never alter application execution. */ } };
    const documentId = crypto.randomUUID(), original = globalThis.fetch; let seq = 0;
    globalThis.fetch = function (this: typeof globalThis, ...args: Parameters<typeof fetch>) {
      const input = args[0], init = args[1]; let url: URL;
      try { url = new URL(input instanceof Request ? input.url : String(input), location.href); } catch { return Reflect.apply(original, this, args); }
      const method = init?.method ?? (input instanceof Request ? input.method : "GET");
      const path = url.pathname, roots = accountIds.map(id => "/api/marketplace-accounts/" + id);
      const selected = method === "GET" && url.origin === location.origin && !url.search && roots.some(root => path === root + "/authority" || path === root + "/nodes" || path === root + "/node-executions" || new RegExp("^" + root + "/node-executions/[a-f0-9-]{36}$").test(path));
      if (!selected) return Reflect.apply(original, this, args);
      const headers = new Headers(init?.headers ?? (input instanceof Request ? input.headers : undefined)), signal = init?.signal ?? (input instanceof Request ? input.signal : undefined);
      const stamp = headers.get("x-yummyai-context-authority"), state: { doc: string; seq: number; path: string; started: number; authority: string | null; responseAuthority: string | null;
        status?: number; eofAt?: number; bytes: number; reads: number; abortSeenAtEof?: boolean; cancelSeenAtEof?: boolean; signalAbortAt?: number; cancelled: boolean; error: boolean } = {
          doc: documentId, seq: ++seq, path, started: Date.now(), authority: stamp && /^[a-f0-9]{64}$/.test(stamp) ? stamp : null, responseAuthority: null, bytes: 0, reads: 0, cancelled: false, error: false };
      const record = () => send({ ...state }), eof = () => { if (state.eofAt === undefined) { state.eofAt = Date.now(); state.abortSeenAtEof = state.signalAbortAt !== undefined; state.cancelSeenAtEof = state.cancelled; } record(); };
      if (signal?.aborted) state.signalAbortAt = Date.now();
      signal?.addEventListener("abort", () => { state.signalAbortAt ??= Date.now(); record(); }, { once: true }); record();
      const promise = Reflect.apply(original, this, args) as ReturnType<typeof fetch>;
      void promise.then(response => { state.status = response.status; const stamp = response.headers.get("x-yummyai-context-authority"); state.responseAuthority = stamp && /^[a-f0-9]{64}$/.test(stamp) ? stamp : null; record();
        if (response.body) { const body = response.body, getReader = body.getReader; body.getReader = function (this: ReadableStream<Uint8Array>, ...readerArgs: Parameters<typeof getReader>) {
          const reader = Reflect.apply(getReader, this, readerArgs) as ReadableStreamDefaultReader<Uint8Array>, read = reader.read, cancel = reader.cancel;
          reader.read = function (...readArgs: Parameters<typeof read>) { const result = Reflect.apply(read, this, readArgs) as ReturnType<typeof read>;
            void result.then(value => { state.reads++; if (value.done) eof(); else { state.bytes += value.value.byteLength; record(); } }, () => { state.error = true; record(); }); return result; };
          reader.cancel = function (...cancelArgs: Parameters<typeof cancel>) { state.cancelled = true; record(); return Reflect.apply(cancel, this, cancelArgs); }; return reader;
        } as typeof body.getReader; }
        const json = response.json; response.json = function (...jsonArgs: Parameters<typeof json>) { const result = Reflect.apply(json, this, jsonArgs) as ReturnType<typeof json>;
          void result.then(() => eof(), () => { state.error = true; record(); }); return result; };
      }, () => { state.error = true; record(); }); return promise;
    };
  }, { accountIds: source.ids });
  type Network = { request: Request; ordinal: number; method: string; path: string; queryEmpty: boolean; authority: string | null; responseAuthority: string | null;
    at: number; terminalAt: number | null; status: number | null; failed: string | null; terminal: boolean; generation: number; documentOrdinal: number | null; document: boolean; prefetch: boolean };
  const rows: Network[] = [], consoleErrors: Array<{ at: number; path: string | null; knownLossText: boolean; used: boolean }> = [], pageErrors: string[] = [], known = new Set<string>();
  const losses = new Map<Request, { id: string; requestId: string; status: 201; consumed: boolean; consoleConsumed: boolean }>();
  let ordinal = 0, generation = 0, documentOrdinal: number | null = null, held: Request | undefined;
  let change: { accountId: string; at: number; focusAt: number; end: number; old: string; current: string; document: Request } | null = null;
  page.on("request", request => { const url = new URL(request.url()); if (url.origin !== "http://localhost:3130") return;
    const document = request.isNavigationRequest() && request.resourceType() === "document" && request.frame() === page.mainFrame(), currentOrdinal = ++ordinal;
    if (document) { generation++; documentOrdinal = currentOrdinal; } const stamp = request.headers()["x-yummyai-context-authority"];
    rows.push({ request, ordinal: currentOrdinal, method: request.method(), path: url.pathname, queryEmpty: !url.search, authority: stamp && /^[a-f0-9]{64}$/.test(stamp) ? stamp : null,
      responseAuthority: null, at: Date.now(), terminalAt: null, status: null, failed: null, terminal: false, generation, documentOrdinal, document, prefetch: request.headers()["next-router-prefetch"] === "1" }); });
  page.on("response", response => { const row = rows.find(value => value.request === response.request()); if (row) { row.status = response.status(); const stamp = response.headers()["x-yummyai-context-authority"]; row.responseAuthority = stamp && /^[a-f0-9]{64}$/.test(stamp) ? stamp : null; } });
  page.on("requestfinished", request => { const row = rows.find(value => value.request === request); if (row) { row.terminal = true; row.terminalAt = Date.now(); } });
  page.on("requestfailed", request => { const row = rows.find(value => value.request === request); if (row) { row.terminal = true; row.terminalAt = Date.now(); row.failed = request.failure()?.errorText ?? "unknown"; } });
  page.on("console", message => { if (message.type() !== "error") return; let path: string | null = null; try { const url = new URL(message.location().url); if (url.origin === "http://localhost:3130" && !url.search) path = url.pathname; } catch { /* Remains an unknown error. */ }
    consoleErrors.push({ at: Date.now(), path, knownLossText: message.text() === "Failed to load resource: net::ERR_FAILED", used: false }); });
  page.on("pageerror", error => pageErrors.push(error.name));
  const safe = (row: Network) => ({ ordinal: row.ordinal, method: row.method, path: row.path, queryEmpty: row.queryEmpty, authority: row.authority, responseAuthority: row.responseAuthority,
    at: row.at, terminalAt: row.terminalAt, status: row.status, failed: row.failed, terminal: row.terminal, generation: row.generation, documentOrdinal: row.documentOrdinal, document: row.document, prefetch: row.prefetch, timing: row.request.timing() });
  const idle = async () => { await expect.poll(() => rows.filter(row => !row.terminal && row.request !== held).length, { timeout: 20_000 }).toBe(0); };
  const candidates = (row: Network) => { const start = row.request.timing().startTime;
    if (!Number.isFinite(start) || start <= 0 || row.method !== "GET" || !row.queryEmpty || !eligiblePath(row.path)) return [];
    return [...audit.values()].filter(value => value.path === row.path && value.authority === row.authority && Math.abs(value.started - start) <= 25 && (row.status === null ? value.status === undefined : value.status === row.status)); };
  const exactAudit = (row: Network) => { const matched = candidates(row);
    return matched.length === 1 && rows.filter(other => candidates(other).some(value => value.doc === matched[0]!.doc && value.seq === matched[0]!.seq)).length === 1 ? matched[0] : undefined; };
  const documentRow = (request: Request, accountId: string) => {
    const value = rows.find(row => row.request === request);
    if (!value || !value.document || value.method !== "GET" || !value.queryEmpty || value.path !== `/stores/${accountId}` || value.status !== 200 || !value.terminal || value.failed || !Number.isFinite(value.request.timing().responseEnd) || value.request.timing().responseEnd < 0)
      throw new Error("store_node_execution_focus_document_incomplete");
    return value;
  };
  const currentReads = (doc: Network, accountId: string, authority: string, end?: number) =>
    ["authority", "nodes", "node-executions"].map(kind => rows.filter(value => {
      if (value.method !== "GET" || !value.queryEmpty || value.path !== `/api/marketplace-accounts/${accountId}/${kind}` || value.generation !== doc.generation || value.documentOrdinal !== doc.ordinal ||
        value.status !== 200 || !value.terminal || value.failed || value.authority !== authority || value.responseAuthority !== authority || value.terminalAt === null || end !== undefined && value.terminalAt > end) return false;
      const actual = exactAudit(value);
      return actual !== undefined && actual.responseAuthority === authority && actual.eofAt !== undefined && actual.abortSeenAtEof === false && actual.cancelSeenAtEof === false &&
        actual.bytes > 0 && actual.reads > 0 && !actual.error && value.request.timing().responseEnd >= 0;
    }));
  let classification: object[] = [], unexpected: object[] = [];
  return { idle, known: (raw: string) => known.add(sha(raw)), hold: (request: Request) => { held = request; },
    loss: (request: Request, view: StoreNodeExecutionView) => { const value = StoreNodeExecutionViewSchema.parse(view); losses.set(request, { id: value.id, requestId: value.requestId, status: 201, consumed: false, consoleConsumed: false }); },
    async focusDocument(request: Request, accountId: string, authority: string) { expect(known.has(authority)).toBe(true); const doc = documentRow(request, accountId);
      await expect.poll(() => currentReads(doc, accountId, authority).every(values => values.length > 0), { timeout: 20_000 }).toBe(true);
      return { document: safe(doc), currentReads: currentReads(doc, accountId, authority).map(values => values.map(value => ({ request: safe(value), audit: exactAudit(value) }))) };
    },
    transition: (value: NonNullable<typeof change>) => { if (!known.has(sha(value.old)) || !known.has(sha(value.current)) || value.old === value.current || value.at > value.focusAt || value.focusAt > value.end) throw new Error("store_node_execution_transition_invalid");
      documentRow(value.document, value.accountId); change = value; },
    async check() { await idle(); unexpected = []; classification = [];
      for (const row of rows) {
        const loss = losses.get(row.request);
        if (loss && row.method === "POST" && row.queryEmpty && source.ids.some(id => row.path === `/api/marketplace-accounts/${id}/node-executions`) && row.failed === "net::ERR_FAILED") { loss.consumed = true; classification.push({ ordinal: row.ordinal, classification: "injected_original201_loss", id: loss.id, requestId: loss.requestId }); continue; }
        if (row.status !== null && row.status >= 400) unexpected.push({ ordinal: row.ordinal, kind: "http", status: row.status, path: row.path });
        if (!row.failed) continue;
        const exact = exactAudit(row);
        const timing = row.request.timing();
        const complete = row.failed === "net::ERR_ABORTED" && row.status === 200 && row.authority !== null && known.has(row.authority) && row.responseAuthority === row.authority &&
          exact && exact.responseAuthority === row.authority && exact.eofAt !== undefined && exact.abortSeenAtEof === false && !exact.error && !exact.cancelled &&
          (exact.bytes > 0 && exact.reads > 0 || exact.reads === 0) && timing.responseEnd >= 0;
        if (complete && exact) { classification.push({ ordinal: row.ordinal, classification: "completed_read_with_terminal_abort", path: row.path, audit: exact, nodeFailedAt: row.terminalAt,
          browserEofAt: exact.eofAt, observedClockDifference: exact.eofAt! - row.terminalAt! }); continue; }
        const prefetch = row.prefetch && row.method === "GET" && row.status === 200 && row.failed === "net::ERR_ABORTED" && ["/", "/navigation", "/stores", "/orders", "/listings"].includes(row.path);
        if (prefetch) { classification.push({ ordinal: row.ordinal, classification: "exact_next_prefetch_cancel", path: row.path }); continue; }
        const transition = change;
        if (transition && row.failed === "net::ERR_ABORTED" && row.method === "GET" && row.queryEmpty && row.authority === sha(transition.old)) {
          const paths = [`/api/marketplace-accounts/${transition.accountId}/authority`, `/api/marketplace-accounts/${transition.accountId}/nodes`, `/api/marketplace-accounts/${transition.accountId}/node-executions`];
          const docs = rows.filter(value => value.document && value.method === "GET" && value.path === `/stores/${transition.accountId}` && value.queryEmpty && value.at >= transition.focusAt && value.terminalAt !== null && value.terminalAt <= transition.end);
          const doc = docs.length === 1 && docs[0]!.request === transition.document ? docs[0] : undefined;
          const newReads = doc ? currentReads(doc, transition.accountId, sha(transition.current), transition.end) : [];
          const recovered = doc && doc.status === 200 && doc.terminal && !doc.failed && newReads.length === 3 && newReads.every(values => values.length > 0);
          const old = paths.includes(row.path) && row.at >= transition.focusAt && row.terminalAt !== null && row.terminalAt <= transition.end && row.status === null && row.responseAuthority === null;
          if (recovered && (old || row.request === held && row.at <= transition.at)) { classification.push({ ordinal: row.ordinal, classification: row.request === held ? "held_original_authority_read_cancel" : "old_authority_read_in_explicit_withdrawal", document: safe(doc), currentReads: newReads.map(values => values.map(value => value.ordinal)) }); continue; }
        }
        unexpected.push({ ordinal: row.ordinal, kind: "unknown_cancel", path: row.path, method: row.method, status: row.status });
      }
      for (const [request, loss] of losses) if (loss.consumed) { const row = rows.find(value => value.request === request)!;
        const matching = consoleErrors.filter(value => !value.used && value.knownLossText && value.path === row.path && value.at >= row.at); if (matching.length === 1) { matching[0]!.used = true; loss.consoleConsumed = true; } }
      expect(unexpected).toEqual([]); expect(consoleErrors.filter(value => !value.used)).toEqual([]); expect(pageErrors).toEqual([]);
      for (const loss of losses.values()) { expect(loss.consumed).toBe(true); expect(loss.consoleConsumed).toBe(true); }
      return { network: rows.map(safe), readAudit: [...audit.values()], classification, consoleErrors: consoleErrors.length, pageErrors: pageErrors.length, injectedLosses: losses.size };
    }, proof: () => ({ network: rows.slice(0, 1000).map(safe), networkCount: rows.length, networkTruncated: rows.length > 1000,
      readAudit: [...audit.values()], classification: classification.slice(0, 1000), unexpected: unexpected.slice(0, 1000),
      transition: change ? { accountId: change.accountId, at: change.at, focusAt: change.focusAt, end: change.end, old: sha(change.old), current: sha(change.current), documentOrdinal: rows.find(row => row.request === change!.document)?.ordinal ?? null } : null,
      consoleErrors: consoleErrors.length, consoleDiagnostics: consoleErrors.slice(0, 100), pageErrors: pageErrors.length }),
  };
}
type Observer = Awaited<ReturnType<typeof observe>>;
async function open(page: Page, source: Source, id: string, seen: Observer, first = false) {
  if (first) await loginErp(page, "operator", "/stores/" + id); else { await seen.idle(); await page.goto("/stores/" + id); }
  await expect(nodePanel(page)).toBeVisible(); await expect(panel(page)).toBeVisible(); const current = await session(page); seen.known(current.authority); await seen.idle();
  expect(current.value.userId).toBe(source.actorId); return current;
}
async function registration(page: Page, source: Source, accountId: string, seen: Observer) {
  const key = Key.parse(await control({ operation: "init", groupId: source.groupId }));
  await nodePanel(page).getByRole("button", { name: "准备节点登记", exact: true }).click(); const form = nodePanel(page).getByRole("form", { name: "创建节点登记票据" });
  await form.getByRole("textbox", { name: "节点名称", exact: true }).fill("Synthetic capability node " + key.keyId); await form.getByRole("textbox", { name: "节点公钥 PEM", exact: true }).fill(key.publicKeyPem);
  await form.getByRole("checkbox", { name: "已在节点主机保管私钥 本页只提交公开公钥", exact: true }).check();
  const prepared = page.waitForResponse(response => response.url() === `http://localhost:3130/api/marketplace-accounts/${accountId}/nodes/enrollments` && response.request().method() === "POST")
    .then(async response => ({ status: response.status(), body: await response.json() as unknown }));
  await form.getByRole("button", { name: "创建一次性登记票据", exact: true }).click(); const result = await prepared; expect(result.status).toBe(201);
  const created = StoreNodeEnrollmentCreatedSchema.parse(result.body); expect(created.enrollment.accountId).toBe(accountId);
  expect(StoreNodeEnrollmentBundleSchema.parse(JSON.parse(await nodePanel(page).getByRole("textbox", { name: "一次性节点登记包" }).inputValue()))).toEqual(created.enrollment);
  await control({ operation: "enroll", groupId: source.groupId, keyId: key.keyId, bundle: created.enrollment });
  await nodePanel(page).getByRole("button", { name: "清除此登记包", exact: true }).click(); await control({ operation: "run", groupId: source.groupId, keyId: key.keyId });
  await expect.poll(async () => { const fresh = await session(page); seen.known(fresh.authority); const response = await page.request.get(`/api/marketplace-accounts/${accountId}/nodes`, { headers: { "x-yummyai-context-authority": fresh.hash } });
    expect(response.status()).toBe(200); return StoreNodeWorkspaceSchema.parse(await response.json()).nodes.find(value => value.id === created.enrollment.nodeId)?.reachability; }, { timeout: 15_000 }).toBe("online");
  await nodePanel(page).getByRole("button", { name: "重新读取节点状态", exact: true }).click(); await expect(nodePanel(page)).toHaveAttribute("aria-busy", "false"); await seen.idle();
  await nodePanel(page).getByRole("combobox", { name: /^待绑定节点/ }).selectOption(created.enrollment.nodeId); await nodePanel(page).getByRole("button", { name: "核对节点绑定", exact: true }).click();
  const review = nodePanel(page).getByRole("region", { name: "核对节点变更", exact: true }); await review.getByRole("checkbox", { name: "已核对本店 原节点与本次变更", exact: true }).check();
  await review.getByRole("button", { name: "确认绑定节点", exact: true }).click(); await seen.idle();
  await panel(page).getByRole("button", { name: "重新读取执行状态", exact: true }).click(); await expect(panel(page)).toHaveAttribute("aria-busy", "false");
  await expect(panel(page).getByRole("definition").filter({ hasText: new RegExp("^" + created.enrollment.nodeId + "$") })).toBeVisible();
  return { key, nodeId: created.enrollment.nodeId };
}
async function draft(page: Page, platform: "etsy" | "amazon") {
  await panel(page).locator("summary").filter({ hasText: /^准备本店能力同步$/ }).click(); const form = panel(page).getByRole("form", { name: "节点能力同步填写" });
  await form.getByRole("textbox", { name: platform === "etsy" ? "Etsy Taxonomy IDs" : "Amazon Product Types", exact: true }).fill(platform === "etsy" ? "42,123" : "PILLOW");
  await form.getByRole("button", { name: "核对本次同步", exact: true }).click(); await panel(page).getByRole("checkbox", { name: "已核对本店 原绑定节点和本次能力范围", exact: true }).check();
}
async function submit(page: Page, id: string) {
  const response = page.waitForResponse(value => value.url() === `http://localhost:3130/api/marketplace-accounts/${id}/node-executions` && value.request().method() === "POST")
    .then(async value => ({ status: value.status(), body: await value.json() as unknown }));
  await panel(page).getByRole("button", { name: "保存并交绑定节点同步", exact: true }).click(); const saved = await response; expect(saved.status).toBe(201); return StoreNodeExecutionViewSchema.parse(saved.body);
}
async function completed(page: Page, accountId: string, id: string, seen: Observer) {
  let value!: StoreNodeExecutionView;
  await expect.poll(async () => { const current = await session(page); seen.known(current.authority); const response = await page.request.get(`/api/marketplace-accounts/${accountId}/node-executions/${id}`, { headers: { "x-yummyai-context-authority": current.hash } });
    expect(response.status()).toBe(200); expect(response.headers()["x-yummyai-context-authority"]).toBe(current.hash); value = StoreNodeExecutionViewSchema.parse(await response.json()); expect(value.id).toBe(id); return value.state; }, { timeout: 60_000 }).toBe("succeeded");
  await task(page).getByRole("button", { name: "重新读取原任务", exact: true }).click(); await expect(task(page).getByRole("heading", { name: "原能力快照已保存", exact: true })).toBeVisible();
  const original = task(page).getByRole("region", { name: "本任务原能力快照", exact: true }); await expect(original.getByRole("definition").filter({ hasText: new RegExp("^" + value.snapshotId + "$") })).toBeVisible(); await seen.idle(); return value;
}
async function screenshot(page: Page, info: TestInfo, name: string, target = panel(page)) {
  await target.scrollIntoViewIfNeeded(); await expect(target).toBeInViewport(); await expect.poll(async () => target.evaluate(element => {
    const visible = getComputedStyle(element).opacity === "1", running = element.getAnimations({ subtree: true }).some(animation => animation.playState === "running" && Number.isFinite(Number(animation.effect?.getComputedTiming().iterations)));
    return visible && !running; })).toBe(true);
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true); await page.screenshot({ path: info.outputPath(name + ".png"), fullPage: false });
}
function progress(proof: Record<string, unknown>, phase: string) {
  const values = (proof.progress ??= []) as Array<{ phase: string; at: number }>;
  if (values.length < 40) values.push({ phase, at: Date.now() }); proof.phase = phase;
}
function failureSummary(error: unknown, phase: string) {
  const names = ["Error", "TimeoutError", "AssertionError", "AggregateError", "ZodError", "TypeError", "SyntaxError"];
  const name = error instanceof Error && names.includes(error.name) ? error.name : "Error";
  const location = error instanceof Error ? /(?:^|[\\/])store-node-execution\.spec\.ts:(\d+):(\d+)/.exec(error.stack ?? "") : null;
  return { phase, name, location: location ? { file: "apps/web/e2e/store-node-execution.spec.ts", line: Number(location[1]), column: Number(location[2]) } : null };
}
async function attach(info: TestInfo, proof: object) {
  const path = info.outputPath("store-node-execution-proof.json");
  await writeFile(path, JSON.stringify(proof, null, 2) + "\n");
  await info.attach("store-node-execution-proof", { path, contentType: "application/json" });
}
async function finishEvidence(info: TestInfo, source: Source, seen: Observer, proof: Record<string, unknown>, primary?: { error: unknown }) {
  const failures: Array<{ phase: string; error: unknown }> = primary ? [{ phase: "body", error: primary.error }] : [];
  try { const checked = await seen.check(); proof.network = { checked: true, requests: checked.network.length,
    classified: checked.classification.length, consoleErrors: checked.consoleErrors, pageErrors: checked.pageErrors, injectedLosses: checked.injectedLosses }; }
  catch (error) { failures.push({ phase: "network", error }); }
  try { proof.observed = seen.proof(); } catch (error) { failures.push({ phase: "network_proof", error }); }
  try { proof.cleanup = await control({ operation: "close", groupId: source.groupId }); } catch (error) { failures.push({ phase: "cleanup", error }); }
  proof.failures = failures.map(value => failureSummary(value.error, value.phase));
  try { await attach(info, proof); } catch (error) { failures.push({ phase: "proof", error }); }
  for (const value of failures.slice(1)) info.annotations.push({ type: "secondary_failure", description: JSON.stringify(failureSummary(value.error, value.phase)) });
  if (failures.length) throw failures[0]!.error;
}

test.describe.configure({ mode: "serial" });
test("executes both original Etsy and Amazon capability owners on the actual enrolled CLI node and reads immutable results at1440and390", async ({ page }, info) => {
  const source = Seed.parse(await control({ operation: "seed" })), seen = await observe(page, source), proof: Record<string, unknown> = { operation: "e6f2c8a1", case: "personal_original_owners" };
  let primary: { error: unknown } | undefined;
  try { const before = await snapshot(source), completedIds: string[] = [];
    for (const [index, platform] of ["etsy", "amazon"].entries()) { const id = source.ids[index]!, kind = platform as "etsy" | "amazon";
      await open(page, source, id, seen, index === 0); const registered = await registration(page, source, id, seen);
      await control({ operation: "work", groupId: source.groupId, keyId: registered.key.keyId }); await draft(page, kind); const created = await submit(page, id), result = await completed(page, id, created.id, seen);
      expect(result.snapshot?.platform).toBe(platform); expect(result.snapshotVersion).toBe(1); expect(result.snapshot?.sourceChecksum).toMatch(/^[A-Za-z0-9_-]{43}$/); completedIds.push(result.id);
      const originalSnapshot = task(page).getByRole("region", { name: "本任务原能力快照", exact: true });
      await page.setViewportSize({ width: 1440, height: 1000 }); await screenshot(page, info, platform + "-desktop", originalSnapshot);
      await page.setViewportSize({ width: 390, height: 844 }); await screenshot(page, info, platform + "-mobile", originalSnapshot);
      await control({ operation: "stop", groupId: source.groupId, keyId: registered.key.keyId });
    }
    const after = await snapshot(source); expect(after.business).toEqual(before.business); expect(after.accounts.map(value => value.snapshots.length)).toEqual([1, 1]);
    expect(after.accounts.map(value => value.credentialVersion)).toEqual([2, 1]); expect(after.children.every(value => !value.leaked)).toBe(true); proof.completedIds = completedIds; proof.native = after;
  } catch (error) { primary = { error }; } finally { await finishEvidence(info, source, seen, proof, primary); }
});

test("recovers a lost original201 without reposting and rejects late old management after a genuine personal authority withdrawal", async ({ page }, info) => {
  const source = Seed.parse(await control({ operation: "seed" })), seen = await observe(page, source), proof: Record<string, unknown> = { operation: "e6f2c8a1", case: "original_receipt_and_withdrawal" };
  let release!: () => void, released = false, held: Request | undefined, primary: { error: unknown } | undefined;
  const barrier = new Promise<void>(done => { release = done; });
  try { const id = source.ids[0]; progress(proof, "open_original_store"); const initial = await open(page, source, id, seen, true);
    progress(proof, "register_real_node"); const registered = await registration(page, source, id, seen), before = await snapshot(source); proof.before = before;
    const path = `http://localhost:3130/api/marketplace-accounts/${id}/node-executions`; let posts = 0, original!: StoreNodeExecutionView, originalBody!: z.infer<typeof CreateStoreNodeExecutionInputSchema>;
    page.on("request", request => { if (request.url() === path && request.method() === "POST") posts++; });
    await page.route(path, async route => { if (route.request().method() !== "POST") return route.continue(); originalBody = CreateStoreNodeExecutionInputSchema.parse(route.request().postDataJSON());
      const response = await route.fetch(); expect(response.status()).toBe(201); original = StoreNodeExecutionViewSchema.parse(await response.json()); expect(original.requestId).toBe(originalBody.requestId); expect(original.requestChecksum).toBe(originalBody.requestChecksum);
      seen.loss(route.request(), original); proof.originalExecutionId = original.id; proof.originalRequestId = original.requestId; await route.abort("failed"); }, { times: 1 });
    progress(proof, "submit_and_inject_original201_loss");
    await draft(page, "etsy"); await panel(page).getByRole("button", { name: "保存并交绑定节点同步", exact: true }).click();
    await expect(panel(page).getByRole("region", { name: "原节点同步请求恢复", exact: true })).toBeVisible(); await seen.idle(); expect(posts).toBe(1);
    progress(proof, "reload_original_request"); await page.reload(); await expect(panel(page)).toBeVisible(); await seen.idle();
    const recovery = panel(page).getByRole("article", { name: "原节点同步请求 " + original.requestId, exact: true });
    const receipt = page.waitForResponse(response => response.url() === path + "/receipt" && response.request().method() === "POST").then(async response => ({ status: response.status(), value: StoreNodeExecutionReceiptSchema.parse(await response.json()) }));
    progress(proof, "read_original_receipt"); await recovery.getByRole("button", { name: "只读取原同步回执", exact: true }).click(); const received = await receipt; expect(received.status).toBe(200); expect(received.value.execution?.id).toBe(original.id); expect(posts).toBe(1); proof.recoveredSameId = received.value.execution?.id;
    progress(proof, "execute_on_real_node");
    await control({ operation: "work", groupId: source.groupId, keyId: registered.key.keyId }); const done = await completed(page, id, original.id, seen); expect(done.snapshotVersion).toBe(1);
    proof.completedExecutionId = done.id; progress(proof, "close_original_and_redraft"); await recovery.getByRole("button", { name: "结束本次任务核对", exact: true }).click(); await draft(page, "etsy");
    let entered!: () => void; const ready = new Promise<void>(done => { entered = done; });
    await page.route(path, async route => { if (route.request().method() !== "GET") return route.continue(); const response = await route.fetch(); expect(response.status()).toBe(200);
      const value = StoreNodeExecutionWorkspaceSchema.parse(await response.json()); expect(value.access.canSubmit).toBe(true); held = route.request(); seen.hold(held); entered(); await barrier;
      try { await route.fulfill({ response }); proof.actualOldWorkspaceReturned = true; } catch { proof.actualOldWorkspaceReturned = false; } }, { times: 1 });
    progress(proof, "hold_original_workspace"); await panel(page).getByRole("button", { name: "重新读取执行状态", exact: true }).click(); await ready;
    progress(proof, "withdraw_manage_and_focus");
    const at = Date.now(); await control({ operation: "rights", groupId: source.groupId, enabled: false });
    const focusDocument = page.waitForResponse(response => response.url() === `http://localhost:3130/stores/${id}` && response.request().isNavigationRequest() &&
      response.request().resourceType() === "document" && response.request().frame() === page.mainFrame()); void focusDocument.catch(() => {});
    const focusAt = Date.now(); await page.evaluate(() => window.dispatchEvent(new Event("focus")));
    progress(proof, "await_focus_identity_navigation"); const navigation = await focusDocument; expect(navigation.status()).toBe(200); expect(await navigation.finished()).toBeNull();
    let current = await session(page); await expect.poll(async () => { current = await session(page); return current.authority; }).not.toBe(initial.authority); seen.known(current.authority);
    progress(proof, "read_current_personal_authority"); await expect(panel(page)).toBeVisible(); await expect(panel(page).getByRole("form", { name: "节点能力同步填写", exact: true })).toHaveCount(0);
    proof.focusIdentityNavigation = await seen.focusDocument(navigation.request(), id, current.hash);
    progress(proof, "release_original_held_read");
    await seen.idle(); release(); released = true; await seen.idle(); seen.transition({ accountId: id, at, focusAt, end: Date.now(), old: initial.authority, current: current.authority, document: navigation.request() });
    await expect(panel(page).getByRole("button", { name: "保存并交绑定节点同步", exact: true })).toHaveCount(0);
    progress(proof, "reject_original_write_after_withdrawal"); const denied = await page.request.post(path, { headers: { Origin: "http://localhost:3130", "x-yummyai-context-authority": current.hash }, data: originalBody }); proof.currentManageDenied = denied.status(); expect(denied.status()).toBe(403);
    progress(proof, "verify_native_facts_and_counts"); const after = await snapshot(source); proof.native = after; proof.posts = posts;
    proof.refreshCounts = { before: before.counts.etsy_refresh ?? 0, after: after.counts.etsy_refresh ?? 0, delta: (after.counts.etsy_refresh ?? 0) - (before.counts.etsy_refresh ?? 0) };
    expect(after.business).toEqual(before.business); expect(after.accounts[0]!.snapshots).toHaveLength(1); expect(posts).toBe(1); expect((after.counts.etsy_refresh ?? 0) - (before.counts.etsy_refresh ?? 0)).toBe(1);
    progress(proof, "capture_withdrawn_mobile");
    await page.setViewportSize({ width: 390, height: 844 }); await screenshot(page, info, "withdrawn-mobile");
    progress(proof, "business_assertions_completed");
  } catch (error) { primary = { error }; } finally { if (!released) release(); await finishEvidence(info, source, seen, proof, primary); }
});
