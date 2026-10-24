import { expect, test, type Page, type Request, type TestInfo } from "@playwright/test";
import { createHash } from "node:crypto";
import { readFile, writeFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { z } from "zod";
import { CreateMarketplaceListingSyncInputSchema, MarketplaceListingSyncRequestViewSchema } from "@yummyai/contracts";
import { ErpSessionViewSchema, erpSessionAuthority } from "@yummyai/contracts/auth/session";
import { ListingSyncIntentReceiptSchema, listingSyncIntentRequestText } from "@yummyai/contracts/marketplace/listing-sync-intent";
import { requireListingSyncIntentEnvironment } from "../../../tools/testing/require-listing-sync-intent-environment.mjs";
import { loginErp, actors } from "./erp-identity-fixture";

const { nonce } = requireListingSyncIntentEnvironment(process.env, "current", true), sha = (value: string) => createHash("sha256").update(value).digest("hex");
const Id = z.uuidv7(), Digest = z.string().regex(/^[a-f0-9]{64}$/), prefix = "yummyai.listing-sync.intent.v1:";
const Seed = z.object({ groupId: Id, actorId: Id, tenantId: Id, source: z.object({ id: Id, planId: Id, spuId: Id, listingId: Id, versionId: Id, accountId: Id,
  publicationId: Id, secondPublicationId: Id, title: z.string() }).strict() }).strict();
const Snapshot = z.object({ business: z.object({ paid: z.int(), publications: z.int(), syncs: z.int() }).strict(), providerCalls: z.int(), enqueueCalls: z.array(Id),
  requests: z.array(z.object({ id: Id, listingVersionId: Id, desiredChecksum: Digest, idempotencyKey: Digest }).strict()),
  events: z.array(z.object({ id: Id, requestId: Id, sequence: z.int(), status: z.string(), snapshotChecksum: Digest.nullable() }).strict()),
  immutableBodySha: Digest, jobs: z.array(z.object({ id: z.string(), requestId: Id }).strict()) }).strict();
type Source = z.infer<typeof Seed>;
async function control(input: Record<string, unknown>) {
  const path = fileURLToPath(new URL(`../../../tmp/listing-sync-intent-20261022-b7d3e8f2/qa/browser-control-${nonce}.json`, import.meta.url));
  const value = z.object({ nonce: z.literal(nonce), pid: z.int().positive(), origin: z.url(), key: z.string().regex(/^[A-Za-z0-9_-]{43}$/) }).strict().parse(JSON.parse(await readFile(path, "utf8")));
  const origin = new URL(value.origin); if (origin.origin !== value.origin || origin.hostname !== "127.0.0.1" || origin.protocol !== "http:" || origin.search || origin.hash || origin.username || origin.password) throw new Error("listing_sync_intent_control_origin_invalid");
  const response = await fetch(origin, { method: "POST", headers: { "content-type": "application/json", "x-fixture-control": value.key }, body: JSON.stringify(input), redirect: "error", signal: AbortSignal.timeout(30_000) });
  if (response.status !== 200) { await response.body?.cancel(); throw new Error("listing_sync_intent_control_failed"); } return await response.json() as unknown;
}
const panel = (page: Page) => page.getByRole("region", { name: "在线 Listing 同步", exact: true });
const snapshot = async (source: Source) => Snapshot.parse(await control({ operation: "snapshot", groupId: source.groupId }));
async function session(page: Page) { const response = await page.request.get("/api/erp-auth/session"); expect(response.status()).toBe(200);
  const value = ErpSessionViewSchema.parse(await response.json()); return { value, raw: erpSessionAuthority(value), hash: sha(erpSessionAuthority(value)) }; }
const Audit = z.object({ doc: z.string().uuid(), seq: z.int().positive(), key: z.string().max(350), started: z.number().positive(), authority: Digest.nullable(), responseAuthority: Digest.nullable(),
  status: z.int().min(100).max(599).optional(), eofAt: z.number().positive().optional(), abortSeenAtEof: z.boolean().optional(), cancelSeenAtEof: z.boolean().optional(),
  signalAbortAt: z.number().positive().optional(), signalAbortKind: z.enum(["AbortError", "TimeoutError", "Other"]).optional(), fetchErrorKind: z.enum(["AbortError", "TimeoutError", "Other"]).optional(),
  bytes: z.int().nonnegative(), reads: z.int().nonnegative(), jsonDone: z.boolean(), cancelled: z.boolean(), error: z.boolean() }).strict();

/** Passive observations of the original fetch/reader promises. No clone, tee or extra read. */
async function observe(page: Page, source: Source) {
  const audits = new Map<string, z.infer<typeof Audit>>(), known = new Set<string>(), requestIds = new Set<string>(), keys = new Set<string>(), documentAuthorities = new Map<number, Set<string>>(), settingsReturnLinks = new Set<number>();
  const errors: Array<{ at: number; path: string | null; query: string | null; lossText: boolean; deniedText: boolean; used: boolean }> = [], pageErrors: string[] = [];
  const controls: Array<{ label: string; start: number; end: number }> = [], responseChecks: Promise<void>[] = [];
  let personal: string | null = null, held: Request | undefined, transition: { start: number; focus: number; end: number; old: string; current: string; document: Request } | null = null;
  await page.exposeBinding("__listingIntentReadAudit", (event, raw: unknown) => { if (event.frame !== page.mainFrame()) return; const value = Audit.safeParse(raw); if (!value.success) return;
    const key = value.data.doc + ":" + value.data.seq; if (!audits.has(key) && audits.size >= 250) return; audits.set(key, value.data); });
  await page.addInitScript(({ listingId }) => {
    const send = (value: unknown) => { void (globalThis as unknown as { __listingIntentReadAudit(value: unknown): Promise<void> }).__listingIntentReadAudit(value).catch(() => {}); };
    const readKey = (url: URL) => {
      if (url.origin !== location.origin) return null;
      if (url.pathname === `/api/listings/${listingId}` && !url.search) return url.pathname;
      if (url.pathname === "/api/erp-listing-sync/workspace" && Array.from(url.searchParams.keys()).join() === "listingId" && url.searchParams.get("listingId") === listingId) return url.pathname + "?listingId=" + listingId;
      if (url.pathname === "/api/erp-listing-sync/receipt" && Array.from(url.searchParams.keys()).sort().join() === "requestChecksum,requestKey" && /^[a-f0-9-]{36}$/.test(url.searchParams.get("requestKey") ?? "") && /^[a-f0-9]{64}$/.test(url.searchParams.get("requestChecksum") ?? ""))
        return url.pathname + "?" + new URLSearchParams({ requestKey: url.searchParams.get("requestKey")!, requestChecksum: url.searchParams.get("requestChecksum")! });
      return /^\/api\/erp-listing-sync\/requests\/[a-f0-9-]{36}(?:\/events)?$/.test(url.pathname) && !url.search ? url.pathname : null;
    };
    const original = globalThis.fetch, doc = crypto.randomUUID(); let seq = 0;
    globalThis.fetch = function (...args: Parameters<typeof fetch>) {
      const url = new URL(args[0] instanceof Request ? args[0].url : String(args[0]), location.href), init = args[1], method = (init?.method ?? (args[0] instanceof Request ? args[0].method : "GET")).toUpperCase();
      const key = method === "GET" ? readKey(url) : null, promise = Reflect.apply(original, this, args) as ReturnType<typeof fetch>; if (!key) return promise;
      const signal = init?.signal ?? (args[0] instanceof Request ? args[0].signal : undefined), header = new Headers(init?.headers ?? (args[0] instanceof Request ? args[0].headers : undefined)).get("x-yummyai-context-authority");
      const state: { doc: string; seq: number; key: string; started: number; authority: string | null; responseAuthority: string | null; status?: number; eofAt?: number; abortSeenAtEof?: boolean; cancelSeenAtEof?: boolean;
        signalAbortAt?: number; signalAbortKind?: "AbortError" | "TimeoutError" | "Other"; fetchErrorKind?: "AbortError" | "TimeoutError" | "Other";
        bytes: number; reads: number; jsonDone: boolean; cancelled: boolean; error: boolean } = { doc, seq: ++seq, key, started: Date.now(), authority: header && /^[a-f0-9]{64}$/.test(header) ? header : null,
        responseAuthority: null, bytes: 0, reads: 0, jsonDone: false, cancelled: false, error: false };
      const record = () => send({ ...state }), eof = () => { if (state.eofAt === undefined) { state.eofAt = Date.now(); state.abortSeenAtEof = state.signalAbortAt !== undefined; state.cancelSeenAtEof = state.cancelled; } record(); };
      const errorKind = (value: unknown): "AbortError" | "TimeoutError" | "Other" => value instanceof DOMException && value.name === "AbortError" ? "AbortError" : value instanceof DOMException && value.name === "TimeoutError" ? "TimeoutError" : "Other";
      if (signal) signal.addEventListener("abort", () => { state.signalAbortAt ??= Date.now(); state.signalAbortKind = errorKind(signal.reason); record(); }, { once: true }); record();
      void promise.then(response => { state.status = response.status; const stamp = response.headers.get("x-yummyai-context-authority"); state.responseAuthority = stamp && /^[a-f0-9]{64}$/.test(stamp) ? stamp : null; record();
        const json = response.json; response.json = function (...jsonArgs) { const result = Reflect.apply(json, this, jsonArgs) as ReturnType<typeof response.json>;
          void result.then(() => { state.jsonDone = true; eof(); }, () => { state.error = true; record(); }); return result; };
        const body = response.body; if (!body) return; const getReader = body.getReader;
        body.getReader = function (this: ReadableStream<Uint8Array>, ...readerArgs) { const reader = Reflect.apply(getReader, this, readerArgs) as ReadableStreamDefaultReader<Uint8Array>, read = reader.read, cancel = reader.cancel;
          reader.read = function (...readArgs) { const result = Reflect.apply(read, this, readArgs) as ReturnType<typeof reader.read>; void result.then(value => { state.reads++; if (value.done) eof(); else { state.bytes += value.value.byteLength; record(); } }, () => { state.error = true; record(); }); return result; };
          reader.cancel = function (...cancelArgs) { state.cancelled = true; record(); return Reflect.apply(cancel, this, cancelArgs); }; return reader; } as typeof body.getReader;
      }, error => { state.error = true; state.fetchErrorKind = errorKind(error); record(); }); return promise;
    };
  }, { listingId: source.source.listingId });
  type Network = { request: Request; ordinal: number; method: string; path: string; query: string; authority: string | null; responseAuthority: string | null; personal: string | null;
    at: number; terminalAt: number | null; terminal: boolean; status: number | null; failed: string | null; generation: number; document: boolean; resourceType: string; prefetch: boolean; deniedBody: boolean };
  const rows: Network[] = [], losses = new Map<Request, { id: string; requestKey: string; consumed: boolean; consoleConsumed: boolean }>(); let generation = 0, ordinal = 0;
  const safeQuery = (url: URL) => {
    if (url.pathname.startsWith("/api/erp-listing-sync/")) return url.search;
    const names = Array.from(url.searchParams.keys()), rsc = url.searchParams.getAll("_rsc"), validRsc = rsc.length === 1 && /^[A-Za-z0-9_-]{1,80}$/.test(rsc[0]!);
    if (!names.length) return "";
    if (names.length === 1 && names[0] === "_rsc" && validRsc) return "?_rsc";
    if (url.pathname === "/settings/ai" && url.searchParams.getAll("returnTo").length === 1 && url.searchParams.get("returnTo") === `/listings/${source.source.listingId}` && names.every(name => name === "returnTo" || name === "_rsc") && (names.length === 1 && rsc.length === 0 || names.length === 2 && validRsc)) return validRsc ? "?returnTo=selected_listing&_rsc" : "?returnTo=selected_listing";
    return "unsupported";
  };
  page.on("request", request => { const url = new URL(request.url()); if (url.origin !== "http://localhost:3130") return;
    const document = request.isNavigationRequest() && request.resourceType() === "document" && request.frame() === page.mainFrame(); if (document) generation++;
    const stamp = request.headers()["x-yummyai-context-authority"]; rows.push({ request, ordinal: ++ordinal, method: request.method(), path: url.pathname,
      query: safeQuery(url), authority: stamp && /^[a-f0-9]{64}$/.test(stamp) ? stamp : null,
      responseAuthority: null, personal, at: Date.now(), terminalAt: null, terminal: false, status: null, failed: null, generation, document, resourceType: request.resourceType(), prefetch: request.headers()["next-router-prefetch"] === "1", deniedBody: false }); });
  page.on("response", response => { const row = rows.find(value => value.request === response.request()); if (row) { row.status = response.status(); const stamp = response.headers()["x-yummyai-context-authority"]; row.responseAuthority = stamp && /^[a-f0-9]{64}$/.test(stamp) ? stamp : null;
    if (row.status === 403 && row.method === "GET" && (row.path === `/api/listings/${source.source.listingId}` && !row.query || row.path === "/api/erp-listing-sync/workspace" && row.query === "?listingId=" + source.source.listingId)) {
      responseChecks.push(response.json().then((value: unknown) => { if (!value || typeof value !== "object" || Object.keys(value).join() !== "message" || !("message" in value)) return;
        row.deniedBody = value.message === (row.path.startsWith("/api/listings/") ? "刊登不存在或当前账号不可读取" : "当前无原刊登同步权限"); }, () => {}));
    }
  } });
  page.on("requestfinished", request => { const row = rows.find(value => value.request === request); if (row) { row.terminal = true; row.terminalAt = Date.now(); } });
  page.on("requestfailed", request => { const row = rows.find(value => value.request === request); if (row) { row.terminal = true; row.terminalAt = Date.now(); row.failed = request.failure()?.errorText ?? "unknown"; } });
  page.on("console", value => { if (value.type() !== "error") return; let path: string | null = null, query: string | null = null; try { const url = new URL(value.location().url);
      if (url.origin === "http://localhost:3130" && (!url.search || url.pathname === "/api/erp-listing-sync/workspace" && url.search === "?listingId=" + source.source.listingId)) { path = url.pathname; query = url.search; }
    } catch { /* Unknown errors remain failures. */ }
    errors.push({ at: Date.now(), path, query, lossText: value.text() === "Failed to load resource: net::ERR_FAILED", deniedText: value.text() === "Failed to load resource: the server responded with a status of 403 (Forbidden)", used: false }); });
  page.on("pageerror", error => pageErrors.push(error.name));
  const eligible = (row: Network) => { if (row.method !== "GET") return false; const url = new URL(row.path + row.query, "http://localhost:3130");
    if (row.path === `/api/listings/${source.source.listingId}`) return row.query === "";
    if (row.path === "/api/erp-listing-sync/workspace") return Array.from(url.searchParams.keys()).join() === "listingId" && url.searchParams.get("listingId") === source.source.listingId;
    if (row.path === "/api/erp-listing-sync/receipt") return Array.from(url.searchParams.keys()).sort().join() === "requestChecksum,requestKey" && keys.has(url.searchParams.get("requestKey") ?? "") && Digest.safeParse(url.searchParams.get("requestChecksum")).success;
    const match = /^\/api\/erp-listing-sync\/requests\/([a-f0-9-]{36})(?:\/events)?$/.exec(row.path); return Boolean(match && requestIds.has(match[1]!) && row.query === ""); };
  const key = (row: Network) => { const url = new URL(row.path + row.query, "http://localhost:3130"); return row.path === "/api/erp-listing-sync/receipt"
    ? row.path + "?" + new URLSearchParams({ requestKey: url.searchParams.get("requestKey")!, requestChecksum: url.searchParams.get("requestChecksum")! }) : row.path + row.query; };
  const candidates = (row: Network) => { const started = row.request.timing().startTime; if (!eligible(row) || !Number.isFinite(started) || started <= 0) return [];
    return [...audits.values()].filter(value => value.key === key(row) && value.authority === row.authority && Math.abs(value.started - started) <= 25 && (row.status === null ? value.status === undefined : value.status === row.status)); };
  const exact = (row: Network) => { const values = candidates(row); return values.length === 1 && rows.filter(other => candidates(other).some(value => value.doc === values[0]!.doc && value.seq === values[0]!.seq)).length === 1 ? values[0] : undefined; };
  const safe = (row: Network) => ({ ordinal: row.ordinal, method: row.method, path: row.path, queryEmpty: row.query === "", queryKind: row.query === "?returnTo=selected_listing" ? "settings_return_to_selected_listing" : row.query === "?returnTo=selected_listing&_rsc" ? "settings_return_to_selected_listing_with_rsc" : row.query === "?_rsc" ? "next_rsc_only" : row.query.startsWith("?listingId=") ? "selected_listing" : row.path.endsWith("/receipt") ? "typed_receipt" : row.query ? "unsupported" : "none",
    authority: row.authority, responseAuthority: row.responseAuthority, personal: row.personal, at: row.at, terminalAt: row.terminalAt, terminal: row.terminal, status: row.status, failed: row.failed, generation: row.generation, document: row.document, resourceType: row.resourceType, prefetch: row.prefetch, fixedDenialBody: row.deniedBody, timing: row.request.timing() });
  const idle = async () => { await expect.poll(() => rows.filter(row => !row.terminal && row.request !== held).length, { timeout: 20_000 }).toBe(0); };
  let classification: object[] = [], unexpected: object[] = [];
  return { idle, postCount: () => rows.filter(row => row.method === "POST").length, settingsReturnLink: () => { settingsReturnLinks.add(generation); }, known: (raw: string) => { personal = sha(raw); known.add(personal); const stamps = documentAuthorities.get(generation) ?? new Set<string>(); stamps.add(personal); documentAuthorities.set(generation, stamps); }, request: (value: z.infer<typeof MarketplaceListingSyncRequestViewSchema>, requestKey?: string) => { requestIds.add(value.id); if (requestKey) keys.add(requestKey); },
    hold: (request: Request) => { held = request; }, async control<T>(label: string, action: () => Promise<T>) { const window = { label, start: Date.now(), end: 0 }; controls.push(window); try { return await action(); } finally { window.end = Date.now(); } },
    loss: (request: Request, value: z.infer<typeof MarketplaceListingSyncRequestViewSchema>, requestKey: string) => { MarketplaceListingSyncRequestViewSchema.parse(value); requestIds.add(value.id); keys.add(requestKey); losses.set(request, { id: value.id, requestKey, consumed: false, consoleConsumed: false }); },
    transition: (value: NonNullable<typeof transition>) => { expect(value.old).not.toBe(value.current); expect(known.has(value.old) && known.has(value.current)).toBe(true); transition = value; },
    async check() {
      await idle(); await Promise.all(responseChecks); classification = []; unexpected = []; const deniedRows: Network[] = [];
      for (const row of rows) {
        const loss = losses.get(row.request);
        if (loss && row.method === "POST" && row.path === "/api/erp-listing-sync/requests" && !row.query && row.failed === "net::ERR_FAILED") { loss.consumed = true; classification.push({ ordinal: row.ordinal, kind: "injected_original201_loss", id: loss.id, requestKey: loss.requestKey }); continue; }
        const denial = transition && row.status === 403 && row.deniedBody && eligible(row) && row.terminal && row.terminalAt !== null && row.at >= transition.focus && row.terminalAt <= transition.end &&
          (row.authority === transition.old || row.authority === transition.current || row.authority === null && row.personal === transition.old);
        if (denial) { deniedRows.push(row); classification.push({ ordinal: row.ordinal, kind: "exact_read_denied_in_actual_withdrawal", status: 403, fixedDenialBody: true }); }
        else if (row.status !== null && row.status >= 400) unexpected.push({ ordinal: row.ordinal, kind: "http", path: row.path, status: row.status });
        if (!row.failed) continue; const audit = exact(row), timing = row.request.timing(), stamp = row.authority ?? row.personal;
        const authority = stamp !== null && known.has(stamp) && (row.path.startsWith("/api/erp-listing-sync/") ? row.responseAuthority === stamp && audit?.responseAuthority === stamp : row.authority === null);
        if (row.failed === "net::ERR_ABORTED" && row.status === 200 && authority && audit && audit.eofAt !== undefined && audit.abortSeenAtEof === false && audit.cancelSeenAtEof === false && !audit.error && !audit.cancelled && (audit.bytes > 0 && audit.reads > 0 || audit.jsonDone) && timing.responseEnd >= 0) {
          classification.push({ ordinal: row.ordinal, kind: "completed_read_with_terminal_abort", audit, browserEofAt: audit.eofAt, nodeFailedAt: row.terminalAt }); continue;
        }
        const window = controls.find(value => value.end > 0 && row.at >= value.start && row.terminalAt !== null && row.terminalAt <= value.end);
        const selectedReturn = row.path === "/settings/ai" && ["?returnTo=selected_listing", "?returnTo=selected_listing&_rsc"].includes(row.query) && settingsReturnLinks.has(row.generation);
        if (row.failed === "net::ERR_ABORTED" && row.prefetch && row.method === "GET" && row.resourceType === "fetch" && !row.document && row.status === 200 && (row.query === "" || row.query === "?_rsc" || selectedReturn) && ["/", "/navigation", "/settings/ai"].includes(row.path) && window) {
          const stamps = documentAuthorities.get(row.generation), documents = rows.filter(value => value.document && value.generation === row.generation && value.method === "GET" && value.path === `/listings/${source.source.listingId}` && !value.query && value.status === 200 && value.terminal && !value.failed && value.request.timing().responseEnd >= 0);
          if (stamps?.size === 1 && known.has([...stamps][0]!) && (row.personal === null || stamps.has(row.personal)) && row.authority === null && documents.length === 1) { classification.push({ ordinal: row.ordinal, kind: "exact_next_prefetch_cancel_in_control", control: window.label, documentOrdinal: documents[0]!.ordinal, personalAuthority: [...stamps][0], selectedReturnDomHrefMatched: selectedReturn }); continue; }
        }
        if (eligible(row) && row.failed === "net::ERR_ABORTED" && row.status === null && stamp !== null && known.has(stamp) && audit?.signalAbortAt !== undefined && audit.signalAbortKind === "AbortError" && audit.fetchErrorKind === "AbortError" && audit.bytes === 0 && !audit.eofAt && !audit.cancelled && window) {
          classification.push({ ordinal: row.ordinal, kind: "exact_stale_read_in_control", control: window.label, signalAbortAt: audit.signalAbortAt }); continue;
        }
        const change = transition;
        if (change) {
          const freshDocuments = rows.filter(value => value.document && value.request === change.document && value.method === "GET" && value.path === `/listings/${source.source.listingId}` && !value.query && value.at >= change.focus && value.terminalAt !== null && value.terminalAt <= change.end && value.status === 200 && value.terminal && !value.failed && value.request.timing().responseEnd >= 0);
          const freshDocument = freshDocuments.length === 1 ? freshDocuments[0] : undefined;
          const oldDocuments = freshDocument ? rows.filter(value => value.document && value.generation === freshDocument.generation - 1 && value.method === "GET" && value.path === freshDocument.path && !value.query && value.at < change.start && value.status === 200 && value.terminal && !value.failed && value.request.timing().responseEnd >= 0) : [];
          const oldDocument = oldDocuments.length === 1 ? oldDocuments[0] : undefined;
          const freshStamps = freshDocument && documentAuthorities.get(freshDocument.generation), oldStamps = oldDocument && documentAuthorities.get(oldDocument.generation);
          const documentsVerified = freshDocument && oldDocument && freshStamps?.size === 1 && freshStamps.has(change.current) && oldStamps?.size === 1 && oldStamps.has(change.old);
          if (documentsVerified && row.failed === "net::ERR_ABORTED" && row.prefetch && row.method === "GET" && row.resourceType === "fetch" && !row.document && row.status === 200 && row.authority === null && row.personal === change.current && row.generation === freshDocument.generation && row.at >= freshDocument.at && row.terminalAt !== null && row.terminalAt <= change.end && (row.query === "" || row.query === "?_rsc" || selectedReturn) && ["/", "/navigation", "/settings/ai"].includes(row.path) && timing.startTime > 0 && timing.responseStart >= 0 && timing.responseEnd >= 0) {
            classification.push({ ordinal: row.ordinal, kind: "exact_next_prefetch_cancel_in_permission_navigation", documentOrdinal: freshDocument.ordinal, oldDocumentOrdinal: oldDocument.ordinal, personalAuthority: change.current, windowStart: change.focus, windowEnd: change.end, selectedReturnDomHrefMatched: selectedReturn }); continue;
          }
          if (documentsVerified) {
            const undispatched = (value: Network) => { const valueTiming = value.request.timing(); return value.method === "GET" && value.resourceType === "fetch" && !value.document && !value.prefetch && value.path === `/api/listings/${source.source.listingId}` && value.query === "" && value.authority === null && value.responseAuthority === null && value.personal === change.old && value.generation === oldDocument.generation && value.status === null && value.failed === "net::ERR_ABORTED" && value.at >= change.focus && value.at <= freshDocument.at && value.terminalAt !== null && value.terminalAt >= freshDocument.at && value.terminalAt <= change.end && valueTiming.startTime === 0 && valueTiming.requestStart === -1 && valueTiming.responseStart === -1 && valueTiming.responseEnd === -1; };
            if (undispatched(row)) {
              const prior = rows.filter(value => value.generation === oldDocument.generation && value.method === "GET" && value.path === row.path && value.query === "" && value.status === 200 && value.terminal && !value.failed && value.at < change.focus).map(value => ({ row: value, audit: exact(value) }))
                .filter(value => value.audit?.status === 200 && value.audit.eofAt !== undefined && value.audit.abortSeenAtEof === false && value.audit.cancelSeenAtEof === false && !value.audit.error && (value.audit.jsonDone || value.audit.bytes > 0 && value.audit.reads > 0));
              const oldBrowserDocuments = new Set(prior.map(value => value.audit!.doc));
              const zeroCandidates = (value: Network) => undispatched(value) ? [...audits.values()].filter(observation => oldBrowserDocuments.size === 1 && oldBrowserDocuments.has(observation.doc) && observation.key === value.path && observation.authority === null && observation.responseAuthority === null && observation.status === undefined && observation.started >= change.focus && observation.started <= freshDocument.at && Math.abs(observation.started - value.at) <= 25 && observation.signalAbortAt !== undefined && observation.signalAbortAt >= observation.started && observation.signalAbortAt <= change.end && observation.signalAbortKind === "AbortError" && observation.fetchErrorKind === "AbortError" && observation.error && observation.bytes === 0 && observation.reads === 0 && !observation.jsonDone && observation.eofAt === undefined && !observation.cancelled) : [];
              const matches = zeroCandidates(row), unique = matches.length === 1 && rows.filter(value => zeroCandidates(value).some(observation => observation.doc === matches[0]!.doc && observation.seq === matches[0]!.seq)).length === 1;
              if (unique) { const match = matches[0]!; classification.push({ ordinal: row.ordinal, kind: "exact_unstamped_preheader_read_in_permission_navigation", oldDocumentOrdinal: oldDocument.ordinal, documentOrdinal: freshDocument.ordinal, oldPersonalAuthority: change.old, freshPersonalAuthority: change.current, pairedOldBrowserDocument: match.doc, auditSeq: match.seq, browserStarted: match.started, requestObservedAt: row.at, signalAbortAt: match.signalAbortAt, nodeTerminalAt: row.terminalAt, timingSource: "request_event_only_for_exact_undispatched_transition", windowStart: change.focus, windowEnd: change.end }); continue; }
            }
          }
        }
        if (change && eligible(row) && row.failed === "net::ERR_ABORTED" && row.authority === change.old && row.terminalAt !== null && row.terminalAt >= change.start && row.terminalAt <= change.end && (row.at >= change.start || row.request === held)) {
          const docs = rows.filter(value => value.document && value.request === change.document && value.method === "GET" && value.path === `/listings/${source.source.listingId}` && !value.query && value.at >= change.focus && value.status === 200 && value.terminal && !value.failed && value.request.timing().responseEnd >= 0);
          if (docs.length === 1) { classification.push({ ordinal: row.ordinal, kind: row.request === held ? "held_old_authority_read_in_real_navigation" : "old_authority_read_in_real_navigation", documentOrdinal: docs[0]!.ordinal }); continue; }
        }
        unexpected.push({ ordinal: row.ordinal, kind: "unknown_cancel", path: row.path, method: row.method, status: row.status });
      }
      for (const [request, loss] of losses) if (loss.consumed) { const row = rows.find(value => value.request === request)!;
        const matching = errors.filter(value => !value.used && value.lossText && value.path === row.path && value.query === row.query && value.at >= row.at); if (matching.length === 1) { matching[0]!.used = true; loss.consoleConsumed = true; } }
      const deniedConsole = (value: typeof errors[number], row: Network) => value.deniedText && value.path === row.path && value.query === row.query && value.at >= row.at && value.at <= transition!.end;
      for (const row of deniedRows) { const matching = errors.filter(value => !value.used && deniedConsole(value, row));
        if (matching.length === 1 && deniedRows.filter(other => deniedConsole(matching[0]!, other)).length === 1) matching[0]!.used = true; }
      expect(unexpected).toEqual([]); expect(errors.filter(value => !value.used)).toEqual([]); expect(pageErrors).toEqual([]);
      for (const value of losses.values()) { expect(value.consumed).toBe(true); expect(value.consoleConsumed).toBe(true); }
    }, proof: () => ({ network: rows.slice(0, 1000).map(safe), networkCount: rows.length, networkTruncated: rows.length > 1000, readAudit: [...audits.values()], controls, settingsReturnDomHrefGenerations: [...settingsReturnLinks], documentAuthorities: [...documentAuthorities].map(([generation, stamps]) => ({ generation, authorities: [...stamps] })), classification, unexpected,
      consoleErrors: errors.length, consoleDiagnostics: errors, pageErrors, transition: transition ? { start: transition.start, focus: transition.focus, end: transition.end, old: transition.old, current: transition.current } : null }),
  };
}
type Seen = Awaited<ReturnType<typeof observe>>;
async function open(page: Page, source: Source, seen: Seen, mode: "login" | "recovery") {
  const posts = seen.postCount();
  await seen.control(mode === "login" ? "initial_personal_login" : "explicit_original_page_reload", async () => { if (mode === "login") await loginErp(page, "operator", "/listings/" + source.source.listingId); else await page.reload();
    const current = await session(page); expect(current.value.userId).toBe(source.actorId); expect(current.value.tenantId).toBe(source.tenantId); seen.known(current.raw);
    const channels = page.getByRole("navigation", { name: "刊登编辑区" }).getByRole("button", { name: "Channels", exact: true }); await expect(channels).toBeEnabled(); await seen.idle();
    const settings = page.getByRole("link", { name: "前往 AI 模型配置", exact: true });
    if (await settings.count() === 1) { const matched = await settings.evaluate((element, listingId) => { const href = new URL((element as HTMLAnchorElement).href, location.href); return href.origin === location.origin && href.pathname === "/settings/ai" && !href.hash && Array.from(href.searchParams.keys()).join() === "returnTo" && href.searchParams.get("returnTo") === `/listings/${listingId}`; }, source.source.listingId); expect(matched).toBe(true); seen.settingsReturnLink(); }
    await channels.click();
    const selected = panel(page).getByRole("combobox", { name: /^已发布 Listing/ });
    if (mode === "recovery") { await expect(panel(page).getByRole("region", { name: "本人原同步请求恢复", exact: true })).toBeVisible(); await expect(selected).toBeDisabled(); await expect(panel(page).getByRole("button", { name: "只读取原同步回执", exact: true })).toBeEnabled(); }
    else await expect(selected).toBeEnabled(); await seen.idle(); });
  if (mode === "recovery") expect(seen.postCount()).toBe(posts);
}
async function review(page: Page, source: Source) {
  await panel(page).getByRole("combobox", { name: /^已发布 Listing/ }).selectOption(source.source.publicationId);
  await panel(page).getByRole("combobox", { name: /^本次同步动作/ }).selectOption("read_full_content");
  await panel(page).getByRole("button", { name: "核对本次同步", exact: true }).click();
  const draft = panel(page).getByRole("region", { name: "固定原同步请求", exact: true }); await expect(draft).toBeVisible();
  await draft.getByRole("checkbox", { name: "已核对原店铺 原 Listing 版本与本次动作", exact: true }).check(); return draft;
}
async function screenshot(page: Page, info: TestInfo, label: string, mobile: boolean) {
  await page.setViewportSize({ width: mobile ? 390 : 1440, height: mobile ? 844 : 1000 });
  const detail = panel(page).getByRole("region", { name: "原同步请求详情", exact: true }), heading = detail.getByRole("heading", { name: /^(原任务已保存|发现差异|已完成本次核对)$/ }); await heading.scrollIntoViewIfNeeded();
  await expect.poll(() => heading.evaluate(element => { const rect = element.getBoundingClientRect(), owner = element.closest(".lsi-receipt")!; return rect.top >= 0 && rect.bottom <= innerHeight && getComputedStyle(owner).opacity === "1" && !owner.getAnimations({ subtree: true }).some(animation => animation.playState === "running"); })).toBe(true);
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1)).toBe(true); const path = info.outputPath(label + ".png"); await page.screenshot({ path }); await info.attach(label, { path, contentType: "image/png" });
}
async function finish(info: TestInfo, page: Page, source: Source, seen: Seen, evidence: Record<string, unknown>, primary: unknown) {
  let auditError: unknown; try { await seen.check(); } catch (error) { auditError = error; }
  let cleanupError: unknown; try { evidence.cleanup = await control({ operation: "close", groupId: source.groupId }); } catch (error) { cleanupError = error; }
  const path = info.outputPath("listing-sync-intent-proof.json"); await writeFile(path, JSON.stringify({ operation: "b7d3e8f2", ...evidence, network: seen.proof(),
    primary: primary instanceof Error ? { name: primary.name } : primary ? { name: "Unknown" } : null, auditFailed: Boolean(auditError), cleanupFailed: Boolean(cleanupError), urlPath: new URL(page.url()).pathname }));
  await info.attach("listing-sync-intent-proof", { path, contentType: "application/json" }); if (primary) throw primary; if (auditError) throw auditError; if (cleanupError) throw cleanupError;
}

test.describe("personal original Listing sync intent recovery", () => {
  test("recovers only the original lost201 through real receipt and remount at1440and390 without a second business POST", async ({ page }, info) => {
    const source = Seed.parse(await control({ operation: "seed" })), seen = await observe(page, source), evidence: Record<string, unknown> = { phase: "login", syntheticHistoricalPrerequisites: true }; let primary: unknown;
    const posts: unknown[] = []; page.on("request", request => { if (request.method() === "POST" && new URL(request.url()).pathname === "/api/erp-listing-sync/requests") posts.push(request); });
    let submitted: z.infer<typeof CreateMarketplaceListingSyncInputSchema> | undefined;
    try {
      expect(source.actorId).toBe(actors().operator.userId); await open(page, source, seen, "login"); const before = await snapshot(source); evidence.before = before; evidence.phase = "review_motion";
      await page.emulateMedia({ reducedMotion: "no-preference" }); let closing = await review(page, source);
      const normalMotion = await closing.getByRole("button", { name: "关闭同步核对", exact: true }).evaluate(button => { (button as HTMLElement).click(); return new Promise<{ present: boolean; closing: boolean; inert: boolean; hidden: string | null; animation: string }>(done => requestAnimationFrame(() => {
        const element = document.querySelector<HTMLElement>(".lsi-review"); done({ present: Boolean(element), closing: element?.classList.contains("lsi-review-closing") ?? false, inert: element?.inert ?? false, hidden: element?.getAttribute("aria-hidden") ?? null, animation: element ? getComputedStyle(element).animationName : "none" }); })); });
      expect(normalMotion).toMatchObject({ present: true, closing: true, inert: true, hidden: "true", animation: "lsi-exit" }); await expect(panel(page).getByRole("region", { name: "固定原同步请求", exact: true, includeHidden: true })).toHaveCount(0); expect(posts).toHaveLength(0); evidence.normalMotion = normalMotion;
      await page.emulateMedia({ reducedMotion: "reduce" }); closing = await review(page, source);
      const reducedUnmounted = await closing.getByRole("button", { name: "关闭同步核对", exact: true }).evaluate(button => { (button as HTMLElement).click(); return new Promise<boolean>(done => requestAnimationFrame(() => done(document.querySelector(".lsi-review") === null))); });
      expect(reducedUnmounted).toBe(true); expect(posts).toHaveLength(0); evidence.reducedMotionUnmounted = reducedUnmounted; await page.emulateMedia({ reducedMotion: "no-preference" }); evidence.phase = "lost_original201";
      await page.route("**/api/erp-listing-sync/requests", async route => { const input = CreateMarketplaceListingSyncInputSchema.parse(route.request().postDataJSON()); expect(input.requestKey).toBeTruthy(); expect(input.listingId).toBe(source.source.listingId);
        const response = await route.fetch(); expect(response.status()).toBe(201); const value = MarketplaceListingSyncRequestViewSchema.parse(await response.json()); submitted = input; seen.loss(route.request(), value, input.requestKey!); await route.abort("failed"); }, { times: 1 });
      const draft = await review(page, source); await draft.getByRole("button", { name: "保存原同步任务", exact: true }).click();
      await expect(panel(page).getByRole("region", { name: "本人原同步请求恢复", exact: true })).toBeVisible(); await expect.poll(() => submitted !== undefined).toBe(true); await seen.idle();
      const saved = await snapshot(source); expect(saved.requests).toHaveLength(1); expect(saved.enqueueCalls).toEqual([saved.requests[0]!.id]); expect(saved.jobs).toHaveLength(1); expect(posts).toHaveLength(1);
      await open(page, source, seen, "recovery"); expect(posts).toHaveLength(1); evidence.phase = "read_original_receipt";
      const response = page.waitForResponse(value => new URL(value.url()).pathname === "/api/erp-listing-sync/receipt").then(async value => ({ status: value.status(), body: await value.json() as unknown }));
      await panel(page).getByRole("button", { name: "只读取原同步回执", exact: true }).click(); const restored = await response; expect(restored.status).toBe(200);
      const receipt = ListingSyncIntentReceiptSchema.parse(restored.body); expect(receipt.found).toBe(true); expect(receipt.request?.id).toBe(saved.requests[0]!.id); seen.request(receipt.request!, receipt.requestKey);
      expect(receipt.requestChecksum).toBe(sha(listingSyncIntentRequestText(submitted!))); expect(receipt.request?.listingVersionId).toBe(source.source.versionId);
      await expect(panel(page).getByRole("region", { name: "原同步请求详情", exact: true })).toContainText(receipt.request!.id);
      await control({ operation: "offline_result", groupId: source.groupId, requestId: receipt.request!.id });
      await panel(page).getByRole("button", { name: "重新读取原请求", exact: true }).click(); await expect(panel(page).getByRole("region", { name: "原同步事件 3", exact: true })).toBeVisible();
      const sealed = await snapshot(source); expect(sealed.events.at(-1)?.snapshotChecksum).toMatch(/^[a-f0-9]{64}$/); evidence.phase = "viewport_receipt";
      await screenshot(page, info, "original-receipt-desktop", false); await screenshot(page, info, "original-receipt-mobile", true); await seen.idle();
      const markers = await page.evaluate(prefix => Object.entries(sessionStorage).filter(([key]) => key.startsWith(prefix)).map(([, value]) => JSON.parse(value) as unknown), prefix);
      expect(markers).toHaveLength(1); expect(Object.keys(markers[0] as object).sort()).toEqual(["createdAt", "ownerScope", "requestChecksum", "requestId", "requestKey", "state", "version"]);
      expect(markers[0]).toMatchObject({ state: "known", requestId: receipt.request!.id, requestKey: submitted!.requestKey });
      expect(posts).toHaveLength(1); expect((await snapshot(source)).immutableBodySha).toBe(sealed.immutableBodySha); expect(sealed.providerCalls).toBe(0);
      expect(sealed.business.paid).toBe(before.business.paid); expect(sealed.business.publications).toBe(before.business.publications); evidence.phase = "completed"; evidence.after = sealed;
    } catch (error) { primary = error; } finally { await finish(info, page, source, seen, evidence, primary); }
  });

  test("blocks unreliable storage and discards a late original200 after actual personal read withdrawal", async ({ page }, info) => {
    const source = Seed.parse(await control({ operation: "seed" })), seen = await observe(page, source), evidence: Record<string, unknown> = { phase: "login", syntheticHistoricalPrerequisites: true }; let primary: unknown;
    const posts: Request[] = []; page.on("request", request => { if (request.method() === "POST" && new URL(request.url()).pathname === "/api/erp-listing-sync/requests") posts.push(request); });
    let release!: () => void; const gate = new Promise<void>(done => { release = done; }); let entered!: () => void; const held = new Promise<void>(done => { entered = done; });
    try {
      await open(page, source, seen, "login"); const before = await snapshot(source); const original = await session(page); seen.known(original.raw); evidence.phase = "storage_failure";
      await page.evaluate(prefix => { const key = "__listingIntentOriginalSetItem", target = window as unknown as Record<string, unknown>; target[key] = Storage.prototype.setItem;
        Storage.prototype.setItem = function (name, value) { if (name.startsWith(prefix)) throw new DOMException("Synthetic owned storage fault", "QuotaExceededError"); return Reflect.apply(target[key] as Storage["setItem"], this, [name, value]); }; }, prefix);
      let draft = await review(page, source); await draft.getByRole("button", { name: "保存原同步任务", exact: true }).click(); await expect(panel(page).getByRole("alert")).toBeVisible(); expect(posts).toHaveLength(0); expect((await snapshot(source)).requests).toEqual([]);
      await page.evaluate(() => { const target = window as unknown as Record<string, unknown>; Storage.prototype.setItem = target.__listingIntentOriginalSetItem as Storage["setItem"]; delete target.__listingIntentOriginalSetItem; });
      await seen.control("explicit_channels_remount", async () => { await seen.idle(); const nav = page.getByRole("navigation", { name: "刊登编辑区" }); await nav.getByRole("button", { name: "History", exact: true }).click(); await expect(panel(page)).toHaveCount(0);
        await nav.getByRole("button", { name: "Channels", exact: true }).click(); await expect(panel(page).getByRole("combobox", { name: /^已发布 Listing/ })).toBeEnabled(); await seen.idle(); });
      draft = await review(page, source); const submitted = page.waitForResponse(response => new URL(response.url()).pathname === "/api/erp-listing-sync/requests" && response.request().method() === "POST")
        .then(async response => ({ status: response.status(), body: await response.json() as unknown, input: CreateMarketplaceListingSyncInputSchema.parse(response.request().postDataJSON()) }));
      await draft.getByRole("button", { name: "保存原同步任务", exact: true }).click(); const response = await submitted; expect(response.status).toBe(201);
      const request = MarketplaceListingSyncRequestViewSchema.parse(response.body); seen.request(request, response.input.requestKey); await expect(panel(page).getByRole("region", { name: "原同步请求详情", exact: true })).toContainText(request.id); await seen.idle();
      await screenshot(page, info, "known-original-desktop", false); await screenshot(page, info, "known-original-mobile", true); const sealed = await snapshot(source); evidence.phase = "hold_original_read";
      await page.route(`**/api/erp-listing-sync/requests/${request.id}`, async route => { const value = await route.fetch(); expect(value.status()).toBe(200); expect(MarketplaceListingSyncRequestViewSchema.parse(await value.json()).id).toBe(request.id);
        seen.hold(route.request()); entered(); await gate; await route.fulfill({ response: value }).catch(() => {}); }, { times: 1 });
      await panel(page).getByRole("button", { name: "重新读取原请求", exact: true }).click(); await held; const start = Date.now(); await control({ operation: "rights", groupId: source.groupId, enabled: false });
      evidence.phase = "withdraw_personal_read"; const document = page.waitForRequest(value => value.isNavigationRequest() && value.resourceType() === "document" && value.frame() === page.mainFrame() && new URL(value.url()).pathname === `/listings/${source.source.listingId}`);
      const focus = Date.now(); await page.evaluate(() => window.dispatchEvent(new Event("focus"))); const navigation = await document;
      await expect(page.getByRole("heading", { name: /未找到刊登|刊登当前不可读取/ })).toBeVisible(); const fresh = await session(page); seen.known(fresh.raw); expect(fresh.hash).not.toBe(original.hash);
      const denied = await page.request.get(`/api/erp-listing-sync/workspace?listingId=${source.source.listingId}`, { headers: { "x-yummyai-context-authority": fresh.hash } }); expect(denied.status()).toBe(403);
      release(); await seen.idle(); seen.transition({ start, focus, end: Date.now(), old: original.hash, current: fresh.hash, document: navigation });
      await expect(page.getByRole("region", { name: "原同步请求详情", exact: true })).toHaveCount(0); await expect(page.getByRole("button", { name: "保存原同步任务", exact: true })).toHaveCount(0);
      await expect(page.getByText(source.source.title, { exact: true })).toHaveCount(0); const after = await snapshot(source); expect(after.immutableBodySha).toBe(sealed.immutableBodySha); expect(posts).toHaveLength(1);
      expect(after.providerCalls).toBe(0); expect(after.business.paid).toBe(before.business.paid); expect(after.business.publications).toBe(before.business.publications);
      const deniedPost = await page.request.post("/api/erp-listing-sync/requests", { headers: { origin: "http://localhost:3130", "x-yummyai-context-authority": fresh.hash }, data: response.input }); expect(deniedPost.status()).toBe(403);
      expect((await snapshot(source)).immutableBodySha).toBe(after.immutableBodySha); evidence.phase = "completed"; evidence.after = after; evidence.actualReadDenied = 403; evidence.actualPostDenied = 403;
    } catch (error) { primary = error; } finally { release?.(); await finish(info, page, source, seen, evidence, primary); }
  });
});
