import { expect, test, type Page, type Request, type TestInfo, type Locator } from "@playwright/test";
import { createHash } from "node:crypto";
import { readFile, realpath, writeFile } from "node:fs/promises";
import { isAbsolute, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { z } from "zod";
import { ErpSessionViewSchema, erpSessionAuthority } from "@yummyai/contracts/auth/session";
import { MarketplaceAuthorityWorkspaceSchema, type MarketplaceAuthorityWorkspace } from "@yummyai/contracts/marketplace/authority";
import { requireMarketplaceAuthorityEnvironment } from "../../../tools/testing/require-marketplace-authority-environment.mjs";
import { MarketplaceOAuthBindingSchema, marketplaceOAuthCookieName, marketplaceOAuthPendingStateDigest,
  marketplaceOAuthStateDigest } from "../src/features/marketplaces/marketplace-oauth";
import { actors, loginErp } from "./erp-identity-fixture";

const { nonce } = requireMarketplaceAuthorityEnvironment(process.env, "current", true);
const sha = (value: string) => createHash("sha256").update(value).digest("hex");
const Id = z.uuidv7(), Seed = z.object({ groupId: Id, ids: z.array(Id).min(1).max(3), actorId: Id, tenantId: Id }).strict();
type Source = z.infer<typeof Seed>;
const Snapshot = z.object({ ids: z.array(Id), counts: z.object({ oauth: z.int(), private: z.int(), refresh: z.int(), read: z.int(), rejected: z.int() }).strict(),
  business: z.object({ paid: z.int(), publications: z.int(), listingSyncs: z.int() }).strict(),
  accounts: z.array(z.object({ id: Id, status: z.string(), generation: z.uuid(), refreshState: z.enum(["known", "pending", "unknown"]),
    useId: z.uuid().nullable(), credentialVersion: z.int().nullable(), credentialHash: z.string().regex(/^[a-f0-9]{64}$/).nullable(), snapshots: z.int() }).strict()),
}).strict();
const Info = z.object({ nonce: z.literal(nonce), pid: z.int().positive(), origin: z.url(), key: z.string().regex(/^[A-Za-z0-9_-]{43}$/) }).strict();
async function control(input: Record<string, unknown>) {
  const path = fileURLToPath(new URL(`../../../tmp/marketplace-authority-20261022-d8b7a3c6/qa/provider-${nonce}.json`, import.meta.url));
  const info = Info.parse(JSON.parse(await readFile(path, "utf8"))), url = new URL(info.origin);
  if (url.protocol !== "http:" || url.hostname !== "127.0.0.1" || url.pathname !== "/" || url.search || url.hash) throw new Error("authority_control_origin_invalid");
  const response = await fetch(url, { method: "POST", headers: { "content-type": "application/json", "x-fixture-control": info.key },
    body: JSON.stringify(input), redirect: "error", signal: AbortSignal.timeout(30000) });
  if (response.status !== 200) { await response.body?.cancel(); throw new Error("authority_control_rejected"); }
  return await response.json() as unknown;
}
const snapshot = async (source: Source) => Snapshot.parse(await control({ operation: "snapshot", groupId: source.groupId }));
const lifecycle = (page: Page) => page.getByRole("region", { name: "店铺授权状态", exact: true });
const lifecycleExports = { sync: "syncMarketplaceCapabilities", revoke: "revokeMarketplaceAuthorization",
  private: "authorizeAmazonPrivate", disable: "setMarketplaceAccountEnabled" } as const;
type ActionKind = keyof typeof lifecycleExports;
type ActionExport = "startMarketplaceOAuth" | typeof lifecycleExports[ActionKind];
type ActionReference<T extends ActionExport = ActionExport> = { id: string; hash: string; candidateId: string; exportedName: T };
type OAuthAction = ActionReference<"startMarketplaceOAuth">;
type LifecycleReferences = Record<ActionKind, ActionReference>;
async function compiledAction<T extends ActionExport>(exportedName: T): Promise<ActionReference<T>> {
  const cwd = process.env.KNOWLEDGE_BROWSER_CWD, root = fileURLToPath(new URL("../../../", import.meta.url));
  if (!cwd || !isAbsolute(cwd)) throw new Error("authority_oauth_candidate_missing");
  const directory = resolve(cwd), candidate = /^\.artifacts\/local-web-releases\/([a-f0-9]{32})\/apps\/web$/.exec(relative(root, directory).replaceAll("\\", "/"));
  if (!candidate || (await realpath(directory)).toLowerCase() !== directory.toLowerCase()) throw new Error("authority_oauth_candidate_invalid");
  const candidateRoot = resolve(directory, "../.."), metadata = z.object({ id: z.literal(candidate[1]!), status: z.literal("built"), scope: z.literal("local-web-runtime"),
    buildId: z.string().min(1), artifacts: z.array(z.object({ path: z.string(), sha256: z.string().regex(/^[a-f0-9]{64}$/), bytes: z.int().nonnegative() }).passthrough()),
  }).passthrough().parse(JSON.parse(await readFile(resolve(candidateRoot, "manifest.json"), "utf8")));
  if ((await readFile(resolve(directory, ".next/BUILD_ID"), "utf8")).trim() !== metadata.buildId) throw new Error("authority_oauth_candidate_build_changed");
  const bytes = await readFile(resolve(directory, ".next/server/server-reference-manifest.json"));
  const pinned = metadata.artifacts.filter(entry => entry.path === ".next/server/server-reference-manifest.json");
  if (pinned.length !== 1 || pinned[0]!.bytes !== bytes.length || pinned[0]!.sha256 !== createHash("sha256").update(bytes).digest("hex"))
    throw new Error("authority_oauth_candidate_reference_changed");
  const manifest: unknown = JSON.parse(bytes.toString("utf8"));
  const record = (value: unknown): value is Record<string, unknown> => Boolean(value && typeof value === "object" && !Array.isArray(value));
  if (!record(manifest)) throw new Error("authority_oauth_reference_invalid");
  const matches: string[] = [];
  for (const runtime of ["node", "edge"]) {
    const entries = manifest[runtime]; if (!record(entries)) continue;
    for (const [id, entry] of Object.entries(entries)) {
      if (!record(entry) || entry.exportedName !== exportedName || typeof entry.filename !== "string" || !record(entry.workers) ||
        !Object.hasOwn(entry.workers, "app/(erp)/stores/[accountId]/page")) continue;
      const filename = entry.filename.replaceAll("\\", "/");
      if (!["src/features/marketplaces/marketplace-actions.ts", "./src/features/marketplaces/marketplace-actions.ts"].includes(filename) &&
        !filename.endsWith("/apps/web/src/features/marketplaces/marketplace-actions.ts")) continue;
      if (!/^[a-f0-9]{40,64}$/.test(id)) throw new Error("authority_oauth_reference_id_invalid"); matches.push(id);
    }
  }
  if (matches.length !== 1) throw new Error("authority_oauth_reference_not_unique");
  return { id: matches[0]!, hash: sha(matches[0]!), candidateId: metadata.id, exportedName };
}
const oauthAction = () => compiledAction("startMarketplaceOAuth");
async function lifecycleActions(): Promise<LifecycleReferences> {
  const [sync, revoke, privateAction, disable] = await Promise.all([compiledAction(lifecycleExports.sync), compiledAction(lifecycleExports.revoke),
    compiledAction(lifecycleExports.private), compiledAction(lifecycleExports.disable)]);
  return { sync, revoke, private: privateAction, disable };
}
async function personal(page: Page) {
  const response = await page.request.get("/api/erp-auth/session"); expect(response.status()).toBe(200);
  const view = ErpSessionViewSchema.parse(await response.json()), actor = actors().operator;
  expect(view.userId).toBe(actor.userId); expect(view.tenantId).toBe(actor.tenantId); return view;
}
async function authority(page: Page, id: string) {
  const session = await personal(page), digest = sha(erpSessionAuthority(session));
  const response = await page.request.get(`/api/marketplace-accounts/${id}/authority`, { headers: { "x-yummyai-context-authority": digest } });
  expect(response.status()).toBe(200); const view = MarketplaceAuthorityWorkspaceSchema.parse(await response.json());
  expect(view.account.id).toBe(id); expect(view.context).toEqual({ actorId: session.userId, tenantId: session.tenantId, authority: digest });
  expect(response.headers()["x-yummyai-context-authority"]).toBe(digest); return view;
}

const authorityPath = /^\/api\/marketplace-accounts\/[a-f0-9-]{36}\/authority$/;
const detailPath = /^\/stores\/[a-f0-9-]{36}$/;
const QueryVariant = z.enum(["none", "oauth_success", "unsupported"]);
const ReadAudit = z.object({ documentAt: z.number().positive(), sequence: z.int().positive(), start: z.number().positive(), path: z.string(),
  method: z.enum(["GET", "POST"]), queryVariant: QueryVariant, actionKind: z.enum(["sync", "revoke", "private", "disable"]).nullable(),
  actionHash: z.string().regex(/^[a-f0-9]{64}$/).nullable(), rscMime: z.boolean(),
  status: z.int().optional(), bytes: z.int().nonnegative(), reads: z.int().nonnegative(), eof: z.number().optional(),
  abortAtEof: z.boolean().optional(), cancelAtEof: z.boolean().optional(), signalAbort: z.number().optional(), cancelled: z.boolean(), error: z.boolean(),
}).strict().refine(row => row.method === "GET" ? authorityPath.test(row.path) && row.queryVariant === "none" && row.actionKind === null && row.actionHash === null
  : detailPath.test(row.path) && row.queryVariant !== "unsupported" && row.actionKind !== null && row.actionHash !== null);
type Read = z.infer<typeof ReadAudit>;
/** Passive completion evidence observes only the application's original read and Promise. */
async function installAudit(page: Page, actions: LifecycleReferences) {
  const entries = new Map<string, Read>(); let rejected = 0;
  await page.exposeBinding("__marketplaceReadAudit", (source, raw: unknown) => {
    if (source.frame !== page.mainFrame()) return; const parsed = ReadAudit.safeParse(raw);
    if (!parsed.success) { rejected++; return; } const row = parsed.data;
    entries.set(row.documentAt + ":" + row.sequence, row); if (entries.size > 250) entries.delete(entries.keys().next().value!);
  });
  await page.addInitScript(({ actionReferences }) => {
    type State = { documentAt: number; sequence: number; start: number; path: string; status?: number; bytes: number; reads: number;
      method: "GET" | "POST"; queryVariant: "none" | "oauth_success" | "unsupported"; actionKind: "sync" | "revoke" | "private" | "disable" | null; actionHash: string | null; rscMime: boolean;
      eof?: number; abortAtEof?: boolean; cancelAtEof?: boolean; signalAbort?: number; cancelled: boolean; error: boolean };
    const streams = new WeakMap<object, State>(), readers = new WeakMap<object, State>(); let sequence = 0;
    const publish = (state: State) => { try {
      const send = (window as Window & { __marketplaceReadAudit?: (raw: State) => Promise<void> }).__marketplaceReadAudit;
      if (send) void send({ ...state }).catch(() => {});
    } catch { /* Do not change the original read or cancellation. */ } };
    const originalFetch = window.fetch;
    window.fetch = function (...args: Parameters<typeof originalFetch>) {
      let state: State | undefined;
      try {
        const [input, init] = args, request = input instanceof Request ? input : null, url = new URL(request?.url ?? String(input), location.href);
        const method = (init?.method ?? request?.method ?? "GET").toUpperCase(), queryVariant = !url.search ? "none" : url.search === "?oauth=success" ? "oauth_success" : "unsupported";
        const action = method === "POST" && /^\/stores\/[a-f0-9-]{36}$/.test(url.pathname) && queryVariant !== "unsupported"
          ? actionReferences.find(value => value.id === new Headers(init?.headers ?? request?.headers).get("next-action")) : undefined;
        if (url.origin === location.origin && (method === "GET" && queryVariant === "none" &&
          /^\/api\/marketplace-accounts\/[a-f0-9-]{36}\/authority$/.test(url.pathname) || action)) {
          state = { documentAt: performance.timeOrigin, sequence: ++sequence, start: Date.now(), path: url.pathname, method: method as "GET" | "POST", queryVariant,
            actionKind: action?.kind ?? null, actionHash: action?.hash ?? null, rscMime: false, bytes: 0, reads: 0, cancelled: false, error: false };
          const entry = state, signal = init && "signal" in init ? init.signal : request?.signal;
          if (signal?.aborted) entry.signalAbort = Date.now();
          signal?.addEventListener("abort", () => { entry.signalAbort ??= Date.now(); publish(entry); }, { once: true }); publish(entry);
        }
      } catch { /* Only whitelisted read metadata is observed. */ }
      const result = Reflect.apply(originalFetch, this, args) as ReturnType<typeof originalFetch>, entry = state;
      if (entry) void result.then(response => { entry.status = response.status; entry.rscMime = /^text\/x-component(?:\s*;|$)/i.test(response.headers.get("content-type") ?? "");
        if (response.body) streams.set(response.body, entry); publish(entry); },
        () => { entry.error = true; publish(entry); }); return result;
    };
    const getReader = ReadableStream.prototype.getReader;
    ReadableStream.prototype.getReader = function (this: ReadableStream<unknown>, ...args: Parameters<typeof getReader>) {
      const result = Reflect.apply(getReader, this, args) as ReturnType<typeof getReader>; const entry = streams.get(this); if (entry) readers.set(result, entry); return result;
    } as typeof getReader;
    const read = ReadableStreamDefaultReader.prototype.read;
    ReadableStreamDefaultReader.prototype.read = function (this: ReadableStreamDefaultReader<unknown>, ...args: Parameters<typeof read>) {
      const result = Reflect.apply(read, this, args) as Promise<ReadableStreamReadResult<unknown>>, entry = readers.get(this);
      if (entry) void result.then(part => { entry.reads++; if (!part.done && ArrayBuffer.isView(part.value)) entry.bytes += part.value.byteLength;
        if (part.done && entry.eof === undefined) { entry.eof = Date.now(); entry.abortAtEof = entry.signalAbort !== undefined; entry.cancelAtEof = entry.cancelled; }
        publish(entry); }, () => { entry.error = true; publish(entry); }); return result;
    };
    const cancel = ReadableStreamDefaultReader.prototype.cancel;
    ReadableStreamDefaultReader.prototype.cancel = function (this: ReadableStreamDefaultReader<unknown>, ...args: Parameters<typeof cancel>) {
      const result = Reflect.apply(cancel, this, args) as ReturnType<typeof cancel>, entry = readers.get(this);
      if (entry) { entry.cancelled = true; publish(entry); } return result;
    };
    const streamCancel = ReadableStream.prototype.cancel;
    ReadableStream.prototype.cancel = function (this: ReadableStream<unknown>, ...args: Parameters<typeof streamCancel>) {
      const result = Reflect.apply(streamCancel, this, args) as ReturnType<typeof streamCancel>, entry = streams.get(this);
      if (entry) { entry.cancelled = true; publish(entry); } return result;
    };
  }, { actionReferences: Object.entries(actions).map(([kind, value]) => ({ kind: kind as ActionKind, id: value.id, hash: value.hash })) });
  return { snapshot: () => [...entries.values()], rejected: () => rejected };
}
function observe(page: Page, source: Source, actions: LifecycleReferences) {
  type Row = { ordinal: number; path: string; method: string; authority: string | null; responseAuthority: string | null; status: number | null;
    at: number; failedAt?: number; generation: number; settled: boolean; local: boolean; queryEmpty: boolean; fetch: boolean; navigation: boolean;
    queryVariant: z.infer<typeof QueryVariant>; actionKind: ActionKind | null; actionHash: string | null;
    prefetch: boolean; rsc: boolean; responseRscMime: boolean; aborted: boolean; timing: ReturnType<Request["timing"]> };
  type Window = { kind: string; start: number; end: number | null; completed: boolean; navigations: number[] };
  type Handoff = { accountId: string; actorId: string; tenantId: string; authority: string; previousGeneration: string; startedAt: number; startGeneration: number;
    action: OAuthAction; attempts: number; request?: Request; requestMatched: boolean; controlIndex?: number; stateDigest?: string; newGeneration?: string;
    consentAccepted: boolean; cookieBound: boolean; pendingBound: boolean; callbackAccepted: boolean; cookieConsumed: boolean; exchangeOnce: boolean;
    shape: { contentType: "multipart" | "other"; fields: string[]; args: string[]; parsed: boolean } };
  type ActionAttempt = { kind: ActionKind; reference: ActionReference; accountId: string; platform: "amazon" | "etsy"; authority: string;
    previousGeneration: string; startGeneration: number; queryVariant: "none" | "oauth_success"; windowIndex: number;
    fields: Record<string, string>; before: z.infer<typeof Snapshot>; attempts: number; request?: Request; matched: boolean; accepted: boolean;
    outcome?: "succeeded" | "denied_after_revoke"; providerDelta?: z.infer<typeof Snapshot>["counts"];
    result?: { status: string; generation: string; credentialVersion: number | null; capabilityCurrent: boolean; snapshots: number };
    shape: { contentType: "multipart" | "other"; fields: string[]; args: string[]; parsed: boolean } };
  const rows = new Map<Request, Row>(), windows: Window[] = [], known = new Set<string>(), ids = new Set<string>();
  const handoffs: Handoff[] = [], validations = new Set<Promise<void>>();
  const actionAttempts: ActionAttempt[] = [];
  const navigations: Array<{ generation: number; at: number; path: string; consentStateDigest: string | null }> = [];
  const http: Array<{ path: string; status: number }> = [], consoleErrors: string[] = [], pageErrors: string[] = [], classifications: object[] = [];
  let generation = 0, sequence = 0;
  page.on("framenavigated", frame => { if (frame === page.mainFrame()) {
    generation++; for (const window of windows) if (window.end === null) window.navigations.push(generation);
    const url = new URL(frame.url()); navigations.push({ generation, at: Date.now(), path: url.pathname,
      consentStateDigest: url.origin === "https://www.etsy.com" && url.pathname === "/oauth/connect" && url.searchParams.getAll("state").length === 1
        ? marketplaceOAuthStateDigest(url.searchParams.get("state")!) : null });
  } });
  async function validateOAuthRequest(request: Request, handoff: Handoff) {
    try {
      const contentType = request.headers()["content-type"] ?? "", buffer = request.postDataBuffer();
      handoff.shape.contentType = /^multipart\/form-data\s*;/i.test(contentType) ? "multipart" : "other";
      if (handoff.shape.contentType !== "multipart" || !buffer || buffer.byteLength > 65536) return;
      const form = await new Response(new Uint8Array(buffer), { headers: { "content-type": contentType } }).formData();
      const entries = [...form.entries()]; handoff.shape.fields = entries.map(([key]) => key === "0" || /^_[0-9]+___marketplaceAuthority$/.test(key) ||
        /^_[0-9]+___authorizationGeneration$/.test(key) ? key : "unknown_field_hash:" + sha(key).slice(0, 12));
      const root = form.get("0"); if (typeof root !== "string" || form.getAll("0").length !== 1) return;
      const raw: unknown = JSON.parse(root); handoff.shape.args = Array.isArray(raw) ? raw.map(value => value === null ? "null" : Array.isArray(value) ? "array" : typeof value) : [typeof raw];
      const parsed = z.tuple([Id, z.object({ message: z.literal(""), status: z.literal("idle") }).strict(), z.string().regex(/^\$K[1-9a-f][0-9a-f]*$/)]).safeParse(raw);
      if (!parsed.success) return;
      const prefix = "_" + Number.parseInt(parsed.data[2].slice(2), 16) + "_", authorityKey = prefix + "__marketplaceAuthority", generationKey = prefix + "__authorizationGeneration";
      if (entries.length !== 3 || entries.some(([key, value]) => !["0", authorityKey, generationKey].includes(key) || typeof value !== "string") ||
        form.getAll(authorityKey).length !== 1 || form.getAll(generationKey).length !== 1) return;
      handoff.requestMatched = parsed.data[0] === handoff.accountId && form.get(authorityKey) === handoff.authority && form.get(generationKey) === handoff.previousGeneration;
      handoff.shape.parsed = handoff.requestMatched;
    } catch { /* Retain only safe field names and shape; an unknown encoding remains rejected. */ }
  }
  async function validateLifecycleRequest(request: Request, action: ActionAttempt) {
    try {
      const contentType = request.headers()["content-type"] ?? "", buffer = request.postDataBuffer();
      action.shape.contentType = /^multipart\/form-data\s*;/i.test(contentType) ? "multipart" : "other";
      if (action.shape.contentType !== "multipart" || !buffer || buffer.byteLength > 65536) return;
      const form = await new Response(new Uint8Array(buffer), { headers: { "content-type": contentType } }).formData(), entries = [...form.entries()];
      const allowed = Object.keys(action.fields);
      action.shape.fields = entries.map(([key]) => key === "0" || allowed.some(name => new RegExp("^_[0-9]+_" + name + "$").test(key))
        ? key : "unknown_field_hash:" + sha(key).slice(0, 12));
      const root = form.get("0"); if (typeof root !== "string" || form.getAll("0").length !== 1) return;
      const raw: unknown = JSON.parse(root), idle = z.object({ message: z.literal(""), status: z.literal("idle") }).strict(), reference = z.string().regex(/^\$K[1-9a-f][0-9a-f]*$/);
      action.shape.args = Array.isArray(raw) ? raw.map(value => value === null ? "null" : Array.isArray(value) ? "array" : typeof value) : [typeof raw];
      const parsed = action.kind === "sync" ? z.tuple([Id, z.enum(["amazon", "etsy"]), idle, reference]).safeParse(raw)
        : action.kind === "disable" ? z.tuple([Id, z.literal(false), idle, reference]).safeParse(raw) : z.tuple([Id, idle, reference]).safeParse(raw);
      if (!parsed.success || parsed.data[0] !== action.accountId || action.kind === "sync" && parsed.data[1] !== action.platform) return;
      const ref = parsed.data.at(-1); if (typeof ref !== "string") return;
      const prefix = "_" + Number.parseInt(ref.slice(2), 16) + "_";
      if (entries.length !== allowed.length + 1 || entries.some(([key, value]) => key !== "0" && !allowed.some(name => key === prefix + name) || typeof value !== "string")) return;
      action.matched = allowed.every(name => { const values = form.getAll(prefix + name); return values.length === 1 && typeof values[0] === "string" && sha(values[0]) === action.fields[name]; });
      action.shape.parsed = action.matched;
    } catch { /* Never retain original parameters, private fields or an exception message. */ }
  }
  page.on("request", request => {
    const url = new URL(request.url()), headers = request.headers(), action = Object.entries(actions).find(([, value]) => value.id === headers["next-action"]);
    const queryVariant = !url.search ? "none" : url.search === "?oauth=success" ? "oauth_success" : "unsupported";
    rows.set(request, { ordinal: ++sequence, path: url.pathname, method: request.method(),
      authority: headers["x-yummyai-context-authority"] ?? null, responseAuthority: null, status: null, at: Date.now(), generation, settled: false,
      local: url.origin === "http://localhost:3130", queryEmpty: url.search === "", fetch: request.resourceType() === "fetch", navigation: request.isNavigationRequest(),
      queryVariant, actionKind: action ? action[0] as ActionKind : null, actionHash: action?.[1].hash ?? null,
      prefetch: headers["next-router-prefetch"] === "1", rsc: headers.rsc === "1", responseRscMime: false, aborted: false, timing: request.timing() });
    const handoff = handoffs.find(value => request.method() === "POST" && url.origin === "http://localhost:3130" && !url.search &&
      url.pathname === `/stores/${value.accountId}` && headers["next-action"] === value.action.id && value.startedAt <= Date.now() && value.startGeneration === generation);
    const windowIndex = windows.findLastIndex(value => value.kind === "start_platform_authorization" && value.end === null);
    if (handoff && windowIndex !== -1) {
      handoff.attempts++; if (handoff.attempts !== 1) return; handoff.request = request; handoff.controlIndex = windowIndex;
      const validation = validateOAuthRequest(request, handoff); validations.add(validation);
      void validation.then(() => validations.delete(validation));
    }
    const attempt = actionAttempts.find(value => request.method() === "POST" && url.origin === "http://localhost:3130" &&
      url.pathname === `/stores/${value.accountId}` && queryVariant === value.queryVariant && headers["next-action"] === value.reference.id &&
      generation === value.startGeneration && windows[value.windowIndex]?.end === null);
    if (attempt) {
      attempt.attempts++; if (attempt.attempts !== 1) return; attempt.request = request;
      const validation = validateLifecycleRequest(request, attempt); validations.add(validation); void validation.then(() => validations.delete(validation));
    }
  });
  page.on("requestfinished", request => { const row = rows.get(request); if (row) { row.settled = true; row.timing = request.timing(); } });
  page.on("requestfailed", request => { const row = rows.get(request); if (row) { row.settled = true; row.failedAt = Date.now(); row.aborted = request.failure()?.errorText === "net::ERR_ABORTED"; row.timing = request.timing(); } });
  page.on("response", response => { const row = rows.get(response.request()); if (row) { row.status = response.status(); row.responseAuthority = response.headers()["x-yummyai-context-authority"] ?? null;
      row.responseRscMime = /^text\/x-component(?:\s*;|$)/i.test(response.headers()["content-type"] ?? ""); }
    if (response.status() >= 400) http.push({ path: new URL(response.url()).pathname, status: response.status() }); });
  page.on("console", message => { if (message.type() === "error") consoleErrors.push(sha(message.text())); });
  page.on("pageerror", error => pageErrors.push(sha(error.message)));
  const register = async () => { const session = await personal(page); known.add(sha(erpSessionAuthority(session))); };
  const approvedHandoff = (request: Request, final: boolean) => {
    const handoff = handoffs.find(value => value.request === request), row = rows.get(request);
    const window = handoff?.controlIndex === undefined ? undefined : windows[handoff.controlIndex];
    return Boolean(handoff && row && window && window.kind === "start_platform_authorization" && (!final || window.completed) &&
      row.local && row.fetch && !row.navigation && row.queryEmpty && row.method === "POST" && row.path === `/stores/${handoff.accountId}` &&
      row.status === 200 && row.responseRscMime && row.at >= window.start && row.generation === handoff.startGeneration &&
      handoff.actorId === source.actorId && handoff.tenantId === source.tenantId && known.has(handoff.authority) && handoff.attempts === 1 && handoff.requestMatched &&
      handoff.consentAccepted && handoff.cookieBound && handoff.pendingBound && handoff.newGeneration !== handoff.previousGeneration &&
      (!final || handoff.callbackAccepted && handoff.cookieConsumed && handoff.exchangeOnce));
  };
  const stable = async () => { await Promise.all([...validations]); await expect.poll(() => [...rows].filter(([request, row]) => row.local && !row.settled &&
    (row.path.startsWith("/api/") || row.rsc && !row.prefetch || row.method !== "GET") && !approvedHandoff(request, false)).length).toBe(0); };
  return { ids, register, stable, http, consoleErrors, pageErrors, exchangeCount: async () => (await snapshot(source)).counts.oauth,
    async beginAction(kind: ActionKind, id: string) {
      const before = await authority(page, id), fixed = await snapshot(source), url = new URL(page.url());
      expect(source.ids.includes(id)).toBe(true); expect(before.context.actorId).toBe(source.actorId); expect(before.context.tenantId).toBe(source.tenantId);
      expect(known.has(before.context.authority)).toBe(true); expect(url.origin).toBe("http://localhost:3130"); expect(url.pathname).toBe(`/stores/${id}`);
      const queryVariant = !url.search ? "none" : url.search === "?oauth=success" ? "oauth_success" : "unsupported";
      if (queryVariant === "unsupported") throw new Error("authority_action_query_invalid");
      expect(kind === "sync" ? before.access.sync : kind === "disable" ? before.access.manage : before.access.authorize).toBe(true);
      const values: Record<string, string> = { __marketplaceAuthority: before.context.authority, __authorizationGeneration: before.lifecycle.authorizationGeneration };
      if (kind === "sync") values.targets = await page.locator('.store-sync-form input[name="targets"]').inputValue();
      if (kind === "private") for (const name of ["sellingPartnerId", "clientId", "clientSecret", "refreshToken"]) {
        const value = await page.locator(`.store-secret-form input[name="${name}"]`).inputValue();
        if (!value) throw new Error("authority_action_private_input_missing"); values[name] = value;
      }
      const windowIndex = windows.length; windows.push({ kind: `original_${kind}_action`, start: Date.now(), end: null, completed: false, navigations: [] });
      actionAttempts.push({ kind, reference: actions[kind], accountId: id, platform: before.account.platform, authority: before.context.authority,
        previousGeneration: before.lifecycle.authorizationGeneration, startGeneration: generation, queryVariant, windowIndex,
        fields: Object.fromEntries(Object.entries(values).map(([name, value]) => [name, sha(value)])), before: fixed, attempts: 0, matched: false, accepted: false,
        shape: { contentType: "other", fields: [], args: [], parsed: false } });
      return actionAttempts.length - 1;
    },
    async acceptAction(index: number, deniedAfterRevoke = false) {
      await Promise.all([...validations]); const action = actionAttempts[index]; if (!action || action.accepted) throw new Error("authority_action_attempt_invalid");
      expect(action.attempts).toBe(1); expect(action.matched, "authority_action_parameters_invalid:" + JSON.stringify(action.shape)).toBe(true);
      const after = await authority(page, action.accountId), actual = await snapshot(source), previous = action.before.accounts.find(value => value.id === action.accountId),
        current = actual.accounts.find(value => value.id === action.accountId);
      expect(previous).toBeDefined(); expect(current).toBeDefined(); if (!previous || !current) throw new Error("authority_action_account_missing");
      expect(after.context).toEqual({ actorId: source.actorId, tenantId: source.tenantId, authority: action.authority });
      expect(known.has(after.context.authority)).toBe(true); expect(after.account.platform).toBe(action.platform); expect(actual.business).toEqual(action.before.business);
      const delta = { oauth: actual.counts.oauth - action.before.counts.oauth, private: actual.counts.private - action.before.counts.private,
        refresh: actual.counts.refresh - action.before.counts.refresh, read: actual.counts.read - action.before.counts.read, rejected: actual.counts.rejected - action.before.counts.rejected };
      expect(delta.oauth).toBe(0); expect(delta.rejected).toBe(0);
      if (action.kind === "sync") {
        expect(action.platform).toBe("etsy"); expect(delta.private).toBe(0); expect(delta.refresh).toBe(1); expect(delta.read).toBeGreaterThan(0);
        if (deniedAfterRevoke) {
          expect(after.account.status).toBe("revoked"); expect(after.account.hasCredential).toBe(false); expect(after.lifecycle.capabilityCurrent).toBe(false);
          expect(current.snapshots).toBe(0); expect(current.credentialVersion).toBeNull(); expect(after.lifecycle.authorizationGeneration).not.toBe(action.previousGeneration);
        } else {
          expect(after.account.hasCredential).toBe(true); expect(after.lifecycle.capabilityCurrent).toBe(true); expect(current.snapshots).toBe(previous.snapshots + 1);
          expect(after.lifecycle.authorizationGeneration).toBe(action.previousGeneration);
        }
      } else {
        expect(deniedAfterRevoke).toBe(false); expect(delta.refresh).toBe(0);
        if (action.kind === "private") {
          expect(action.platform).toBe("amazon"); expect(delta.private).toBe(1); expect(after.account.hasCredential).toBe(true); expect(current.credentialVersion).not.toBeNull();
        } else {
          expect(delta).toEqual({ oauth: 0, private: 0, refresh: 0, read: 0, rejected: 0 });
          expect(after.account.status).toBe(action.kind === "revoke" ? "revoked" : "disabled");
          if (action.kind === "revoke") { expect(after.account.hasCredential).toBe(false); expect(current.credentialVersion).toBeNull(); }
        }
        expect(after.lifecycle.authorizationGeneration).not.toBe(action.previousGeneration);
      }
      action.accepted = true; action.outcome = deniedAfterRevoke ? "denied_after_revoke" : "succeeded"; action.providerDelta = delta;
      action.result = { status: after.account.status, generation: after.lifecycle.authorizationGeneration, credentialVersion: current.credentialVersion,
        capabilityCurrent: after.lifecycle.capabilityCurrent, snapshots: current.snapshots };
      const window = windows[action.windowIndex]!; window.completed = true; window.end = Date.now();
    },
    beginOAuth(before: MarketplaceAuthorityWorkspace, action: OAuthAction) {
      expect(before.context.actorId).toBe(source.actorId); expect(before.context.tenantId).toBe(source.tenantId); expect(before.account.hasCredential).toBe(false);
      expect(known.has(before.context.authority)).toBe(true); expect(before.access.authorize).toBe(true);
      handoffs.push({ accountId: before.account.id, actorId: before.context.actorId, tenantId: before.context.tenantId, authority: before.context.authority,
        previousGeneration: before.lifecycle.authorizationGeneration, startedAt: Date.now(), startGeneration: generation, action, attempts: 0, requestMatched: false,
        consentAccepted: false, cookieBound: false, pendingBound: false, callbackAccepted: false, cookieConsumed: false, exchangeOnce: false,
        shape: { contentType: "other", fields: [], args: [], parsed: false } });
    },
    async approveOAuth(id: string, state: string, consentRequest: Request) {
      await Promise.all([...validations]); const handoff = handoffs.find(value => value.accountId === id); expect(handoff).toBeDefined();
      if (!handoff) throw new Error("authority_oauth_handoff_missing");
      expect(handoff.attempts).toBe(1); expect(handoff.requestMatched, "authority_oauth_parameters_invalid:" + JSON.stringify(handoff.shape)).toBe(true);
      const consent = rows.get(consentRequest), destination = new URL(page.url()), requestedConsent = new URL(consentRequest.url());
      expect(destination.origin).toBe("https://www.etsy.com"); expect(destination.pathname).toBe("/oauth/connect");
      expect(destination.searchParams.getAll("state").length === 1 && destination.searchParams.get("state") === state).toBe(true);
      expect(requestedConsent.origin === destination.origin && requestedConsent.pathname === destination.pathname &&
        requestedConsent.searchParams.getAll("state").length === 1 && requestedConsent.searchParams.get("state") === state).toBe(true);
      expect(consent?.navigation).toBe(true); expect(consent?.method).toBe("GET"); expect(consent?.path).toBe("/oauth/connect"); expect(consent?.status).toBe(200);
      const stateDigest = marketplaceOAuthStateDigest(state), window = windows[handoff.controlIndex!];
      const navigation = navigations.filter(value => value.consentStateDigest === stateDigest && value.generation > handoff.startGeneration && window?.navigations.includes(value.generation));
      expect(navigation).toHaveLength(1); await expect(page.getByRole("heading", { name: "Synthetic marketplace consent", exact: true })).toBeVisible();
      const cookieName = marketplaceOAuthCookieName(state), cookies = (await page.context().cookies()).filter(cookie => cookie.name === cookieName); expect(cookies).toHaveLength(1);
      const cookie = cookies[0]!, binding = MarketplaceOAuthBindingSchema.parse(JSON.parse(decodeURIComponent(cookie.value))), current = await authority(page, id);
      expect(cookie.httpOnly).toBe(true); expect(cookie.path).toBe("/stores/oauth/callback"); expect(cookie.domain).toBe("localhost"); expect(cookie.sameSite).toBe("Lax");
      expect(cookie.secure).toBe(true); expect(cookie.expires * 1000).toBeGreaterThan(Date.now());
      expect(binding).toMatchObject({ accountId: id, actorId: handoff.actorId, tenantId: handoff.tenantId, platform: "etsy", stateDigest, authority: handoff.authority,
        authorizationGeneration: current.lifecycle.authorizationGeneration });
      expect(Date.parse(binding.expiresAt)).toBeGreaterThan(Date.now()); expect(Date.parse(binding.expiresAt)).toBeLessThanOrEqual(Date.parse(current.observedAt) + 600000);
      expect(current.account.status).toBe("pending_authorization"); expect(current.account.hasCredential).toBe(false); expect(current.context.authority).toBe(handoff.authority);
      expect(current.lifecycle.pendingOAuthStateDigest).toBe(marketplaceOAuthPendingStateDigest(state));
      expect(current.lifecycle.authorizationGeneration).not.toBe(handoff.previousGeneration);
      Object.assign(handoff, { consentAccepted: true, cookieBound: true, pendingBound: true, stateDigest, newGeneration: current.lifecycle.authorizationGeneration });
      expect(handoff.request && approvedHandoff(handoff.request, false)).toBe(true);
    },
    async finishOAuth(id: string, state: string, after: MarketplaceAuthorityWorkspace, exchanges: number) {
      const handoff = handoffs.find(value => value.accountId === id && value.stateDigest === marketplaceOAuthStateDigest(state)); expect(handoff).toBeDefined();
      if (!handoff) throw new Error("authority_oauth_callback_handoff_missing");
      expect(after.account.id).toBe(id); expect(after.account.hasCredential).toBe(true); expect(after.context).toEqual({ actorId: handoff.actorId, tenantId: handoff.tenantId, authority: handoff.authority });
      expect(after.lifecycle.authorizationGeneration).toBe(handoff.newGeneration); expect(after.lifecycle.pendingOAuthStateDigest).toBeNull(); expect(exchanges).toBe(1);
      expect((await page.context().cookies()).filter(cookie => cookie.name === marketplaceOAuthCookieName(state))).toHaveLength(0);
      Object.assign(handoff, { callbackAccepted: true, cookieConsumed: true, exchangeOnce: true });
    },
    async control<T>(kind: string, action: () => Promise<T>) {
      const window: Window = { kind, start: Date.now(), end: null, completed: false, navigations: [] }; windows.push(window);
      try { const value = await action(); await stable(); if (new URL(page.url()).origin === "http://localhost:3130") await register(); window.completed = true; return value; }
      finally { window.end = Date.now(); }
    },
    diagnostic: () => ({ requests: [...rows.values()], windows, navigations, classifications, knownAuthorities: [...known], ownedAccountIds: [...ids],
      lifecycleActions: actionAttempts.map(value => ({ kind: value.kind, exportedName: value.reference.exportedName, actionHash: value.reference.hash,
        candidateId: value.reference.candidateId, accountId: value.accountId, authority: value.authority, previousGeneration: value.previousGeneration,
        startGeneration: value.startGeneration, queryVariant: value.queryVariant, windowIndex: value.windowIndex, attempts: value.attempts,
        requestOrdinal: value.request ? rows.get(value.request)?.ordinal ?? null : null, matched: value.matched, accepted: value.accepted,
        outcome: value.outcome ?? null, providerDelta: value.providerDelta ?? null, result: value.result ?? null, shape: value.shape })),
      oauthHandoffs: handoffs.map(value => ({ accountId: value.accountId, actorId: value.actorId, tenantId: value.tenantId, authority: value.authority,
        previousGeneration: value.previousGeneration, newGeneration: value.newGeneration ?? null, startedAt: value.startedAt, startGeneration: value.startGeneration,
        actionHash: value.action.hash, candidateId: value.action.candidateId, exportedName: value.action.exportedName, requestOrdinal: value.request ? rows.get(value.request)?.ordinal ?? null : null,
        attempts: value.attempts, requestMatched: value.requestMatched, consentAccepted: value.consentAccepted, cookieBound: value.cookieBound, pendingBound: value.pendingBound,
        callbackAccepted: value.callbackAccepted, cookieConsumed: value.cookieConsumed, exchangeOnce: value.exchangeOnce, stateDigest: value.stateDigest ?? null, shape: value.shape })) }),
    check(audits: Read[]) {
      expect(http).toEqual([]); expect(consoleErrors).toEqual([]); expect(pageErrors).toEqual([]);
      const eligible = (row: Row) => row.local && row.fetch && !row.navigation && row.queryEmpty && row.method === "GET" && authorityPath.test(row.path) &&
        ids.has(row.path.split("/")[3]!) && row.authority !== null && known.has(row.authority);
      const unknown: Row[] = [];
      for (const [request, row] of rows) {
        row.timing = request.timing();
        if ((!row.settled || row.failedAt !== undefined) && approvedHandoff(request, true)) {
          if (row.failedAt !== undefined && !row.aborted) { unknown.push(row); continue; }
          classifications.push({ ordinal: row.ordinal, kind: "controlled_oauth_handoff_without_terminal_event", status: row.status,
            terminalObserved: row.settled, failedAt: row.failedAt ?? null, responseEnd: row.timing.responseEnd, bodyEofProven: false }); continue;
        }
        if (!row.settled && row.local && (row.method !== "GET" || row.path.startsWith("/api/"))) { unknown.push(row); continue; }
        if (row.failedAt === undefined) continue;
        if (!row.aborted) { unknown.push(row); continue; }
        const originalAction = actionAttempts.find(value => value.request === request && value.accepted && value.matched && value.attempts === 1);
        if (row.method === "POST" && originalAction) {
          const actionWindow = windows[originalAction.windowIndex];
          const same = (other: Row, audit: Read) => other.local && other.fetch && !other.navigation && other.method === "POST" &&
            other.path === row.path && other.queryVariant === originalAction.queryVariant && other.actionKind === originalAction.kind && other.actionHash === originalAction.reference.hash &&
            audit.method === "POST" && audit.path === other.path && audit.queryVariant === other.queryVariant && audit.actionKind === other.actionKind && audit.actionHash === other.actionHash &&
            (other.status === null ? audit.status === undefined : audit.status === other.status) && other.timing.startTime > 0 && Math.abs(other.timing.startTime - audit.start) <= 25;
          const candidates = audits.filter(value => same(row, value)), audit = candidates[0];
          if (actionWindow?.completed && actionWindow.end !== null && row.at >= actionWindow.start && row.failedAt <= actionWindow.end &&
            row.generation === originalAction.startGeneration && row.authority === null && row.responseAuthority === null && known.has(originalAction.authority) &&
            candidates.length === 1 && audit && [...rows.values()].filter(other => same(other, audit)).length === 1 &&
            row.status === 200 && row.responseRscMime && audit.status === 200 && audit.rscMime && audit.reads > 0 && audit.bytes > 0 &&
            audit.eof !== undefined && audit.abortAtEof === false && audit.cancelAtEof === false && !audit.cancelled && !audit.error &&
            row.timing.responseStart >= 0 && row.timing.responseEnd >= row.timing.responseStart) {
            classifications.push({ ordinal: row.ordinal, kind: "completed_original_lifecycle_action_with_terminal_abort", action: originalAction.kind,
              actionHash: originalAction.reference.hash, outcome: originalAction.outcome, browserEofAt: audit.eof, nodeFailedAt: row.failedAt,
              observedCallbackDifferenceMs: audit.eof - row.failedAt, bytes: audit.bytes, reads: audit.reads }); continue;
          }
          unknown.push(row); continue;
        }
        const window = windows.find(value => value.completed && value.end !== null && row.at >= value.start && row.failedAt! <= value.end);
        const route = /^\/stores(?:\/[a-f0-9-]{36})?$/.test(row.path);
        const prefetchPath = route || ["/navigation", "/", "/orders", "/listings"].includes(row.path);
        if (row.local && row.fetch && !row.navigation && row.method === "GET" && row.status === 200 && row.prefetch && row.rsc && prefetchPath) {
          classifications.push({ ordinal: row.ordinal, kind: "intentional_prefetch_cancel", path: row.path }); continue;
        }
        if (row.local && row.fetch && !row.navigation && row.method === "GET" && row.status === 200 && route &&
          row.rsc && window && window.navigations.length) { classifications.push({ ordinal: row.ordinal, kind: "controlled_navigation_rsc_cancel" }); continue; }
        if (!eligible(row)) { unknown.push(row); continue; }
        const same = (other: Row, audit: Read) => eligible(other) && audit.method === "GET" && other.path === audit.path &&
          (other.status === null ? audit.status === undefined : audit.status === other.status) && other.timing.startTime > 0 && Math.abs(other.timing.startTime - audit.start) <= 25;
        const candidates = audits.filter(audit => same(row, audit)), audit = candidates[0];
        if (candidates.length !== 1 || !audit || [...rows.values()].filter(other => same(other, audit)).length !== 1) { unknown.push(row); continue; }
        if (row.status === 200 && row.responseAuthority === row.authority && row.timing.responseStart >= 0 && row.timing.responseEnd >= row.timing.responseStart &&
          audit.status === 200 && audit.eof !== undefined && audit.bytes > 0 && audit.reads > 0 && audit.abortAtEof === false && audit.cancelAtEof === false && !audit.error) {
          classifications.push({ ordinal: row.ordinal, kind: "completed_read_with_terminal_abort", browserEof: audit.eof, nodeFailedAt: row.failedAt,
            observedCallbackDifferenceMs: audit.eof - row.failedAt, bytes: audit.bytes }); continue;
        }
        if (window && audit.eof === undefined && audit.bytes === 0 && audit.signalAbort !== undefined && audit.error && !audit.cancelled &&
          audit.signalAbort >= window.start && audit.signalAbort <= window.end! && (row.status === null || row.status === 200 && row.responseAuthority === row.authority)) {
          classifications.push({ ordinal: row.ordinal, kind: "controlled_stale_read_signal_abort", control: window.kind }); continue;
        }
        unknown.push(row);
      }
      expect(unknown).toEqual([]);
      expect([...rows.values()].filter(row => row.method === "POST" && /\/api\/(?:agent|ai-assists)/.test(row.path))).toEqual([]);
    },
  };
}

async function settled(locator: Locator) {
  await locator.scrollIntoViewIfNeeded(); await expect(locator).toBeVisible();
  await expect.poll(() => locator.evaluate(element => ({ opacity: getComputedStyle(element).opacity,
    running: element.getAnimations({ subtree: true }).filter(animation => animation.playState === "running" && animation.effect?.getComputedTiming().iterations !== Infinity).length,
  }))).toEqual({ opacity: "1", running: 0 });
}
async function screenshot(page: Page, info: TestInfo, name: string) {
  await settled(lifecycle(page)); const box = await lifecycle(page).boundingBox(); expect(box).not.toBeNull();
  expect(box!.height).toBeLessThanOrEqual(844); expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  const path = info.outputPath(name + ".png"); await page.screenshot({ path }); await info.attach(name, { path, contentType: "image/png" });
}
async function open(page: Page, id: string, seen: ReturnType<typeof observe>) {
  seen.ids.add(id); await seen.control("open_original_account", async () => {
    await page.goto(`/stores/${id}`); await expect(lifecycle(page)).toBeVisible(); await expect(lifecycle(page)).toHaveAttribute("aria-busy", "false");
    expect((await authority(page, id)).account.id).toBe(id);
  });
}
async function refresh(page: Page, id: string, seen: ReturnType<typeof observe>) {
  await seen.control("read_original_authority", async () => { await lifecycle(page).getByRole("button", { name: "重新读取授权状态", exact: true }).click();
    await expect(lifecycle(page)).toHaveAttribute("aria-busy", "false"); }); return authority(page, id);
}
async function startOAuth(page: Page, id: string, seen: ReturnType<typeof observe>) {
  const before = await authority(page, id); seen.beginOAuth(before, await oauthAction());
  type Entered = { input: { state: string; code: string }; consentRequest: Request };
  let ready!: (value: Entered) => void, reject!: (error: unknown) => void;
  const entered = new Promise<Entered>((yes, no) => { ready = yes; reject = no; }); void entered.catch(() => {});
  await page.route("https://www.etsy.com/oauth/connect?**", async route => {
    try {
      const result = z.object({ state: z.string().min(1), code: z.string().min(1) }).strict().parse(await control({ operation: "oauth", accountId: id, authorizationUrl: route.request().url() }));
      const consentRequest = route.request();
      await route.fulfill({ status: 200, contentType: "text/html", body: '<!doctype html><title>Synthetic marketplace consent</title><h1>Synthetic marketplace consent</h1>' });
      ready({ input: result, consentRequest });
    } catch (error) { reject(error); }
  }, { times: 1 });
  return seen.control("start_platform_authorization", async () => {
    await page.getByRole("button", { name: "前往平台授权", exact: true }).click(); const accepted = await entered;
    await expect(page.getByRole("heading", { name: "Synthetic marketplace consent", exact: true })).toBeVisible();
    await seen.approveOAuth(id, accepted.input.state, accepted.consentRequest); return accepted.input;
  });
}
async function completeOAuth(page: Page, id: string, input: { state: string; code: string }, seen: ReturnType<typeof observe>) {
  const beforeExchanges = await seen.exchangeCount();
  await seen.control("return_original_oauth_callback", async () => {
    await page.goto("/stores/oauth/callback?" + new URLSearchParams(input));
    await expect(page).toHaveURL(new RegExp(`/stores/${id}\\?oauth=success$`));
    await expect(lifecycle(page)).toHaveAttribute("aria-busy", "false"); const current = await authority(page, id); expect(current.account.hasCredential).toBe(true);
    await seen.finishOAuth(id, input.state, current, (await seen.exchangeCount()) - beforeExchanges);
  });
}
async function leaf(page: Page, info: TestInfo, platforms: Array<"amazon" | "etsy">,
  action: (source: Source, create: (page: Page) => Promise<ReturnType<typeof observe>>, proof: Record<string, unknown>) => Promise<void>) {
  const references = await lifecycleActions(), source = Seed.parse(await control({ operation: "seed", platforms })), monitors: Array<{ seen: ReturnType<typeof observe>; audit: Awaited<ReturnType<typeof installAudit>> }> = [];
  const installed = new WeakMap<Page, ReturnType<typeof observe>>();
  const proof: Record<string, unknown> = { operation: "d8b7a3c6", title: info.title, actualPersonalOidc: true, originalNestAndOwners: true,
    externalProvider: "synthetic_http_only", actualStoreNodes: "not_implemented_or_claimed", groupId: source.groupId, accountIds: source.ids };
  let failure: unknown; const cleanup: unknown[] = [];
  const create = async (target: Page) => { const existing = installed.get(target); if (existing) return existing;
    const seen = observe(target, source, references), audit = await installAudit(target, references); source.ids.forEach(id => seen.ids.add(id)); monitors.push({ seen, audit }); installed.set(target, seen); return seen; };
  try {
    const seen = await create(page); await seen.control("initial_personal_login", () => loginErp(page, "operator", `/stores/${source.ids[0]}`));
    expect((await personal(page)).userId).toBe(source.actorId); await action(source, create, proof);
  } catch (error) { failure = error; }
  finally {
    try { await control({ operation: "release" }); } catch (error) { cleanup.push(error); }
    try { await control({ operation: "rights", mode: "restore" }); } catch (error) { cleanup.push(error); }
    for (const monitor of monitors) try { await monitor.seen.stable(); expect(monitor.audit.rejected()).toBe(0); monitor.seen.check(monitor.audit.snapshot()); } catch (error) { cleanup.push(error); }
    try { const result = z.object({ cleaned: z.literal(true), ids: z.array(Id) }).strict().parse(await control({ operation: "cleanup", groupId: source.groupId }));
      expect(result.ids).toEqual(source.ids); proof.cleanup = result; } catch (error) { cleanup.push(error); }
    Object.assign(proof, { cleanupFailureCount: cleanup.length, network: monitors.map(row => ({ ...row.seen.diagnostic(), http: row.seen.http,
      consoleErrors: row.seen.consoleErrors, pageErrors: row.seen.pageErrors, readAudit: row.audit.snapshot(), rejectedAudit: row.audit.rejected() })) });
    const path = info.outputPath("marketplace-authority-proof.json"); await writeFile(path, JSON.stringify(proof)); await info.attach("marketplace-authority-proof", { path, contentType: "application/json" });
  }
  if (failure || cleanup.length) throw new AggregateError([...(failure ? [failure] : []), ...cleanup], "Marketplace authority personal acceptance failed");
}

test.describe.configure({ mode: "serial" });
test("keeps two real personal PKCE callbacks independent and recovers current authority by read only at1440and390", async ({ page, context }, info) => {
  await leaf(page, info, ["etsy", "etsy"], async (source, create, proof) => {
    const first = source.ids[0]!, second = source.ids[1]!, a = await create(page);
    await open(page, first, a); const before = await snapshot(source), firstInput = await startOAuth(page, first, a);
    const other = await context.newPage(), b = await create(other); await open(other, second, b); const secondInput = await startOAuth(other, second, b);
    const cookieFacts = (await context.cookies()).filter(cookie => cookie.name.startsWith("yummyai-marketplace-oauth-v1-"))
      .map(cookie => ({ nameHash: sha(cookie.name), path: cookie.path, httpOnly: cookie.httpOnly, sameSite: cookie.sameSite }));
    expect(cookieFacts).toHaveLength(2); expect(new Set(cookieFacts.map(row => row.nameHash)).size).toBe(2);
    expect(cookieFacts.every(row => row.path === "/stores/oauth/callback" && row.httpOnly && row.sameSite === "Lax")).toBe(true);
    await completeOAuth(page, first, firstInput, a); await completeOAuth(other, second, secondInput, b);
    expect((await snapshot(source)).counts.oauth - before.counts.oauth).toBe(2);
    const replay = await page.request.get("/stores/oauth/callback?" + new URLSearchParams(firstInput), { maxRedirects: 0 });
    expect(replay.status()).toBe(307); const replayUrl = new URL(replay.headers().location!, "http://localhost:3130");
    expect(replayUrl.pathname).toBe("/stores"); expect(replayUrl.searchParams.get("reason")).toBe("invalid_callback");
    expect((await snapshot(source)).counts.oauth - before.counts.oauth).toBe(2);
    const syncAction = await a.beginAction("sync", first);
    await a.control("synchronize_original_capabilities", async () => { await page.getByRole("button", { name: "同步能力", exact: true }).click();
      await expect(lifecycle(page)).toContainText("当前代次有效"); });
    await a.acceptAction(syncAction);
    const ready = await authority(page, first); expect(ready.lifecycle.capabilityCurrent).toBe(true);
    const secondReady = await authority(other, second);
    await a.control("read_actual_personal_store_ledger", async () => {
      await page.goto("/stores"); await expect(page.getByRole("heading", { name: "店铺巡检台账", exact: true })).toBeVisible();
      const table = page.getByRole("table"), firstRow = table.getByRole("row").filter({ has: page.locator(`a[href="/stores/${first}"]`) });
      const secondRow = table.getByRole("row").filter({ has: page.locator(`a[href="/stores/${second}"]`) });
      await expect(firstRow).toContainText(ready.account.displayName); await expect(firstRow).toContainText("授权有效"); await expect(firstRow).toContainText("健康");
      await expect(secondRow).toContainText(secondReady.account.displayName);
      await expect(page.locator('dl[aria-label="店铺运营概览"]')).toBeVisible();
      expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
    });
    await open(page, first, a);
    await expect(page.locator(".store-workflow")).toContainText("能力已验证"); await expect(page.locator(".store-workflow")).not.toContainText("可发布");
    await expect(page.locator("#store-health")).toContainText("健康");
    for (const capability of ready.account.capabilities) await expect(page.locator("#store-health .store-capabilities")).toContainText(capability);
    await expect(page.locator("#store-listings")).toContainText("0 个"); await expect(page.locator("#store-listings")).toContainText("0 次");
    await expect(page.locator("#store-orders")).toContainText("0 个");
    const fixed = await snapshot(source);
    await a.control("reload_original_account", async () => { await page.reload(); await expect(lifecycle(page)).toContainText("当前代次有效"); });
    expect((await refresh(page, first, a)).lifecycle.authorizationGeneration).toBe(ready.lifecycle.authorizationGeneration);
    expect(await snapshot(source)).toEqual(fixed);
    await page.setViewportSize({ width: 1440, height: 1000 }); await screenshot(page, info, "authority-two-pkce-desktop");
    await page.setViewportSize({ width: 390, height: 844 }); await screenshot(page, info, "authority-two-pkce-mobile");
    proof.twoStateCookies = cookieFacts; proof.originalAccountStates = (await snapshot(source)).accounts;
    proof.readOnlyRecovery = { providerCountsUnchanged: true, business: fixed.business };
    proof.actualSsrDisplay = { ownRows: [first, second], authorityHash: sha(erpSessionAuthority(await personal(page))),
      detailStatistics: { listings: 0, publications: 0, orders: 0 }, originalCapabilityNames: ready.account.capabilities,
      authorizationOnlyLabel: true, storeMetadataWriteForms: "not_tested" }; await other.close();
  });
});
test("discards a real late capability reply after revoke and clears private application input before read only reload", async ({ page, context }, info) => {
  await leaf(page, info, ["etsy", "amazon"], async (source, create, proof) => {
    const etsy = source.ids[0]!, amazon = source.ids[1]!, seen = await create(page);
    await open(page, etsy, seen); const input = await startOAuth(page, etsy, seen); await completeOAuth(page, etsy, input, seen);
    const other = await context.newPage(), second = await create(other); await open(other, etsy, second);
    const before = await snapshot(source); await control({ operation: "controls", rotate: true, loseRefresh: false }); await control({ operation: "hold", kind: "read" });
    const syncAction = await seen.beginAction("sync", etsy);
    await page.getByRole("button", { name: "同步能力", exact: true }).click();
    await control({ operation: "entered" });
    const revokeAction = await second.beginAction("revoke", etsy);
    await second.control("revoke_before_original_read_returns", async () => { await other.getByRole("button", { name: "撤销授权", exact: true }).click();
      await expect.poll(async () => (await authority(other, etsy)).account.status).toBe("revoked"); });
    await second.acceptAction(revokeAction);
    const revoked = await snapshot(source), fixed = revoked.accounts.find(row => row.id === etsy)!;
    expect(fixed.credentialVersion).toBeNull(); expect(fixed.snapshots).toBe(0);
    await control({ operation: "release" });
    await expect(page.getByText("当前店铺或本人权限已变化 原资料和填写已隐藏 请重新读取授权状态", { exact: true })).toBeVisible();
    await expect(page.getByRole("button", { name: "同步能力", exact: true })).toHaveCount(0);
    expect((await snapshot(source)).accounts.find(row => row.id === etsy)).toEqual(fixed);
    await seen.acceptAction(syncAction, true);
    await refresh(page, etsy, seen); await expect(page.getByRole("button", { name: "撤销授权", exact: true })).toHaveCount(0);
    await open(page, amazon, seen); await page.getByText("验证私有应用", { exact: true }).click();
    await page.getByRole("textbox", { name: "Seller ID", exact: true }).fill("SYNTHETIC-BROWSER-" + amazon);
    await page.getByRole("textbox", { name: "LWA Client ID", exact: true }).fill("synthetic-authority-client");
    await page.locator('input[name="clientSecret"]').fill("SYNTHETIC-AUTHORITY-CLIENT-SECRET");
    await page.locator('input[name="refreshToken"]').fill("SYNTHETIC-BROWSER-PRIVATE-" + amazon);
    const privateAction = await seen.beginAction("private", amazon);
    await seen.control("authorize_original_private_application", async () => { await page.getByRole("button", { name: "验证并保存", exact: true }).click();
      await expect.poll(async () => (await authority(page, amazon)).account.hasCredential).toBe(true); });
    await seen.acceptAction(privateAction);
    await expect(page.locator('input[name="clientSecret"]')).toHaveValue("");
    await expect(page.locator('input[name="refreshToken"]')).toHaveValue("");
    const disableAction = await seen.beginAction("disable", amazon);
    await seen.control("disable_original_private_account", async () => { await page.getByRole("button", { name: "停用", exact: true }).click();
      await expect.poll(async () => (await authority(page, amazon)).account.status).toBe("disabled"); });
    await seen.acceptAction(disableAction);
    const after = await snapshot(source); expect(after.counts.refresh - before.counts.refresh).toBe(1); expect(after.business).toEqual(before.business);
    await seen.control("reload_disabled_original_account", async () => { await page.reload(); await expect(lifecycle(page)).toHaveAttribute("aria-busy", "false"); });
    const hidden = await refresh(page, amazon, seen); expect(hidden.account.status).toBe("disabled"); expect(hidden.access.sync).toBe(false);
    expect(await snapshot(source)).toEqual(after);
    await expect(page.locator('input[name="clientSecret"], input[name="refreshToken"]')).toHaveCount(0);
    await page.setViewportSize({ width: 1440, height: 1000 }); await screenshot(page, info, "authority-disabled-desktop");
    await page.setViewportSize({ width: 390, height: 844 }); await screenshot(page, info, "authority-disabled-mobile");
    Object.assign(proof, { realLateReplyDiscarded: true, originalRevoked: fixed, originalDisabled: after.accounts.find(row => row.id === amazon),
      businessUnchanged: after.business, privateInputCleared: true, noRefreshOnReload: true }); await other.close();
  });
});
