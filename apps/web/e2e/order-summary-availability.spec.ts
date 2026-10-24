import { expect, test, type Locator, type Page, type Request, type TestInfo } from "@playwright/test";
import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { writeFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { z } from "zod";
import { ErpSessionViewSchema, erpSessionAuthority } from "@yummyai/contracts/auth/session";
import { OrderWorkSelectionInputSchema, OrderWorkSummariesSchema } from "@yummyai/contracts/order/workspace";
import { requireOrderSummaryEnvironment } from "../../../tools/testing/require-order-summary-availability-environment.mjs";
import { actors, loginErp } from "./erp-identity-fixture";

const isolated = requireOrderSummaryEnvironment(process.env, true);
const root = fileURLToPath(new URL("../../../", import.meta.url));
const sha = (value: string | Uint8Array) => createHash("sha256").update(value).digest("hex");
const Pins = z.object({ kind: z.enum(["healthy_saved", "healthy_no_work", "anonymized", "expired", "purged", "archived"]),
  accountId: z.uuidv7(), orderId: z.uuidv7(), lineId: z.uuidv7(), reportLineId: z.uuidv7().nullable(), reportVersionId: z.uuidv7().nullable(),
  externalOrderId: z.string().min(1).max(500), externalLineId: z.string().min(1).max(300), revision: z.int().nonnegative(), projectionVersion: z.int().nonnegative() }).strict();
type Case = z.infer<typeof Pins>;
const Seed = z.object({ type: z.literal("summary.browser.seeded"), mode: z.enum(["mixed", "late"]), nonce: z.literal(isolated.nonce), query: z.string().max(200),
  cases: z.array(Pins).min(1).max(6), resourcesClosed: z.literal(true), modelCalls: z.literal(0), workerProcesses: z.literal(0) }).strict();
const Transition = z.object({ type: z.literal("summary.browser.transitioned"), nonce: z.literal(isolated.nonce), orderId: z.uuidv7(), lineId: z.uuidv7(),
  action: z.literal("anonymize"), availability: z.literal("cleared"), resourcesClosed: z.literal(true) }).strict();
type ChildProof = { mode: "mixed" | "late" | "transition"; pid: number | null; exitCode: number | null; signal: string | null; resourcesClosed: boolean; stderrSha256: string };
async function originalHelper(mode: "mixed" | "late" | "transition", children: ChildProof[], source?: Case) {
  const child = spawn(process.execPath, ["--import", new URL("../../api/node_modules/tsx/dist/loader.mjs", import.meta.url).href,
    fileURLToPath(new URL("../../../tools/testing/order-summary-availability-browser.mts", import.meta.url)), mode], {
    cwd: root, env: { ...process.env, NODE_OPTIONS: "", TSX_DISABLE_CACHE: "1", TSX_TSCONFIG_PATH: fileURLToPath(new URL("../../api/tsconfig.json", import.meta.url)) },
    stdio: ["ignore", "pipe", "pipe", "ipc"], windowsHide: true,
  });
  const stderr = createHash("sha256"); child.stdout?.on("data", () => undefined); child.stderr?.on("data", chunk => stderr.update(chunk));
  const done = new Promise<{ exitCode: number | null; signal: string | null }>(resolve => child.once("exit", (exitCode, signal) => resolve({ exitCode, signal })));
  let packet: unknown;
  const result = new Promise<unknown>((resolve, reject) => {
    const timer = setTimeout(() => { child.kill(); reject(new Error("order_summary_browser_helper_timeout")); }, 90_000);
    child.once("error", error => { clearTimeout(timer); reject(error); });
    child.on("message", raw => { packet = raw; });
    child.once("exit", (exitCode, signal) => {
      clearTimeout(timer);
      if (exitCode !== 0 || signal !== null) {
        const failed = z.object({ type: z.literal("summary.browser.failed"), phase: z.string().regex(/^[a-z_]{1,64}$/),
          errorName: z.string().regex(/^[A-Za-z]{1,64}$/), code: z.string().regex(/^[A-Z0-9_]{1,64}$/).nullable() }).strict().safeParse(packet);
        reject(new Error(failed.success ? `order_summary_helper_failed:${failed.data.phase}:${failed.data.errorName}:${failed.data.code ?? "none"}` : "order_summary_helper_exit_failed"));
      } else resolve(packet);
    });
  });
  if (source) child.send({ nonce: isolated.nonce, action: "anonymize", case: source });
  try { return mode === "transition" ? Transition.parse(await result) : Seed.parse(await result); }
  finally {
    if (child.exitCode === null && child.signalCode === null) child.kill();
    const exit = await done;
    children.push({ mode, pid: child.pid ?? null, ...exit, resourcesClosed: Boolean(packet && typeof packet === "object" && "resourcesClosed" in packet && packet.resourcesClosed === true), stderrSha256: stderr.digest("hex") });
  }
}

const Audit = z.object({ key: z.string(), documentKey: z.string(), method: z.enum(["GET", "POST"]), urlHash: z.string().length(64), bodyHash: z.string().length(64).nullable(),
  startedAt: z.number(), resolvedAt: z.number().nullable(), status: z.number().int().nullable(), signalAbortAt: z.number().nullable(),
  signalAbortedAtResolve: z.boolean().nullable(), jsonStartedAt: z.number().nullable(), consumedAt: z.number().nullable(), errorAt: z.number().nullable(),
  errorName: z.enum(["AbortError", "TypeError", "Error", "Other"]).nullable(), summaryPins: z.array(z.object({ id: z.uuidv7(), revision: z.int().nonnegative(), sourceVersionId: z.uuidv7().nullable(),
    availability: z.enum(["available", "cleared", "expired", "archived", "failed"]).nullable() }).strict()).nullable() }).strict();
type ReadAudit = z.infer<typeof Audit>;
type Row = { request: Request; ordinal: number; method: string; path: string; urlHash: string; bodyHash: string | null; ids: string[] | null;
  at: number; status: number | null; terminalAt: number | null; finished: boolean; failed: string | null; watched: boolean; authorityHash: string | null;
  document: number; timing: { startTime: number; requestStart: number; responseStart: number; responseEnd: number } };
type Control = { kind: string; start: number; end: number | null };
async function observe(page: Page, source: z.infer<typeof Seed>) {
  const rows: Row[] = [], raw = new Map<Request, Row>(), audits = new Map<string, ReadAudit>(), controls: Control[] = [];
  const errors: Array<{ kind: string; name: string; hash: string }> = [], sessions: Array<{ at: number; document: number; authorityHash: string }> = [];
  const held = new Map<Request, { originalStatus: number; originalPacketSha256: string; sourceId: string; window: Control; releasedAt: number | null; freshClearConsumedAt: number | null }>();
  const compatibility: Array<{ request: Request; originalPacketSha256: string; modifiedPacketSha256: string }> = [];
  let generation = 0;
  const sourceIds = new Set(source.cases.map(value => value.lineId));
  await page.exposeBinding("__summaryAvailabilityAudit", (_binding, value: unknown) => { const parsed = Audit.parse(value); audits.set(parsed.key, parsed); });
  await page.addInitScript(() => {
    const native = window.fetch, documentKey = crypto.randomUUID(), pending = new Set<Promise<unknown>>(), auditFailures: unknown[] = [];
    const track = (task: Promise<unknown>) => {
      pending.add(task);
      void task.then(() => { pending.delete(task); }, error => { pending.delete(task); auditFailures.push(error); });
    };
    const emit = (value: unknown) => {
      const task = (window as unknown as { __summaryAvailabilityAudit(value: unknown): Promise<unknown> }).__summaryAvailabilityAudit(value);
      track(task);
    };
    const digest = async (value: string) => [...new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(value)))].map(byte => byte.toString(16).padStart(2, "0")).join("");
    (window as unknown as { __summaryAuditFlush(): Promise<void> }).__summaryAuditFlush = async () => {
      while (pending.size) await Promise.allSettled([...pending]);
      if (auditFailures.length) throw new AggregateError([...auditFailures], "summary_audit_failed");
    };
    window.fetch = function (...args: Parameters<typeof fetch>): ReturnType<typeof fetch> {
      const input = args[0], init = args[1], url = new URL(input instanceof Request ? input.url : String(input), location.href);
      const method = (init?.method ?? (input instanceof Request ? input.method : "GET")).toUpperCase();
      const watch = url.origin === location.origin && (url.pathname === "/api/order-centers/summaries" || url.pathname === "/api/order-centers/workspace" || url.pathname === "/api/erp-auth/session");
      if (!watch || method !== "GET" && method !== "POST") return native.apply(this, args);
      const signal = init?.signal ?? (input instanceof Request ? input.signal : null), body = typeof init?.body === "string" ? init.body : null;
      const value = { key: crypto.randomUUID(), documentKey, method: method as "GET" | "POST", urlHash: "", bodyHash: null as string | null,
        startedAt: performance.timeOrigin + performance.now(), resolvedAt: null as number | null, status: null as number | null,
        signalAbortAt: null as number | null, signalAbortedAtResolve: null as boolean | null, jsonStartedAt: null as number | null,
        consumedAt: null as number | null, errorAt: null as number | null, errorName: null as "AbortError" | "TypeError" | "Error" | "Other" | null,
        summaryPins: null as Array<{ id: string; revision: number; sourceVersionId: string | null; availability: "available" | "cleared" | "expired" | "archived" | "failed" | null }> | null };
      let updates = Promise.resolve();
      const initial = Promise.all([digest(url.href), body === null ? Promise.resolve(null) : digest(body)]).then(([urlHash, bodyHash]) => { value.urlHash = urlHash; value.bodyHash = bodyHash; });
      const report = () => {
        const task = updates.then(() => initial).then(() => emit({ ...value }));
        updates = task; track(task);
      };
      const failed = (cause: unknown) => { value.errorAt = performance.timeOrigin + performance.now();
        value.errorName = cause instanceof Error && ["AbortError", "TypeError", "Error"].includes(cause.name) ? cause.name as "AbortError" | "TypeError" | "Error" : "Other"; report(); };
      signal?.addEventListener("abort", () => { value.signalAbortAt = performance.timeOrigin + performance.now(); report(); }, { once: true });
      const original = native.apply(this, args);
      void original.then(response => {
        value.resolvedAt = performance.timeOrigin + performance.now(); value.status = response.status; value.signalAbortedAtResolve = Boolean(signal?.aborted); report();
        const json = response.json.bind(response);
        response.json = () => {
          value.jsonStartedAt = performance.timeOrigin + performance.now(); report();
          const consumed = json();
          void consumed.then((packet: unknown) => {
            value.consumedAt = performance.timeOrigin + performance.now();
            if (url.pathname === "/api/order-centers/summaries" && packet && typeof packet === "object" && "items" in packet && Array.isArray(packet.items)) {
              value.summaryPins = packet.items.map((item: unknown) => {
                if (!item || typeof item !== "object" || !("id" in item) || !("revision" in item) || !("sourceVersionId" in item)
                  || typeof item.id !== "string" || !/^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/.test(item.id)
                  || typeof item.revision !== "number" || !Number.isInteger(item.revision) || item.revision < 0
                  || item.sourceVersionId !== null && (typeof item.sourceVersionId !== "string" || !/^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/.test(item.sourceVersionId))) throw new Error("summary_audit_invalid_pin");
                const availability = "availability" in item && typeof item.availability === "string" && ["available", "cleared", "expired", "archived", "failed"].includes(item.availability)
                  ? item.availability as "available" | "cleared" | "expired" | "archived" | "failed" : null;
                return { id: item.id, revision: item.revision, sourceVersionId: item.sourceVersionId, availability };
              });
            }
            report();
          }, failed);
          return consumed;
        };
      }, failed);
      report(); return original;
    };
  });
  page.on("request", request => {
    const url = new URL(request.url());
    if (url.origin !== "http://localhost:3130") return;
    if (request.isNavigationRequest() && request.resourceType() === "document" && request.frame() === page.mainFrame()) generation++;
    const body = request.postData(), headers = request.headers();
    const watched = ["/api/order-centers/summaries", "/api/order-centers/workspace", "/api/erp-auth/session"].includes(url.pathname);
    let ids: string[] | null = null;
    if (request.method() === "POST" && url.pathname === "/api/order-centers/summaries") {
      const parsed = OrderWorkSelectionInputSchema.safeParse(request.postDataJSON());
      if (!parsed.success || url.search || new Set(parsed.data.ids).size !== parsed.data.ids.length || parsed.data.ids.some(id => !sourceIds.has(id)))
        errors.push({ kind: "unexpected_summary_target", name: "strict_original_ids", hash: sha(body ?? "") });
      else ids = parsed.data.ids;
    }
    const row: Row = { request, ordinal: rows.length + 1, method: request.method(), path: url.pathname, urlHash: sha(url.href), bodyHash: body === null ? null : sha(body), ids,
      at: Date.now(), status: null, terminalAt: null, finished: false, failed: null, watched,
      authorityHash: headers["x-yummyai-context-authority"] ? sha(headers["x-yummyai-context-authority"]) : null,
      document: generation, timing: request.timing() };
    rows.push(row); raw.set(request, row);
  });
  page.on("response", response => { const row = raw.get(response.request()); if (row) row.status = response.status(); });
  page.on("requestfinished", request => { const row = raw.get(request); if (row) { row.finished = true; row.terminalAt = Date.now(); row.timing = request.timing(); } });
  page.on("requestfailed", request => { const row = raw.get(request); if (row) { row.failed = request.failure()?.errorText ?? "unknown"; row.terminalAt = Date.now(); row.timing = request.timing(); } });
  page.on("pageerror", error => errors.push({ kind: "pageerror", name: error.name, hash: sha(error.message) }));
  page.on("console", message => { if (message.type() === "error") errors.push({ kind: "console", name: "error", hash: sha(message.text()) }); });
  const flush = () => page.evaluate(async () => { await (window as unknown as { __summaryAuditFlush?: () => Promise<void> }).__summaryAuditFlush?.(); });
  const positivePair = (row: Row) => {
    const found = [...audits.values()].filter(value => value.method === row.method && value.urlHash === row.urlHash && value.bodyHash === row.bodyHash
      && row.timing.startTime > 0 && Math.abs(value.startedAt - row.timing.startTime) < 5);
    return found.length === 1 ? found[0]! : null;
  };
  const preHeaderSummaryAbort = (row: Row) => source.mode === "late" && row.watched && row.method === "POST"
    && row.path === "/api/order-centers/summaries" && row.ids?.length === 1 && row.ids[0] === source.cases[0]!.lineId
    && row.bodyHash !== null && row.status === null && !row.finished && row.failed === "net::ERR_ABORTED" && row.terminalAt !== null
    && row.timing.startTime === 0 && row.timing.requestStart === -1 && row.timing.responseStart === -1 && row.timing.responseEnd === -1;
  const matching = (row: Row) => {
    const direct = positivePair(row);
    if (direct) return { audit: direct, evidence: { ordinal: row.ordinal, auditKey: direct.key, basis: "positive_cdp_start" as const,
      requestTime: row.timing.startTime, requestEventAt: row.at, rawTiming: { ...row.timing },
      originalFetchStartedAt: direct.startedAt, differenceMs: row.timing.startTime - direct.startedAt } };
    if (!preHeaderSummaryAbort(row)) return null;
    const windows = controls.filter(value => value.kind === "late_original_anonymization" && value.end !== null
      && row.at >= value.start && row.terminalAt! <= value.end);
    if (windows.length !== 1) return null;
    const window = windows[0]!, before = sessions.filter(value => value.document === row.document && value.at <= row.at).at(-1),
      after = sessions.find(value => value.document === row.document && value.at >= row.terminalAt! && value.at <= window.end!);
    if (!before || !after || before.authorityHash !== after.authorityHash
      || sessions.some(value => value.document === row.document && value.at >= before.at && value.at <= after.at && value.authorityHash !== before.authorityHash)) return null;
    // Anchor the document through completed original consumers with positive
    // CDP timing, never through a cancelled request's inferred completion.
    const anchors = rows.flatMap(other => {
      if (other.document !== row.document || other.method !== row.method || other.urlHash !== row.urlHash || other.bodyHash !== row.bodyHash
        || other.authorityHash !== row.authorityHash || other.timing.startTime <= 0) return [];
      const value = positivePair(other);
      if (!value || value.consumedAt === null || value.resolvedAt === null || value.status !== 201 || value.status !== other.status
        || value.signalAbortedAtResolve || value.signalAbortAt !== null && value.signalAbortAt <= value.consumedAt
        || value.errorAt !== null && value.errorAt <= value.consumedAt) return [];
      const pin = value.summaryPins?.length === 1 ? value.summaryPins[0] : null;
      if (!pin || pin.id !== source.cases[0]!.lineId || pin.revision !== source.cases[0]!.revision
        || !(pin.availability === "available" && pin.sourceVersionId === source.cases[0]!.reportVersionId
          || pin.availability === "cleared" && pin.sourceVersionId === null)) return [];
      return [{ ordinal: other.ordinal, auditKey: value.key, documentKey: value.documentKey, consumedAt: value.consumedAt, availability: pin.availability }];
    });
    const documentKeys = new Set(anchors.map(value => value.documentKey));
    if (documentKeys.size !== 1 || !anchors.some(value => value.availability === "available" && value.consumedAt <= row.at)
      || !anchors.some(value => value.availability === "cleared" && value.consumedAt >= row.terminalAt! && value.consumedAt <= window.end!)) return null;
    const found = [...audits.values()].filter(value => value.method === row.method && value.urlHash === row.urlHash && value.bodyHash === row.bodyHash
      && documentKeys.has(value.documentKey) && Math.abs(value.startedAt - row.at) < 5 && value.startedAt >= window.start
      && value.status === null && value.resolvedAt === null && value.signalAbortedAtResolve === null && value.jsonStartedAt === null
      && value.consumedAt === null && value.summaryPins === null && value.signalAbortAt !== null && value.errorName === "AbortError" && value.errorAt !== null
      && value.startedAt <= value.signalAbortAt && value.signalAbortAt <= value.errorAt && value.errorAt <= window.end!);
    if (found.length !== 1) return null;
    const original = found[0]!;
    const reverse = rows.filter(other => {
      if (other.document !== row.document || other.method !== row.method || other.urlHash !== row.urlHash || other.bodyHash !== row.bodyHash
        || other.authorityHash !== row.authorityHash) return false;
      const time = other.timing.startTime > 0 ? other.timing.startTime : preHeaderSummaryAbort(other) ? other.at : null;
      return time !== null && Math.abs(original.startedAt - time) < 5;
    });
    if (reverse.length !== 1 || reverse[0] !== row) return null;
    return { audit: original, evidence: { ordinal: row.ordinal, auditKey: original.key, basis: "pre_header_request_event" as const,
      requestTime: row.at, requestEventAt: row.at, requestTerminalAt: row.terminalAt, rawTiming: { ...row.timing },
      originalFetchStartedAt: original.startedAt, originalSignalAbortAt: original.signalAbortAt, originalErrorAt: original.errorAt,
      differenceMs: row.at - original.startedAt, uniqueAuditCount: found.length, uniqueRequestCount: reverse.length,
      document: row.document, documentKey: original.documentKey, anchors, authorityHash: before.authorityHash,
      previousSession: { ...before }, nextSession: { ...after }, control: { kind: window.kind, start: window.start, end: window.end } } };
  };
  const pair = (row: Row) => matching(row)?.audit ?? null;
  const consumed = (row: Row) => {
    const value = pair(row);
    return value && value.consumedAt !== null && value.status === row.status && value.resolvedAt !== null && value.status !== null
      && !value.signalAbortedAtResolve && (value.signalAbortAt === null || value.signalAbortAt > value.consumedAt)
      && (value.errorAt === null || value.errorAt > value.consumedAt) ? value : null;
  };
  async function current() {
    const response = await page.request.get("/api/erp-auth/session"); expect(response.status()).toBe(200);
    const session = ErpSessionViewSchema.parse(await response.json());
    expect(session.userId).toBe(actors().operator.userId); expect(session.tenantId).toBe(actors().operator.tenantId);
    sessions.push({ at: Date.now(), document: generation, authorityHash: sha(erpSessionAuthority(session)) }); return session;
  }
  async function stable() {
    await expect.poll(() => rows.filter(row => row.watched && !held.has(row.request) && row.terminalAt === null).length).toBe(0);
    await flush(); await page.evaluate(() => new Promise<void>(resolve => requestAnimationFrame(() => requestAnimationFrame(() => resolve())))); await flush();
  }
  async function control<T>(kind: string, action: () => Promise<T>) {
    const window: Control = { kind, start: Date.now(), end: null }; controls.push(window);
    try { return await action(); } finally { await stable(); await current(); window.end = Date.now(); }
  }
  function check() {
    const unclassified: number[] = [], classifications: Array<{ ordinal: number; kind: string; auditKey?: string; successor?: number }> = [];
    for (const row of rows) {
      if (row.status !== null && row.status >= 400) unclassified.push(row.ordinal);
      if (row.method !== "GET" && row.method !== "HEAD" && row.path.startsWith("/api/") && !(row.method === "POST" && row.path === "/api/order-centers/summaries" && row.ids)) unclassified.push(row.ordinal);
      // Other Next/RSC transports are retained as raw observations; this slice
      // does not infer their EOF or use them as proof of private data adoption.
      if (!row.watched) continue;
      if (!row.failed && row.finished) { if (row.path === "/api/order-centers/summaries" && !consumed(row)) unclassified.push(row.ordinal); continue; }
      const read = pair(row), complete = consumed(row);
      if (row.failed === "net::ERR_ABORTED" && complete && complete.consumedAt! <= (row.terminalAt ?? 0)) {
        classifications.push({ ordinal: row.ordinal, kind: "original_json_consumer_before_transport_abort", auditKey: complete.key }); continue;
      }
      const expected = held.get(row.request);
      const freshRows = expected ? rows.filter(other => other !== row && other.document === row.document && other.method === row.method
        && other.urlHash === row.urlHash && other.bodyHash === row.bodyHash && other.ids?.length === 1 && other.ids[0] === expected.sourceId
        && other.at > row.at && consumed(other)?.summaryPins?.some(pin => pin.id === expected.sourceId && pin.availability === "cleared")) : [];
      const fresh = freshRows.length === 1 ? consumed(freshRows[0]!) : null;
      const previousSession = sessions.filter(value => value.document === row.document && value.at <= row.at).at(-1);
      const finalSession = sessions.filter(value => value.document === row.document && expected && value.at >= expected.freshClearConsumedAt!
        && value.at <= (expected.window.end ?? 0)).at(-1);
      if (expected && expected.originalStatus === 201 && expected.freshClearConsumedAt !== null && expected.releasedAt !== null
        && expected.freshClearConsumedAt < expected.releasedAt && expected.window.end !== null && row.at >= expected.window.start
        && (row.terminalAt ?? Infinity) <= expected.window.end && read && read.signalAbortAt !== null
        && row.ids?.length === 1 && row.ids[0] === expected.sourceId && fresh && fresh.status === 201 && fresh.documentKey === read.documentKey
        && fresh.consumedAt === expected.freshClearConsumedAt && previousSession && finalSession && previousSession.authorityHash === finalSession.authorityHash
        && (read.errorName === "AbortError" || read.consumedAt !== null)) {
        classifications.push({ ordinal: row.ordinal, kind: "controlled_discarded_original_available_response", auditKey: read.key, successor: freshRows[0]!.ordinal }); continue;
      }
      if (row.failed === "net::ERR_ABORTED" && row.status === null && read && read.status === null && read.resolvedAt === null && read.jsonStartedAt === null
        && read.consumedAt === null && read.signalAbortAt !== null && read.errorName === "AbortError" && read.errorAt !== null) {
        const window = controls.find(value => row.at >= value.start && row.terminalAt !== null && value.end !== null && row.terminalAt <= value.end);
        const successor = rows.find(other => other.ordinal > row.ordinal && other.document === row.document && other.method === row.method
          && other.urlHash === row.urlHash && other.bodyHash === row.bodyHash);
        const next = successor ? consumed(successor) : null;
        const sameSessions = sessions.filter(value => value.document === row.document && window && value.at >= window.start && value.at <= window.end!);
        if (window && successor && next && next.documentKey === read.documentKey && successor.at >= read.signalAbortAt
          && new Set(sameSessions.map(value => value.authorityHash)).size === 1) {
          classifications.push({ ordinal: row.ordinal, kind: "original_signal_abort_replaced_by_same_read_consumer", auditKey: read.key, successor: successor.ordinal }); continue;
        }
      }
      unclassified.push(row.ordinal);
    }
    return { unclassified: [...new Set(unclassified)], classifications };
  }
  return { rows, controls, audits, held, compatibility, current, stable, control, consumed, pair, flush, check, errors,
    proof() { return { scope: "original_summary_list_identity_and_report_images_no_business_UI_writes", requests: rows.map(({ request: _request, ...row }) => { void _request; return row; }),
      readAudit: [...audits.values()], pairingEvidence: rows.flatMap(row => { const value = matching(row); return value ? [value.evidence] : []; }),
      controls, sessions, errors, ...check(), held: [...held].map(([request, value]) => ({ ordinal: raw.get(request)?.ordinal, ...value })),
      compatibility: compatibility.map(({ request, ...value }) => ({ ordinal: raw.get(request)?.ordinal, ...value })) }; } };
}

type Observation = Awaited<ReturnType<typeof observe>>;
const rowFor = (page: Page, value: Case) => page.getByRole("article", { name: new RegExp(`^商品 ${value.externalLineId} `) });
async function loaded(page: Page) { await expect(page.getByRole("heading", { name: "订单中心", exact: true })).toBeVisible(); await expect(page.locator("main.oc-page")).toHaveAttribute("aria-busy", "false"); }
async function state(page: Page, value: Case, expected: string) {
  const row = rowFor(page, value); await expect(row).toBeVisible(); await expect(row).toHaveAttribute("data-summary-availability", expected);
  if (expected !== "available") {
    await expect(row.locator("img")).toHaveCount(0); await expect(row.getByRole("button", { name: "展开编辑", exact: true })).toHaveCount(0);
    await expect(row.getByRole("checkbox")).toBeDisabled();
    expect((await row.textContent())?.includes(`synthetic-private-${value.externalOrderId}`)).toBe(false);
    await expect(row.getByRole("button", { name: "查看订单历史", exact: true })).toBeVisible();
  }
}
async function imagesReady(row: Locator) {
  const images = row.locator("img"), count = await images.count();
  expect(count).toBeGreaterThan(0);
  for (let index = 0; index < count; index++) {
    const image = images.nth(index);
    await expect(image).toBeVisible(); await image.scrollIntoViewIfNeeded();
    await expect.poll(() => image.evaluate(element => element instanceof HTMLImageElement && element.complete && element.naturalWidth > 0)).toBe(true);
  }
}
async function twoWidths(page: Page, info: TestInfo, label: string) {
  for (const viewport of [{ width: 1440, height: 960 }, { width: 390, height: 844 }]) {
    await page.setViewportSize(viewport);
    await expect.poll(() => page.locator(".oc-order-list").evaluate(element => {
      const animatedStates = [...element.querySelectorAll(".oc-summary-status,.oc-summary-available,.oc-summary-selection-notice")]
        .filter(node => node instanceof HTMLElement && node.getClientRects().length > 0);
      return animatedStates.length > 0 && animatedStates.every(node => Number(getComputedStyle(node).opacity) >= 0.999)
        && document.getAnimations().every(animation => animation.playState !== "running" || animation.effect?.getComputedTiming().iterations === Infinity);
    })).toBe(true);
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth + 1)).toBe(true);
    await page.screenshot({ path: info.outputPath(`${label}-${viewport.width}.png`), fullPage: true });
  }
  await page.emulateMedia({ reducedMotion: "reduce" });
  expect(await page.evaluate(() => matchMedia("(prefers-reduced-motion: reduce)").matches)).toBe(true);
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth + 1)).toBe(true);
  await page.emulateMedia({ reducedMotion: "no-preference" });
}
async function finalize(info: TestInfo, seen: Observation | undefined, children: ChildProof[], primary: unknown, detail: object) {
  const failures: unknown[] = primary ? [primary] : []; let networkFailed = false, cleanupFailed = false;
  if (seen) try { await seen.stable(); expect(seen.errors).toEqual([]); expect(seen.check().unclassified).toEqual([]); }
  catch (error) { networkFailed = true; failures.push(error); }
  try { expect(children.every(child => child.exitCode === 0 && child.signal === null && child.resourcesClosed)).toBe(true); }
  catch (error) { cleanupFailed = true; failures.push(error); }
  await writeFile(info.outputPath("order-summary-availability-proof.json"), JSON.stringify({ nonce: isolated.nonce,
    scope: "compiled_personal_actual_original_owners_synthetic_reports_no_worker_or_model", primaryFailure: Boolean(primary), networkFailed, cleanupFailed,
    primaryDiagnostic: primary instanceof Error ? { name: primary.name, messageSha256: sha(primary.message) } : primary ? { name: "Other", messageSha256: null } : null,
    children, ...detail, network: seen?.proof() }, null, 2));
  if (failures.length) throw new AggregateError(failures, "order_summary_browser_failed");
}

test("mixed original summaries distinguish retained and cleared history at 1440 and 390", async ({ page }, info) => {
  const children: ChildProof[] = []; let seen: Observation | undefined, primary: unknown, source: z.infer<typeof Seed> | undefined;
  try {
    source = Seed.parse(await originalHelper("mixed", children)); expect(source.cases.length).toBe(6);
    seen = await observe(page, source); const audit = seen, saved = source.cases.find(value => value.kind === "healthy_saved")!;
    await audit.control("personal_mixed_original_orders", async () => {
      await loginErp(page, "operator", "/navigation");
      await page.goto(`/orders?${new URLSearchParams({ q: source!.query })}`); await loaded(page); await audit.current();
      expect(new URL(page.url()).searchParams.get("q")).toBe(source!.query);
      for (const value of source!.cases.filter(value => value.kind !== "archived")) await state(page, value,
        value.kind === "healthy_saved" || value.kind === "healthy_no_work" ? "available" : value.kind === "expired" ? "expired" : "cleared");
      const healthy = rowFor(page, saved); await healthy.locator(".oc-row-context > summary").click();
      await imagesReady(healthy);
      expect((await healthy.textContent())?.includes(`synthetic-private-${saved.externalOrderId}`)).toBe(true);
      await twoWidths(page, info, "mixed-original-states");
    });
    const archived = source.cases.find(value => value.kind === "archived")!;
    await audit.control("original_archived_history_read_only", async () => {
      await page.goto(`/orders?${new URLSearchParams({ q: source!.query, archived: "only" })}`); await loaded(page); await state(page, archived, "archived");
    });
    await audit.control("transport_compatibility_negative_missing_availability", async () => {
      await page.route("**/api/order-centers/summaries", async route => {
        const response = await route.fetch(); expect(response.status()).toBe(201);
        const original = OrderWorkSummariesSchema.parse(await response.json());
        const packet = { items: original.items.map(({ availability: _availability, ...item }) => { void _availability; return item; }) };
        OrderWorkSummariesSchema.parse(packet);
        audit.compatibility.push({ request: route.request(), originalPacketSha256: sha(JSON.stringify(original)), modifiedPacketSha256: sha(JSON.stringify(packet)) });
        await route.fulfill({ response, json: packet });
      });
      try {
        await page.goto(`/orders?${new URLSearchParams({ q: source!.query })}`); await loaded(page);
        for (const value of source!.cases.filter(value => value.kind !== "archived")) await state(page, value, "unknown");
      } finally { await page.unroute("**/api/order-centers/summaries"); }
    });
  } catch (error) { primary = error; }
  await finalize(info, seen, children, primary, { cases: source?.cases, compatibilityNegative: "actual_original_201_only_availability_removed_not_business_state_proof" });
});

test("late original anonymization clears current private summaries and never adopts the held old response", async ({ page }, info) => {
  const children: ChildProof[] = []; let seen: Observation | undefined, primary: unknown, source: z.infer<typeof Seed> | undefined;
  let initialPreviewValidatedAndClosed = false;
  let release: (() => void) | undefined; const routeFailures: unknown[] = [];
  try {
    source = Seed.parse(await originalHelper("late", children)); const value = source.cases[0]!;
    seen = await observe(page, source); const audit = seen;
    await audit.control("personal_original_available_summary", async () => {
      await loginErp(page, "operator", "/navigation");
      await page.goto(`/orders?${new URLSearchParams({ q: source!.query })}`); await loaded(page); await audit.current();
      expect(new URL(page.url()).searchParams.get("q")).toBe(source!.query);
      await state(page, value, "available"); await rowFor(page, value).locator(".oc-row-context > summary").click();
      await imagesReady(rowFor(page, value));
      await rowFor(page, value).locator(".oc-product-media").getByRole("button", { name: "预览 display-1.png", exact: true }).click();
      const preview = page.getByRole("dialog", { name: "商品图片预览", exact: true });
      await expect(preview).toBeVisible();
      await preview.getByRole("button", { name: "关闭图片预览", exact: true }).click();
      await expect(preview).not.toBeVisible();
      initialPreviewValidatedAndClosed = true;
    });
    let enter!: () => void, finish!: () => void;
    const entered = new Promise<void>(resolve => { enter = resolve; }), finished = new Promise<void>(resolve => { finish = resolve; });
    const released = new Promise<void>(resolve => { release = resolve; });
    const window: Control = { kind: "late_original_anonymization", start: Date.now(), end: null }; audit.controls.push(window);
    let intercepted = false, originalRequest: Request | undefined;
    await page.route("**/api/order-centers/summaries", async route => {
      if (intercepted) { await route.continue(); return; } intercepted = true;
      try {
        const response = await route.fetch(); expect(response.status()).toBe(201);
        const packet = OrderWorkSummariesSchema.parse(await response.json());
        expect(packet.items.length).toBe(1); expect(packet.items[0]).toMatchObject({ id: value.lineId, sourceVersionId: value.reportVersionId, availability: "available", error: null });
        originalRequest = route.request(); audit.held.set(originalRequest, { originalStatus: response.status(), originalPacketSha256: sha(JSON.stringify(packet)), sourceId: value.lineId,
          window, releasedAt: null, freshClearConsumedAt: null }); enter(); await released;
        await route.fulfill({ response });
      } catch (error) { routeFailures.push(error); enter(); } finally { finish(); }
    });
    await page.getByRole("button", { name: "刷新", exact: true }).click(); await entered;
    expect(originalRequest !== undefined && routeFailures.length === 0).toBe(true);
    const transition = Transition.parse(await originalHelper("transition", children, value)); expect(transition.lineId).toBe(value.lineId);
    await page.getByRole("button", { name: "刷新", exact: true }).click(); await loaded(page); await state(page, value, "cleared");
    await expect(page.getByRole("dialog", { name: "商品图片预览", exact: true })).not.toBeVisible();
    await audit.flush();
    const clear = [...audit.audits.values()].filter(read => read.consumedAt !== null && read.summaryPins?.some(pin => pin.id === value.lineId && pin.availability === "cleared"));
    expect(clear.length).toBeGreaterThan(0);
    const held = audit.held.get(originalRequest!)!; held.freshClearConsumedAt = Math.max(...clear.map(read => read.consumedAt!)); held.releasedAt = Date.now();
    release!(); await finished; await audit.stable(); await audit.current(); window.end = Date.now();
    expect(routeFailures.length).toBe(0); await state(page, value, "cleared");
    expect((await page.locator("main.oc-page").textContent())?.includes(`synthetic-private-${value.externalOrderId}`)).toBe(false);
    await audit.control("cleared_original_history_visual", () => twoWidths(page, info, "late-original-clear"));
  } catch (error) { primary = error; }
  finally { release?.(); await page.unroute("**/api/order-centers/summaries"); }
  await finalize(info, seen, children, primary, { cases: source?.cases, routeFailureCount: routeFailures.length, initialPreviewValidatedAndClosed,
    previewCloseMode: "operator_UI_before_refresh", lateResponseScope: "original_summary_private_text_and_thumbnails", privateMutation: "actual_original_anonymize_owner" });
});
