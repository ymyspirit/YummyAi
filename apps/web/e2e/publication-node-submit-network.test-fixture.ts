import { createHash, randomUUID } from "node:crypto";
import { expect, type Page, type Request, type Response } from "@playwright/test";
import { z } from "zod";
import { CreatePublicationSubmitInputSchema, CreatePublicationStatusInputSchema, PublicationSubmitRequestViewSchema, PublicationStatusReadViewSchema,
  publicationSubmitRequestText, publicationStatusRequestText, type PublicationSubmitRequestView } from "@yummyai/contracts/marketplace/publication-submit";
import { observePublicationAuthority } from "./publication-authority-network.test-fixture";
import { PUBLICATION_SUBMIT_INTENT_PREFIX } from "../src/features/marketplaces/publication-submit-intent";

const sha = (text: string) => createHash("sha256").update(text).digest("hex"), prefix = "/api/erp-publication-submit";
type Binding = { listingId: string; versionId: string; accountId: string; variantSkuId: string; previewId: string };
const Digest = z.string().regex(/^[a-f0-9]{64}$/);
const Audit = z.object({ document: z.uuid(), sequence: z.int().positive(), urlSha256: Digest, path: z.string().max(180), method: z.enum(["GET", "HEAD"]),
  authority: Digest.nullable(), responseAuthority: Digest.nullable(), start: z.number().finite(), startHigh: z.number().finite(),
  status: z.int().min(100).max(599).nullable(), resolvedAt: z.number().nullable(), bodyIsNull: z.boolean().nullable(), abortAtResolve: z.boolean().nullable(),
  eof: z.boolean(), eofAt: z.number().nullable(), abortAtEof: z.boolean().nullable(), bytes: z.int().nonnegative(), reads: z.int().nonnegative(), json: z.boolean(),
  signalAbort: z.boolean(), bodyCancelled: z.boolean(), cancelledBeforeEof: z.boolean(), cancelledAfterEof: z.boolean(), bodyError: z.boolean(), fetchError: z.enum(["AbortError", "Other"]).nullable() }).strict();
type Lookup = { kind: "submit" | "status"; key: string; checksum: string; requestId: string | null };
const LogoutAudit = z.object({ windowId: z.uuid(), document: z.uuid(), urlSha256: Digest, authority: Digest, method: z.literal("POST"),
  path: z.literal("/api/erp-auth/logout"), start: z.number().finite(), startHigh: z.number().finite(), resolvedAt: z.number().finite().nullable(),
  status: z.int().min(100).max(599).nullable(), nativeOk: z.boolean().nullable(), bodyIsNull: z.boolean().nullable(), abortAtResolve: z.boolean().nullable(),
  fetchError: z.enum(["AbortError", "Other"]).nullable() }).strict();

/** Compose the frozen personal/document/HEAD observer. Only this new family's exact reads receive additional passive evidence. */
export async function observePublicationSubmit(page: Page, binding: Binding) {
  const base = await observePublicationAuthority(page, { ...binding, requestId: binding.previewId, scenario: "withdraw_store" }),
    requests: Request[] = [], audits: Array<z.infer<typeof Audit>> = [], known = new Set<string>(), ids = new Set<string>(),
    lookups = new Map<Request, Lookup>(), responseCodes = new Map<Request, string | null>(), losses = new Map<Request, string>(), held = new Set<Request>();
  const logoutWindows: Array<{ id: string; authority: string; generation: number; start: number; end: number; documentOrdinal: number | null; sessionStatus: number | null; markerCount: number | null; accepted: boolean }> = [],
    logoutRequests = new Map<Request, string>(), logoutAudits: Array<z.infer<typeof LogoutAudit>> = [];
  const consoleRows: Array<{ at: number; path: string; urlSha256: string; status: number | null; networkFailure: boolean }> = [];
  let rejected = 0, events = 0;
  page.on("request", request => {
    if (new URL(request.url()).origin !== "http://localhost:3130") return; requests.push(request);
    if (request.method() !== "POST") return;
    const url = new URL(request.url()), logout = logoutWindows.at(-1);
    if (logout?.end === Number.POSITIVE_INFINITY && url.pathname === "/api/erp-auth/logout" && !url.search && request.postData() === null) logoutRequests.set(request, logout.id);
    if (url.search || !url.pathname.startsWith(prefix)) return;
    try {
      const raw: unknown = request.postDataJSON();
      if (url.pathname === prefix + "/requests") {
        const parsed = CreatePublicationSubmitInputSchema.parse(raw), { requestKey, requestChecksum, acknowledgeReplacement: _acknowledgement, ...target } = parsed;
        void _acknowledgement;
        if (target.previewRequestId === binding.previewId && target.listingId === binding.listingId && target.listingVersionId === binding.versionId && target.accountId === binding.accountId &&
          sha(publicationSubmitRequestText(target)) === requestChecksum) lookups.set(request, { kind: "submit", key: requestKey, checksum: requestChecksum, requestId: null });
      } else if (new RegExp("^" + prefix + "/requests/[0-9a-f-]{36}/status$").test(url.pathname)) {
        const parsed = CreatePublicationStatusInputSchema.parse(raw), { requestKey, requestChecksum, ...target } = parsed;
        if (ids.has(target.publicationRequestId) && url.pathname === prefix + "/requests/" + target.publicationRequestId + "/status" &&
          target.listingId === binding.listingId && target.listingVersionId === binding.versionId && target.accountId === binding.accountId &&
          sha(publicationStatusRequestText(target)) === requestChecksum) lookups.set(request, { kind: "status", key: requestKey, checksum: requestChecksum, requestId: target.publicationRequestId });
      }
    } catch { /* An unknown POST never becomes an eligible read or an injected loss. */ }
  });
  page.on("response", response => {
    const request = response.request(), url = new URL(response.url()); if (url.origin !== "http://localhost:3130") return;
    responseCodes.set(request, response.headers()["x-yummyai-error-code"] ?? null);
  });
  page.on("console", message => {
    if (message.type() !== "error") return;
    try { const url = new URL(message.location().url), match = /^Failed to load resource: the server responded with a status of (403|404|409)(?:\s|$)/.exec(message.text());
      consoleRows.push({ at: Date.now(), path: url.pathname, urlSha256: sha(url.href), status: match ? Number(match[1]) : null,
        networkFailure: /^Failed to load resource: net::ERR_(?:FAILED|ABORTED)$/.test(message.text()) }); }
    catch { consoleRows.push({ at: Date.now(), path: "unknown", urlSha256: "", status: null, networkFailure: false }); }
  });
  await page.exposeBinding("__publicationSubmitReadAudit", ({ frame }, raw: unknown) => {
    if (frame !== page.mainFrame()) return; if (++events > 2500) { rejected++; return; }
    const parsed = Audit.safeParse(raw); if (!parsed.success || !parsed.data.path.startsWith(prefix + "/")) { rejected++; return; }
    const value = parsed.data, previous = audits.find(row => row.document === value.document && row.sequence === value.sequence);
    if (!previous) { if (audits.length >= 250) { rejected++; return; } audits.push(value); return; }
    if (["urlSha256", "path", "method", "authority", "start", "startHigh"].some(key => previous[key as keyof typeof previous] !== value[key as keyof typeof value])) { rejected++; return; }
    if (previous.resolvedAt !== null && value.resolvedAt !== null && ["resolvedAt", "status", "bodyIsNull", "abortAtResolve", "responseAuthority"].some(key => previous[key as keyof typeof previous] !== value[key as keyof typeof value])) { rejected++; return; }
    const eof = previous.eof ? { eof: true, eofAt: previous.eofAt, abortAtEof: previous.abortAtEof } : {};
    const resolved = previous.resolvedAt !== null && value.resolvedAt === null ? { status: previous.status, resolvedAt: previous.resolvedAt, bodyIsNull: previous.bodyIsNull,
      abortAtResolve: previous.abortAtResolve, responseAuthority: previous.responseAuthority } : {};
    Object.assign(previous, value, resolved, eof, { bytes: Math.max(previous.bytes, value.bytes), reads: Math.max(previous.reads, value.reads), json: previous.json || value.json,
      bodyCancelled: previous.bodyCancelled || value.bodyCancelled, bodyError: previous.bodyError || value.bodyError,
      cancelledBeforeEof: previous.cancelledBeforeEof || value.cancelledBeforeEof, cancelledAfterEof: previous.cancelledAfterEof || value.cancelledAfterEof,
      signalAbort: previous.signalAbort || value.signalAbort, fetchError: previous.fetchError ?? value.fetchError });
  });
  await page.addInitScript(({ prefix }) => {
    const originalFetch = globalThis.fetch, document = crypto.randomUUID(); let sequence = 0;
    const digest = async (value: string) => Array.from(new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(value))), byte => byte.toString(16).padStart(2, "0")).join("");
    const stamp = (value: string | null) => value === null ? Promise.resolve(null) : /^[a-f0-9]{64}$/.test(value) ? Promise.resolve(value) : digest(value);
    globalThis.fetch = function(...args: Parameters<typeof fetch>) {
      const [input, init] = args; let url: URL, method: "GET" | "HEAD", signal: AbortSignal | null | undefined, raw: string | null;
      try {
        url = new URL(input instanceof Request ? input.url : String(input), location.href);
        const selected = (init?.method ?? (input instanceof Request ? input.method : "GET")).toUpperCase();
        if (url.origin !== location.origin || url.hash || url.username || url.password || !url.pathname.startsWith(prefix + "/") || !["GET", "HEAD"].includes(selected)) return Reflect.apply(originalFetch, this, args);
        method = selected as "GET" | "HEAD"; signal = init?.signal ?? (input instanceof Request ? input.signal : undefined);
        raw = new Headers(init?.headers ?? (input instanceof Request ? input.headers : undefined)).get("x-yummyai-context-authority");
      } catch { return Reflect.apply(originalFetch, this, args); }
      const identity = Promise.all([digest(url.href), stamp(raw)]); let echo: Promise<string | null> = Promise.resolve(null);
      const state = { document, sequence: ++sequence, path: url.pathname, method, start: Date.now(), startHigh: performance.timeOrigin + performance.now(),
        status: null as number | null, resolvedAt: null as number | null, bodyIsNull: null as boolean | null, abortAtResolve: null as boolean | null,
        eof: false, eofAt: null as number | null, abortAtEof: null as boolean | null, bytes: 0, reads: 0, json: false,
        signalAbort: Boolean(signal?.aborted), bodyCancelled: false, cancelledBeforeEof: false, cancelledAfterEof: false, bodyError: false, fetchError: null as "AbortError" | "Other" | null };
      const emit = () => { const value = { ...state }, originalEcho = echo;
        void Promise.all([identity, originalEcho]).then(([[urlSha256, authority], responseAuthority]) =>
          (globalThis as unknown as { __publicationSubmitReadAudit(value: unknown): Promise<void> }).__publicationSubmitReadAudit({ ...value, urlSha256, authority, responseAuthority })).catch(() => {});
      };
      const eof = () => { if (!state.eof) { state.eof = true; state.eofAt = Date.now(); state.abortAtEof = Boolean(signal?.aborted); } emit(); };
      const cancelled = () => { state.bodyCancelled = true; if (state.eof) state.cancelledAfterEof = true; else state.cancelledBeforeEof = true; emit(); };
      signal?.addEventListener("abort", () => { state.signalAbort = true; emit(); }, { once: true }); emit();
      const promise = Reflect.apply(originalFetch, this, args);
      void promise.then(response => {
        state.status = response.status; state.resolvedAt = Date.now(); state.bodyIsNull = response.body === null; state.abortAtResolve = Boolean(signal?.aborted);
        echo = stamp(response.headers.get("x-yummyai-context-authority")); emit();
        if (method === "HEAD") return;
        const originalJson = response.json;
        Object.defineProperty(response, "json", { value: function(...values: unknown[]) { const result = Reflect.apply(originalJson, this, values) as Promise<unknown>;
          void result.then(() => { state.json = true; eof(); }, () => { state.bodyError = true; emit(); }); return result; } });
        if (response.body) {
          const body = response.body, getReader = body.getReader, cancel = body.cancel;
          Object.defineProperty(body, "cancel", { value: function(...values: unknown[]) { cancelled(); return Reflect.apply(cancel, this, values); } });
          Object.defineProperty(body, "getReader", { value: function(...values: unknown[]) {
            const reader = Reflect.apply(getReader, this, values) as ReadableStreamDefaultReader<Uint8Array>, read = reader.read, readerCancel = reader.cancel;
            Object.defineProperty(reader, "read", { value: function(...input: unknown[]) { const result = Reflect.apply(read, this, input) as Promise<ReadableStreamReadResult<Uint8Array>>;
              void result.then(value => { state.reads++; if (value.done) eof(); else state.bytes += value.value.byteLength; }, () => { state.bodyError = true; emit(); }); return result; } });
            Object.defineProperty(reader, "cancel", { value: function(...input: unknown[]) { cancelled(); return Reflect.apply(readerCancel, this, input); } }); return reader;
          } });
        }
      }, error => { state.fetchError = error && typeof error === "object" && "name" in error && error.name === "AbortError" ? "AbortError" : "Other"; emit(); });
      return promise;
    };
  }, { prefix });
  await page.exposeBinding("__publicationSubmitLogoutAudit", ({ frame }, raw: unknown) => {
    if (frame !== page.mainFrame()) return;
    const parsed = LogoutAudit.safeParse(raw); if (!parsed.success || !logoutWindows.some(window => window.id === parsed.data.windowId && window.authority === parsed.data.authority)) { rejected++; return; }
    if (logoutAudits.length >= 4) { rejected++; return; } logoutAudits.push(parsed.data);
  });
  await page.addInitScript(() => {
    const original = globalThis.fetch, document = crypto.randomUUID();
    globalThis.fetch = function(...args: Parameters<typeof fetch>) {
      const [input, init] = args, arm = (globalThis as unknown as { __publicationSubmitLogoutArm?: { id: string; authority: string } }).__publicationSubmitLogoutArm;
      let url: URL;
      try {
        url = new URL(typeof input === "string" ? input : "invalid:", location.href);
        if (!arm || typeof input !== "string" || init?.method !== "POST" || init.body !== undefined || url.origin !== location.origin || url.pathname !== "/api/erp-auth/logout" || url.search || url.hash)
          return Reflect.apply(original, this, args);
      } catch { return Reflect.apply(original, this, args); }
      const state = { windowId: arm.id, document, authority: arm.authority, method: "POST" as const, path: "/api/erp-auth/logout" as const,
        start: Date.now(), startHigh: performance.timeOrigin + performance.now(), resolvedAt: null as number | null, status: null as number | null,
        nativeOk: null as boolean | null, bodyIsNull: null as boolean | null, abortAtResolve: null as boolean | null, fetchError: null as "AbortError" | "Other" | null };
      const digest = crypto.subtle.digest("SHA-256", new TextEncoder().encode(url.href)).then(bytes => Array.from(new Uint8Array(bytes), byte => byte.toString(16).padStart(2, "0")).join(""));
      const emit = () => { const snapshot = { ...state }; void digest.then(urlSha256 =>
        (globalThis as unknown as { __publicationSubmitLogoutAudit(value: unknown): Promise<void> }).__publicationSubmitLogoutAudit({ ...snapshot, urlSha256 })).catch(() => {}); };
      const promise = Reflect.apply(original, this, args);
      void promise.then(response => {
        state.resolvedAt = Date.now(); state.status = response.status; state.nativeOk = response.ok; state.bodyIsNull = response.body === null; state.abortAtResolve = Boolean(init.signal?.aborted); emit();
      }, error => { state.fetchError = error && typeof error === "object" && "name" in error && error.name === "AbortError" ? "AbortError" : "Other"; emit(); });
      // Preserve the original Promise and untouched body. This witnesses only the
      // explicit logout handoff, never a completed body read or any business POST.
      return promise;
    };
  });
  function eligible(request: Request) {
    const url = new URL(request.url()), keys = [...url.searchParams.keys()];
    if (url.origin !== "http://localhost:3130" || url.hash || url.username || url.password || keys.length !== new Set(keys).size) return false;
    if (url.pathname === prefix + "/workspace") return keys.length === 1 && keys[0] === "previewRequestId" && url.searchParams.get("previewRequestId") === binding.previewId;
    if ([prefix + "/receipt", prefix + "/status-receipt"].includes(url.pathname)) return keys.length === 2 && keys.includes("requestKey") && keys.includes("requestChecksum") &&
      [...lookups.values()].some(value => value.kind === (url.pathname.endsWith("/status-receipt") ? "status" : "submit") && value.key === url.searchParams.get("requestKey") && value.checksum === url.searchParams.get("requestChecksum"));
    return !url.search && [...ids].some(id => url.pathname === prefix + "/requests/" + id);
  }
  type Row = ReturnType<typeof base.proof>["requests"][number];
  function permissionTransition(row: Row) {
    const proof = base.proof(), candidates = proof.authorityWindows.filter(window => window.mutationObserved && window.changedAt !== null && window.newAuthority !== null && window.oldAuthority !== window.newAuthority &&
      row.authority === window.oldAuthority && row.at >= window.changedAt && row.terminalAt !== null && row.terminalAt >= window.changedAt && row.terminalAt <= window.end &&
      proof.controls.some(control => control.kind === "permission_change" && control.generation === row.generation && window.start >= control.start && window.end <= control.end));
    if (candidates.length !== 1) return null;
    const window = candidates[0]!, documents = proof.permissionDocuments.filter(document => {
      const request = requests[document.ordinal - 1], observed = proof.requests.find(value => value.ordinal === document.ordinal); if (!request || !observed) return false;
      const url = new URL(request.url()), keys = [...url.searchParams.keys()];
      return observed.navigation && observed.resourceType === "document" && observed.method === "GET" && observed.status === 200 && observed.finished && !observed.failed && observed.generation > row.generation &&
        observed.at >= window.start && observed.terminalAt !== null && observed.terminalAt <= window.end && document.readyAt <= window.end &&
        url.origin === "http://localhost:3130" && url.pathname === "/listings/" + binding.listingId && keys.length === 3 && new Set(keys).size === 3 &&
        keys.every(key => ["listingVersionId", "publicationRequestId", "tab"].includes(key)) && url.searchParams.get("listingVersionId") === binding.versionId &&
        url.searchParams.get("publicationRequestId") === binding.previewId && ["Publish", "Content"].includes(url.searchParams.get("tab") ?? "") &&
        proof.sessionObservations.some(session => session.generation === observed.generation && session.authority === window.newAuthority && session.at >= document.terminalAt && session.at <= window.end);
    });
    if (documents.length !== 1 || !proof.sessionObservations.some(session => session.generation === row.generation && session.authority === window.oldAuthority && session.at <= row.at)) return null;
    return { window, document: documents[0]! };
  }
  function auditFor(row: Row) {
    const request = requests[row.ordinal - 1]; if (!request || !eligible(request) || !["GET", "HEAD"].includes(row.method) || row.authority === null || !known.has(row.authority)) return null;
    if (!base.proof().sessionObservations.some(value => value.generation === row.generation && value.authority === row.authority)) return null;
    const sameStart = (audit: z.infer<typeof Audit>, other: Row) => other.timing.startTime > 0 ? Math.abs(audit.startHigh - other.timing.startTime) <= 25 :
      other.method === "GET" && other.status === null && other.timing.startTime === 0 && other.timing.requestStart === -1 && other.timing.responseStart === -1 && other.timing.responseEnd === -1 &&
      permissionTransition(other) !== null && audit.status === null && audit.resolvedAt === null && audit.signalAbort && audit.fetchError === "AbortError" && !audit.eof && audit.bytes === 0 && audit.reads === 0 &&
      !audit.bodyError && !audit.bodyCancelled && Math.abs(audit.start - other.at) <= 25;
    // The zero-CDP-start branch reuses the original base's unique callback/start
    // pairing only for a witnessed unresolved permission transition. Raw CDP timing
    // stays zero/-1; it never becomes a successful or completed-read observation.
    const urlSha = sha(request.url()), match = (audit: z.infer<typeof Audit>, other: Row) => audit.urlSha256 === urlSha && audit.method === other.method &&
      audit.authority === other.authority && (other.status === null ? audit.status === null : audit.status === other.status) && sameStart(audit, other);
    const found = audits.filter(value => match(value, row)); if (found.length !== 1) return null;
    const reverse = base.proof().requests.filter(other => sha(requests[other.ordinal - 1]!.url()) === urlSha && match(found[0]!, other));
    return reverse.length === 1 ? found[0]! : null;
  }
  function classify(row: Row) {
    if (row.classification) return row.classification;
    const request = requests[row.ordinal - 1]; if (!request) return null;
    if (losses.has(request) && row.method === "POST" && row.status === null && row.failed && lookups.get(request)?.kind === "submit") return "injected_exact_original_submit_201_loss";
    if (row.method === "GET" && row.path === "/api/listings/" + binding.listingId && !new URL(request.url()).search && row.resourceType === "fetch" && !row.navigation && !row.prefetch &&
      row.status === 409 && row.failed && row.aborted && responseCodes.get(request) === "authority_changed" && row.timing.startTime > 0 && row.timing.responseStart >= 0 && row.timing.responseEnd >= row.timing.responseStart && permissionTransition(row)) {
      const proof = base.proof(), match = (audit: typeof proof.readAudit[number], candidate: Row) => audit.path === candidate.path && audit.query === "none" && audit.method === "GET" &&
        audit.status === 409 && candidate.method === "GET" && candidate.query === "none" && candidate.status === 409 && candidate.authority === row.authority && candidate.generation === row.generation &&
        candidate.timing.startTime > 0 && Math.abs(audit.start - candidate.timing.startTime) <= 25;
      const found = proof.readAudit.filter(audit => match(audit, row));
      if (found.length === 1 && proof.requests.filter(candidate => match(found[0]!, candidate)).length === 1 && found[0]!.abort && !found[0]!.eof && !found[0]!.json &&
        found[0]!.bytes === 0 && found[0]!.reads === 0 && !found[0]!.bodyCancelled && !found[0]!.bodyError && found[0]!.fetchError === null)
        return "witnessed_exact_listing_old_authority_409_discard";
    }
    const logout = logoutWindows.find(window => window.id === logoutRequests.get(request));
    if (logout && logout.accepted && row.method === "POST" && row.path === "/api/erp-auth/logout" && !new URL(request.url()).search && request.postData() === null && row.resourceType === "fetch" &&
      !row.navigation && !row.prefetch && row.status === 200 && row.failed && row.aborted && row.authority === null && row.responseAuthority === null && row.personal === logout.authority &&
      row.generation === logout.generation && row.at >= logout.start && row.terminalAt !== null && row.terminalAt <= logout.end && row.timing.startTime > 0 && row.timing.responseStart >= 0 && row.timing.responseEnd >= row.timing.responseStart &&
      base.proof().sessionObservations.some(session => session.generation === row.generation && session.authority === logout.authority && session.at <= row.at)) {
      const matches = logoutAudits.filter(audit => audit.windowId === logout.id && audit.urlSha256 === sha(request.url()) && audit.authority === logout.authority && audit.status === 200 &&
        audit.nativeOk === true && audit.resolvedAt !== null && audit.abortAtResolve === false && audit.fetchError === null && Math.abs(audit.startHigh - row.timing.startTime) <= 25);
      const paired = base.proof().requests.filter(candidate => candidate.method === "POST" && logoutRequests.get(requests[candidate.ordinal - 1]!) === logout.id && matches.some(audit =>
        candidate.timing.startTime > 0 && Math.abs(audit.startHigh - candidate.timing.startTime) <= 25));
      if (matches.length === 1 && paired.length === 1 && paired[0]!.ordinal === row.ordinal && logout.documentOrdinal !== null && logout.sessionStatus === 401 && logout.markerCount === 0)
        return "witnessed_explicit_logout_resolve_and_login_handoff";
    }
    const proof = base.proof(), window = proof.authorityWindows.at(-1), audit = auditFor(row);
    const changed = window?.mutationObserved && window.changedAt !== null && window.newAuthority !== null && row.at >= window.start && row.terminalAt !== null &&
      row.terminalAt >= window.changedAt && row.terminalAt <= window.end && row.authority !== null && [window.oldAuthority, window.newAuthority].includes(row.authority);
    if (changed && held.has(request) && row.failed && row.aborted && row.method === "GET" && eligible(request)) return "controlled_original_submit_held200_discard";
    if (audit && changed && [403, 404].includes(row.status ?? 0) && audit.resolvedAt !== null && audit.abortAtResolve === false && audit.fetchError === null &&
      (row.method === "HEAD" || row.finished || audit.eof && audit.abortAtEof === false && !audit.bodyError && !audit.cancelledBeforeEof)) return "witnessed_current_submit_read_refusal";
    if (audit && changed && row.status === 409 && row.method === "GET" && row.authority === window!.oldAuthority && responseCodes.get(request) === "authority_changed" && row.finished) return "witnessed_old_submit_authority_refusal";
    const controlled = proof.controls.some(value => row.at >= value.start && row.terminalAt !== null && row.terminalAt <= value.end);
    if (row.failed && row.aborted && audit && controlled && row.status === null && audit.signalAbort && audit.fetchError === "AbortError" &&
      audit.bytes === 0 && !audit.eof && !audit.bodyError && !audit.bodyCancelled) return "controlled_exact_submit_unresolved_read_abort";
    if (!row.failed || !row.aborted || !audit || row.status !== 200 || row.responseAuthority !== row.authority || audit.responseAuthority !== row.authority ||
      row.timing.responseStart < 0 || row.timing.responseEnd < row.timing.responseStart || audit.fetchError !== null || audit.cancelledBeforeEof || audit.bodyError) return null;
    if (row.method === "HEAD" && audit.resolvedAt !== null && audit.abortAtResolve === false) return "resolved_exact_submit_head_with_terminal_abort";
    if (row.method === "GET" && audit.eof && audit.abortAtEof === false && (audit.json || audit.reads > 0 && audit.bytes > 0)) return "completed_exact_submit_read_with_terminal_abort";
    return null;
  }
  function accepted(request: Request, raw: unknown) {
    const value = PublicationSubmitRequestViewSchema.parse(raw), lookup = lookups.get(request);
    expect(lookup).toMatchObject({ kind: "submit", key: value.intent.requestKey, checksum: value.intent.requestChecksum });
    expect(sha(publicationSubmitRequestText(value.intent.target))).toBe(value.intent.requestChecksum);
    expect(value.intent.target).toMatchObject({ previewRequestId: binding.previewId, listingId: binding.listingId, listingVersionId: binding.versionId, accountId: binding.accountId });
    expect(value.request).toMatchObject({ listingId: binding.listingId, listingVersionId: binding.versionId, accountId: binding.accountId, parentRequestId: binding.previewId, action: "amazon_submit" });
    ids.add(value.request.id); return value;
  }
  function acceptedRead(request: Request, raw: unknown) {
    const value = PublicationSubmitRequestViewSchema.parse(raw); expect(ids.has(value.request.id)).toBe(true);
    expect(new URL(request.url()).pathname).toBe(prefix + "/requests/" + value.request.id); return value;
  }
  return { ...base,
    async currentAuthority() { const value = await base.currentAuthority(); known.add(value.value); return value; },
    async explicitLogout() {
      const current = await base.currentAuthority(); known.add(current.value);
      const button = page.getByRole("button", { name: "退出登录", exact: true }); await expect(button).toBeVisible(); await expect(button).toBeEnabled();
      const window = { id: randomUUID(), authority: current.value, generation: base.proof().requests.at(-1)!.generation, start: Date.now(), end: Number.POSITIVE_INFINITY,
        documentOrdinal: null as number | null, sessionStatus: null as number | null, markerCount: null as number | null, accepted: false };
      logoutWindows.push(window);
      try {
        await base.control("reload_original", async () => {
          await page.evaluate(arm => { (globalThis as unknown as { __publicationSubmitLogoutArm: typeof arm }).__publicationSubmitLogoutArm = arm; }, { id: window.id, authority: current.value });
          await button.click(); await expect(page).toHaveURL(url => url.origin === "http://localhost:3130" && url.pathname === "/login" && !url.search && !url.hash);
          await page.waitForLoadState("domcontentloaded");
          const session = await page.request.get("/api/erp-auth/session"); window.sessionStatus = session.status(); expect(window.sessionStatus).toBe(401);
          window.markerCount = await page.evaluate(prefix => Array.from({ length: sessionStorage.length }, (_, index) => sessionStorage.key(index)).filter(key => key?.startsWith(prefix)).length, PUBLICATION_SUBMIT_INTENT_PREFIX);
          expect(window.markerCount).toBe(0); await base.stable();
          const documents = base.proof().requests.filter(row => row.method === "GET" && row.navigation && row.resourceType === "document" && row.path === "/login" && row.query === "none" &&
            row.status === 200 && row.finished && !row.failed && row.generation > window.generation && row.at >= window.start && row.terminalAt !== null);
          expect(documents).toHaveLength(1); window.documentOrdinal = documents[0]!.ordinal; window.accepted = true;
        });
        return { windowId: window.id, sessionStatus: window.sessionStatus, markerCount: window.markerCount };
      } finally { window.end = Date.now(); }
    },
    accepted,
    async acceptedResponse(response: Response) { expect(response.status()).toBe(201); const value = accepted(response.request(), await response.json());
      const stamp = response.request().headers()["x-yummyai-context-authority"]; expect(stamp && known.has(stamp)).toBe(true); expect(response.headers()["x-yummyai-context-authority"]).toBe(stamp); return value; },
    acceptedStatus(request: Request, raw: unknown) { const value = PublicationStatusReadViewSchema.parse(raw); expect(lookups.get(request)).toMatchObject({ kind: "status", key: value.requestKey, checksum: value.requestChecksum, requestId: value.requestId });
      expect(sha(publicationStatusRequestText(value.target))).toBe(value.requestChecksum); return value; },
    loss(request: Request, value: PublicationSubmitRequestView, responseAuthority: string | undefined) {
      accepted(request, value); const row = base.proof().requests.find(row => requests[row.ordinal - 1] === request);
      expect(row?.authority && known.has(row.authority)).toBe(true); expect(responseAuthority).toBe(row!.authority); losses.set(request, value.request.id);
    },
    heldSubmission200(request: Request, raw: unknown) { acceptedRead(request, raw); held.add(request); base.held(request); },
    acceptedRead,
    releaseHeld(request: Request) { base.released(request); },
    proof() { const value = base.proof(); return { ...value, submitReadAudit: audits, submitAuditEvents: events, submitAuditRejected: rejected,
      listingAuthorityRefusals: value.requests.filter(row => row.path === "/api/listings/" + binding.listingId && row.method === "GET" && row.status === 409).map(row => ({
        ordinal: row.ordinal, path: row.path, method: row.method, literalAuthorityChanged: responseCodes.get(requests[row.ordinal - 1]!) === "authority_changed", classification: classify(row) })),
      unresolvedSubmitPairs: value.requests.filter(row => row.failed && row.status === null && eligible(requests[row.ordinal - 1]!)).map(row => { const audit = auditFor(row); return {
        ordinal: row.ordinal, auditDocument: audit?.document ?? null, auditSequence: audit?.sequence ?? null, unique: audit !== null,
        timingSource: row.timing.startTime === 0 ? "callback_pair_only_unresolved_permission_transition" : "cdp_start", classification: classify(row) }; }),
      logoutWindows, logoutAudit: logoutAudits, logoutRequestPairs: value.requests.filter(row => logoutRequests.has(requests[row.ordinal - 1]!)).map(row => ({ ordinal: row.ordinal,
        windowId: logoutRequests.get(requests[row.ordinal - 1]!), method: row.method, path: row.path, inputShape: "no_body", classification: classify(row) })),
      knownSubmissionIds: [...ids], original201Losses: [...losses.values()], submitConsole: consoleRows,
      requests: value.requests.map(row => ({ ...row, classification: classify(row) })) }; },
    check() {
      const value = base.proof(), classified = value.requests.map(row => ({ row, classification: classify(row) }));
      expect(classified.filter(({ row, classification }) => row.status !== null && row.status >= 400 && !classification).map(({ row }) => ({ ordinal: row.ordinal, path: row.path, method: row.method, status: row.status }))).toEqual([]);
      expect(classified.filter(({ row, classification }) => row.failed && !classification).map(({ row }) => ({ ordinal: row.ordinal, path: row.path, method: row.method, status: row.status }))).toEqual([]);
      expect(value.requests.filter(row => !row.finished && !row.failed).map(row => ({ ordinal: row.ordinal, method: row.method, path: row.path }))).toEqual([]);
      expect(value.requests.filter(row => row.method === "POST" && row.path.startsWith(prefix) && !lookups.has(requests[row.ordinal - 1]!)).map(row => ({ ordinal: row.ordinal, path: row.path }))).toEqual([]);
      const used = new Set<number>();
      for (const error of consoleRows) {
        const found = classified.filter(({ row, classification }) => classification && !used.has(row.ordinal) && row.path === error.path && sha(requests[row.ordinal - 1]!.url()) === error.urlSha256 && row.terminalAt !== null && Math.abs(error.at - row.terminalAt) <= 2000 &&
          (error.status !== null && error.status === row.status || error.networkFailure && classification === "injected_exact_original_submit_201_loss"));
        expect(found.length).toBe(1); used.add(found[0]!.row.ordinal);
      }
      expect(value.consoleErrors.length).toBe(consoleRows.length); expect(value.pageErrors).toEqual([]); expect(rejected).toBe(0);
    },
  };
}
