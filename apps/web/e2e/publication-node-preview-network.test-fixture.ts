import { createHash } from "node:crypto";
import { expect, type Page, type Request, type Locator } from "@playwright/test";
import { z } from "zod";
import { ErpSessionViewSchema, erpSessionAuthority } from "@yummyai/contracts/auth/session";
import { AGENT_RESOURCES_VERSION, AgentResourceCandidatesQuerySchema } from "@yummyai/contracts/ai/agent-resources";

const hash = (value: string) => createHash("sha256").update(value).digest("hex");
const metadata = new Set(["/api/agent-native-v3/workspace", "/api/agent-native-v2/workspace", "/api/agent-native/workspace", "/api/agent-tools/workspace",
  "/api/agent-loops/workspace", "/api/agent-plans/workspace", "/api/agent-commands/workspace", "/api/agent-read/workspace", "/api/ai-assists/task-workspace",
  "/api/ai-assists/models", "/api/ai-assists/runs", "/api/agent-resources/workspace", "/api/agent-fulfillment/workspace"]);
type Query = "none" | "rsc" | "assist_page1" | "preview_workspace" | "preview_receipt" | "settings_return" | "original_source_exact" | "original_return_exact" | "unsupported";
const Audit = z.object({ document: z.string().regex(/^[a-f0-9-]{36}$/), sequence: z.int().positive(), path: z.string().max(180), query: z.enum(["none", "rsc", "assist_page1", "preview_workspace", "preview_receipt", "settings_return", "unsupported"]),
  method: z.enum(["GET", "POST"]), readKind: z.enum(["metadata_get", "original_listing_candidates"]),
  start: z.number().finite(), status: z.int().min(100).max(599).optional(), eof: z.boolean(), json: z.boolean(), bytes: z.int().nonnegative(), reads: z.int().nonnegative(),
  abort: z.boolean(), abortSeenAtEof: z.boolean().nullable(), bodyCancelled: z.boolean(), bodyError: z.boolean(), fetchError: z.enum(["AbortError", "Other"]).nullable() }).strict();
type ReadAudit = z.infer<typeof Audit>;
type Row = { ordinal: number; request: Request; method: string; path: string; query: Query; generation: number; at: number; terminalAt: number | null;
  status: number | null; failed: boolean; aborted: boolean; finished: boolean; authority: string | null; personal: string | null; responseAuthority: string | null;
  navigation: boolean; resourceType: string; prefetch: boolean; timing: ReturnType<Request["timing"]>; classification: string | null };

/** Passive observation of the original reads only. No clone, tee, new read, altered promise or server-action exemption. */
export async function observePublicationPreview(page: Page, listingId: string) {
  const known = new Set<string>(), requests: Row[] = [], reads: ReadAudit[] = [], controls: Array<{ kind: string; start: number; end: number; generation: number }> = [],
    consoleErrors: Array<{ at: number; path: string; consumed: boolean }> = [], pageErrors: string[] = [], losses = new Set<Request>(), held = new Set<Request>(), held200 = new Set<Request>();
  const sessionObservations: Array<{ generation: number; at: number; authority: string }> = [],
    navigationLinks: Array<{ generation: number; at: number; path: string }> = [], selectedListings: Array<{ generation: number; at: number; authority: string }> = [];
  const documentReady: Array<{ generation: number; at: number }> = [], permissionDocuments: Array<{ ordinal: number; generation: number; terminalAt: number; readyAt: number }> = [];
  const prefetchPaths = ["/", "/navigation", "/products", "/orders", "/listings", "/settings/ai", "/business-tasks", "/ai-tasks", `/listings/${listingId}`];
  const candidateRequests = new Set<Request>();
  type NavigationBinding = { kind: "source" | "return"; runId: string; versionId: string };
  const exactTargets: Array<NavigationBinding & { path: string; queryHash: string; generation: number; at: number }> = [],
    originalNavigations: Array<{ kind: "source" | "return"; queryHash: string; generation: number; start: number; end: number; accepted: boolean }> = [];
  const navigationQueryHash = (url: URL) => {
    if (url.origin !== "http://localhost:3130" || url.username || url.password || url.hash) return null;
    const entries = [...url.searchParams.entries()]; if (entries.length !== new Set(entries.map(([key]) => key)).size) return null;
    return hash(JSON.stringify([url.pathname, entries.filter(([key]) => key !== "_rsc").sort(([a], [b]) => a.localeCompare(b))]));
  };
  let personal: string | null = null, generation = 0;
  const queryKind = (url: URL): Query => {
    if (!url.search) return "none"; const keys = [...url.searchParams.keys()]; if (keys.length !== new Set(keys).size) return "unsupported";
    const exact = exactTargets.find(target => target.path === url.pathname && target.queryHash === navigationQueryHash(url));
    if (exact) return exact.kind === "source" ? "original_source_exact" : "original_return_exact";
    if (keys.length === 1 && keys[0] === "_rsc") return "rsc";
    if (url.pathname === "/api/ai-assists/task-workspace" && keys.length === 1 && url.search === "?page=1") return "assist_page1";
    if (url.pathname === "/api/erp-publication-preview/workspace" && keys.every(key => ["listingId", "listingVersionId", "variantSkuId"].includes(key)) && url.searchParams.get("listingId") === listingId) return "preview_workspace";
    if (url.pathname === "/api/erp-publication-preview/receipt" && keys.length === 2 && keys.includes("requestKey") && keys.includes("requestChecksum")) return "preview_receipt";
    if (url.pathname === "/settings/ai" && keys.every(key => key === "returnTo" || key === "_rsc") && url.searchParams.get("returnTo") === "/listings/" + listingId) return "settings_return";
    return "unsupported";
  };
  const eligiblePath = (path: string, query: Query) => query !== "unsupported" && (metadata.has(path) || path === "/api/erp-auth/session" ||
    /^\/api\/agent-native-v3\/runs\/[0-9a-f-]{36}$/.test(path) || path === `/api/listings/${listingId}` ||
    path === "/api/erp-publication-preview/workspace" && query === "preview_workspace" || path === "/api/erp-publication-preview/receipt" && query === "preview_receipt" ||
    /^\/api\/erp-publication-preview\/requests\/[0-9a-f-]{36}(?:\/events)?$/.test(path));
  const state = new Map<string, ReadAudit>();
  await page.exposeBinding("__publicationPreviewReadAudit", ({ frame }, raw: unknown) => {
    if (frame !== page.mainFrame()) return; const parsed = Audit.safeParse(raw); if (!parsed.success) return;
    const allowed = parsed.data.method === "GET" && parsed.data.readKind === "metadata_get" && eligiblePath(parsed.data.path, parsed.data.query) ||
      parsed.data.method === "POST" && parsed.data.readKind === "original_listing_candidates" && parsed.data.path === "/api/agent-resources/candidates" && parsed.data.query === "none";
    if (!allowed) return;
    const value = parsed.data, key = value.document + ":" + value.sequence;
    if (!state.has(key) && state.size >= 250) return;
    state.set(key, value); reads.splice(0, reads.length, ...state.values());
  });
  await page.addInitScript(({ listingId, paths, resourceVersion }) => {
    const original = window.fetch, documentId = crypto.randomUUID(); let sequence = 0;
    type State = { document: string; sequence: number; path: string; query: string; start: number; status?: number; eof: boolean; json: boolean; bytes: number; reads: number;
      method: "GET" | "POST"; readKind: "metadata_get" | "original_listing_candidates";
      abort: boolean; abortSeenAtEof: boolean | null; bodyCancelled: boolean; bodyError: boolean; fetchError: string | null };
    const emit = (value: State) => { try { const binding = (window as unknown as { __publicationPreviewReadAudit?: (value: State) => Promise<void> }).__publicationPreviewReadAudit;
      if (binding) void binding({ ...value }).catch(() => {}); } catch { /* Observation cannot affect the request. */ } };
    window.fetch = function (...args) {
      let selected: State | undefined, signal: AbortSignal | null | undefined;
      try { const raw = args[0], options = args[1], url = new URL(raw instanceof Request ? raw.url : String(raw), location.href), method = options?.method ?? (raw instanceof Request ? raw.method : "GET");
        const verb = method.toUpperCase();
        let candidate = false;
        if (url.origin === location.origin && verb === "POST" && url.pathname === "/api/agent-resources/candidates" && !url.search &&
          typeof options?.body === "string" && options.body.length <= 512 && new Headers(options.headers).get("content-type") === "application/json") {
          const input = JSON.parse(options.body) as Record<string, unknown>;
          candidate = Boolean(input && Object.keys(input).sort().join(",") === "page,pageSize,q,tool,version" && input.version === resourceVersion &&
            input.tool === "listing.version" && input.q === "" && input.page === 1 && input.pageSize === 25);
        }
        if (url.origin === location.origin && (verb === "GET" || candidate)) {
          const keys = [...url.searchParams.keys()]; let query = "unsupported";
          if (!url.search) query = "none";
          else if (new Set(keys).size === keys.length) {
            if (keys.length === 1 && keys[0] === "_rsc") query = "rsc";
            else if (url.pathname === "/api/ai-assists/task-workspace" && url.search === "?page=1") query = "assist_page1";
            else if (url.pathname === "/api/erp-publication-preview/workspace" && keys.every(key => ["listingId", "listingVersionId", "variantSkuId"].includes(key)) && url.searchParams.get("listingId") === listingId) query = "preview_workspace";
            else if (url.pathname === "/api/erp-publication-preview/receipt" && keys.length === 2 && keys.includes("requestKey") && keys.includes("requestChecksum")) query = "preview_receipt";
          }
          const path = url.pathname, eligible = candidate || query !== "unsupported" && (paths.includes(path) || path === "/api/erp-auth/session" || path === `/api/listings/${listingId}` ||
            /^\/api\/agent-native-v3\/runs\/[0-9a-f-]{36}$/.test(path) || path === "/api/erp-publication-preview/workspace" || path === "/api/erp-publication-preview/receipt" || /^\/api\/erp-publication-preview\/requests\/[0-9a-f-]{36}(?:\/events)?$/.test(path));
          if (eligible) { selected = { document: documentId, sequence: ++sequence, path, query, method: candidate ? "POST" : "GET",
            readKind: candidate ? "original_listing_candidates" : "metadata_get", start: Date.now(), eof: false, json: false, bytes: 0, reads: 0,
            abort: false, abortSeenAtEof: null, bodyCancelled: false, bodyError: false, fetchError: null }; signal = options?.signal ?? (raw instanceof Request ? raw.signal : undefined);
            const row = selected; row.abort = signal?.aborted ?? false; signal?.addEventListener("abort", () => { row.abort = true; emit(row); }, { once: true }); emit(row); }
        }
      } catch { /* Unknown paths are not granted an exception. */ }
      const promise = Reflect.apply(original, this, args) as Promise<Response>;
      if (selected) { const row = selected;
        void promise.then(response => { row.status = response.status; emit(row);
          const eof = (json: boolean) => { if (!row.eof) { row.eof = true; row.abortSeenAtEof = row.abort; } row.json ||= json; emit(row); };
          const json = response.json; response.json = function (...params) { const result = Reflect.apply(json, this, params) as Promise<unknown>;
            void result.then(() => eof(true), () => { row.bodyError = true; emit(row); }); return result; };
          if (response.body) { const body = response.body, getReader = body.getReader;
            body.getReader = function (this: ReadableStream<Uint8Array>, ...params: Parameters<typeof getReader>) { const reader = Reflect.apply(getReader, this, params) as ReadableStreamDefaultReader<Uint8Array>, read = reader.read, cancel = reader.cancel;
              reader.read = function (...input) { const result = Reflect.apply(read, this, input) as Promise<ReadableStreamReadResult<Uint8Array>>;
                void result.then(value => { row.reads++; if (value.done) eof(false); else { row.bytes += value.value.byteLength; emit(row); } }, () => { row.bodyError = true; emit(row); }); return result; };
              reader.cancel = function (...input) { row.bodyCancelled = true; emit(row); return Reflect.apply(cancel, this, input); }; return reader;
            } as typeof getReader;
          }
        }, error => { row.fetchError = error instanceof DOMException && error.name === "AbortError" ? "AbortError" : "Other"; emit(row); });
      }
      return promise;
    };
  }, { listingId, paths: [...metadata], resourceVersion: AGENT_RESOURCES_VERSION });
  page.on("request", request => {
    const url = new URL(request.url()); if (url.origin !== "http://localhost:3130") return;
    const navigation = request.frame() === page.mainFrame() && request.isNavigationRequest() && request.resourceType() === "document";
    if (navigation) generation++;
    const headers = request.headers(), raw = headers["x-yummyai-context-authority"];
    if (request.method() === "POST" && url.pathname === "/api/agent-resources/candidates" && !url.search && headers["content-type"] === "application/json") {
      try { const input: unknown = request.postDataJSON(), parsed = AgentResourceCandidatesQuerySchema.safeParse(input);
        if (input && typeof input === "object" && Object.keys(input).sort().join(",") === "page,pageSize,q,tool,version" && parsed.success &&
          parsed.data.tool === "listing.version" && parsed.data.q === "" && parsed.data.page === 1 && parsed.data.pageSize === 25) candidateRequests.add(request);
      } catch { /* Unknown POST input remains rejected. */ }
    }
    requests.push({ ordinal: requests.length + 1, request, method: request.method(), path: url.pathname, query: queryKind(url), generation,
      at: Date.now(), terminalAt: null, status: null, failed: false, aborted: false, finished: false, authority: raw ? /^[a-f0-9]{64}$/.test(raw) ? raw : hash(raw) : null,
      personal, responseAuthority: null, navigation, resourceType: request.resourceType(), prefetch: headers["next-router-prefetch"] === "1" || headers.purpose === "prefetch",
      timing: request.timing(), classification: null });
  });
  page.on("response", response => { const row = requests.find(value => value.request === response.request()); if (!row) return;
    row.status = response.status(); const raw = response.headers()["x-yummyai-context-authority"]; row.responseAuthority = raw ? /^[a-f0-9]{64}$/.test(raw) ? raw : hash(raw) : null; row.timing = row.request.timing(); });
  page.on("requestfinished", request => { const row = requests.find(value => value.request === request); if (row) { row.finished = true; row.terminalAt = Date.now(); row.timing = request.timing(); } });
  page.on("requestfailed", request => { const row = requests.find(value => value.request === request); if (row) { row.failed = true; row.aborted = request.failure()?.errorText === "net::ERR_ABORTED";
    row.terminalAt = Date.now(); row.timing = request.timing(); } });
  page.on("domcontentloaded", () => { documentReady.push({ generation, at: Date.now() }); });
  page.on("console", message => { if (message.type() !== "error") return; let path = "unknown"; try { path = new URL(message.location().url).pathname; } catch { /* No raw console text. */ }
    consoleErrors.push({ at: Date.now(), path, consumed: false }); });
  page.on("pageerror", () => { pageErrors.push("page_error"); });
  async function currentAuthority() { const response = await page.request.get("/api/erp-auth/session"); expect(response.status()).toBe(200);
    const session = ErpSessionViewSchema.parse(await response.json()), raw = erpSessionAuthority(session), value = hash(raw); known.add(value); personal = value;
    const observedGeneration = generation, at = Date.now(); sessionObservations.push({ generation: observedGeneration, at, authority: value });
    const links = await page.locator("a[href]").evaluateAll((elements, paths) => [...new Set(elements.slice(0, 500).flatMap(element => {
      try { const url = new URL(element.getAttribute("href")!, location.href); return url.origin === location.origin && !url.search && !url.hash && paths.includes(url.pathname) ? [url.pathname] : []; }
      catch { return []; }
    }))], prefetchPaths);
    if (generation === observedGeneration) for (const path of links) navigationLinks.push({ generation: observedGeneration, at: Date.now(), path });
    return { value, raw, session }; }
  async function registerOriginalLink(link: Locator, binding: NavigationBinding) {
    const href = await link.getAttribute("href"); expect(href).toBeTruthy(); const url = new URL(href!, "http://localhost:3130");
    expect(url.origin).toBe("http://localhost:3130"); expect(url.username || url.password || url.hash).toBe("");
    const keys = [...url.searchParams.keys()]; expect(new Set(keys).size).toBe(keys.length); expect(keys).not.toContain("_rsc");
    if (binding.kind === "source") {
      expect(url.pathname).toBe(`/listings/${listingId}`); expect(keys.sort()).toEqual(["listingVersionId", "returnTo", "tab"]);
      expect(url.searchParams.get("listingVersionId")).toBe(binding.versionId); expect(url.searchParams.get("tab")).toBe("Publish");
      const back = new URL(url.searchParams.get("returnTo")!, "http://localhost:3130");
      expect(back.origin).toBe("http://localhost:3130"); expect(back.pathname).toBe("/ai-tasks"); expect(back.hash || back.username || back.password).toBe("");
      expect([...back.searchParams.keys()]).toEqual(["agentNativeV3"]); expect(back.searchParams.get("agentNativeV3")).toBe(binding.runId);
    } else {
      expect(url.pathname).toBe("/ai-tasks"); expect(keys).toEqual(["agentNativeV3"]); expect(url.searchParams.get("agentNativeV3")).toBe(binding.runId);
      expect(exactTargets.some(target => target.kind === "source" && target.runId === binding.runId && target.versionId === binding.versionId)).toBe(true);
    }
    const queryHash = navigationQueryHash(url)!;
    if (!exactTargets.some(target => target.kind === binding.kind && target.queryHash === queryHash && target.generation === generation))
      exactTargets.push({ ...binding, path: url.pathname, queryHash, generation, at: Date.now() });
    for (const row of requests) if (row.path === url.pathname && row.query === "unsupported") row.query = queryKind(new URL(row.request.url()));
    return queryHash;
  }
  async function followOriginalLink(link: Locator, binding: NavigationBinding) {
    const queryHash = await registerOriginalLink(link, binding), navigation = { kind: binding.kind, queryHash, generation, start: Date.now(), end: Number.POSITIVE_INFINITY, accepted: false };
    originalNavigations.push(navigation);
    try {
      await link.click(); await expect(page).toHaveURL(url => navigationQueryHash(url) === queryHash);
      await expect(page.getByRole("region", { name: binding.kind === "source" ? "Amazon 节点校验预览" : "十二类原生工具模型任务", exact: true })).toBeVisible();
      navigation.accepted = true;
    } finally { navigation.end = Date.now(); }
  }
  const auditFor = (row: Row) => {
    const close = (audit: ReadAudit) => audit.method === row.method && audit.path === row.path && audit.query === row.query &&
      (audit.readKind === "original_listing_candidates" ? candidateRequests.has(row.request) : row.method === "GET") &&
      (row.status === null ? audit.status === undefined : audit.status === row.status) &&
      Math.abs(audit.start - (row.timing.startTime > 0 ? row.timing.startTime : row.at)) <= 25;
    const found = reads.filter(close); if (found.length !== 1) return null;
    if (requests.filter(other => other.method === row.method && other.path === row.path && other.query === row.query &&
      (found[0]!.readKind !== "original_listing_candidates" || candidateRequests.has(other.request)) &&
      (other.status === null ? found[0]!.status === undefined : other.status === found[0]!.status) &&
      Math.abs(found[0]!.start - (other.timing.startTime > 0 ? other.timing.startTime : other.at)) <= 25).length !== 1) return null;
    return found[0]!;
  };
  function classify(row: Row) {
    if (!row.failed) return null;
    if (losses.has(row.request) && row.method === "POST" && row.status === null && row.path === "/api/erp-publication-preview/requests") return "injected_original201_response_loss";
    if (row.aborted && row.method === "POST" && row.path === "/api/agent-resources/candidates" && row.query === "none" && candidateRequests.has(row.request) &&
      row.status === 200 && row.resourceType === "fetch" && !row.navigation && row.authority && known.has(row.authority) && row.responseAuthority === row.authority &&
      row.timing.startTime > 0 && row.timing.responseEnd >= 0 && controls.some(control => control.kind === "open_original_source" && row.at >= control.start &&
        row.terminalAt !== null && row.terminalAt <= control.end && selectedListings.some(selected => selected.generation === row.generation && selected.authority === row.authority &&
          selected.at >= row.at && selected.at <= control.end))) {
      const audit = auditFor(row);
      if (audit?.readKind === "original_listing_candidates" && audit.eof && audit.abortSeenAtEof === false && audit.bytes > 0 && audit.reads > 0 &&
        !audit.bodyCancelled && !audit.bodyError && !audit.fetchError) return "completed_exact_listing_candidates_read_with_terminal_abort";
    }
    if (!row.aborted || row.method !== "GET") return null;
    if (held200.has(row.request) && row.query === "none" && /^\/api\/erp-publication-preview\/requests\/[0-9a-f-]{36}$/.test(row.path) &&
      row.authority && known.has(row.authority) && personal && known.has(personal) && row.authority !== personal &&
      controls.some(value => value.kind === "permission_change" && row.at <= value.end && row.terminalAt !== null && row.terminalAt >= value.start && row.terminalAt <= value.end))
      return "controlled_original_held200_discard";
    const controlled = controls.some(value => row.at >= value.start && row.at <= value.end && row.terminalAt !== null && row.terminalAt <= value.end);
    const exactRead = eligiblePath(row.path, row.query), stamp = row.authority ?? row.personal;
    if (exactRead && stamp && known.has(stamp) && (row.responseAuthority === null || row.responseAuthority === stamp)) {
      const audit = auditFor(row);
      if (row.status === 200 && row.timing.startTime > 0 && row.timing.responseEnd >= 0 && audit?.eof && audit.abortSeenAtEof === false && !audit.bodyError && !audit.bodyCancelled && !audit.fetchError &&
        (audit.json || audit.reads > 0 && audit.bytes > 0)) return "completed_read_with_terminal_abort";
      if (controlled && audit?.abort && audit.fetchError === "AbortError" && audit.bytes === 0 && !audit.eof && !audit.bodyCancelled && !audit.bodyError && row.status === null) return "controlled_stale_read_abort";
    }
    if (controlled && row.status === 200 && row.resourceType === "fetch" && !row.navigation && ["none", "rsc", "original_source_exact", "original_return_exact"].includes(row.query) &&
      prefetchPaths.includes(row.path) && row.timing.startTime > 0 && row.timing.responseStart >= 0 && row.timing.responseEnd >= 0) {
      const document = requests.filter(value => value.navigation && value.method === "GET" && value.generation === row.generation && value.status === 200 && value.finished &&
        !value.failed && value.at <= row.at && value.terminalAt !== null && value.terminalAt <= row.terminalAt! && ["/ai-tasks", `/listings/${listingId}`].includes(value.path));
      const identities = [...new Set(sessionObservations.filter(value => value.generation === row.generation &&
        controls.some(control => row.at >= control.start && row.terminalAt! <= control.end && value.at <= control.end)).map(value => value.authority))];
      const target = exactTargets.find(value => value.generation === row.generation && value.path === row.path && value.queryHash === navigationQueryHash(new URL(row.request.url())) &&
        controls.some(control => row.at >= control.start && row.terminalAt! <= control.end && value.at <= control.end));
      const literalHref = ["none", "rsc"].includes(row.query) && navigationLinks.some(link => link.generation === row.generation && link.path === row.path && controls.some(control =>
        row.at >= control.start && row.terminalAt! <= control.end && link.at <= control.end));
      if (document.length === 1 && identities.length === 1 && known.has(identities[0]!) && (!row.personal || row.personal === identities[0])) {
        if (row.prefetch && (literalHref || target)) return "intentional_exact_prefetch_cancel";
        if (!row.prefetch && row.query === "original_source_exact" && target?.kind === "source" && originalNavigations.some(value => value.kind === "source" &&
          value.queryHash === target.queryHash && value.generation === row.generation && value.accepted && row.at >= value.start && row.terminalAt! <= value.end))
          return "controlled_original_source_rsc_navigation_cancel";
      }
      // The cached personal snapshot is not a request header; this separate branch does not assert body completion.
      if (row.prefetch && ["none", "rsc"].includes(row.query) && row.authority === null && row.responseAuthority === null &&
        row.personal && known.has(row.personal) && document.length === 1 && identities.length === 1 && known.has(identities[0]!)) {
        const windows = controls.filter(control => control.kind === "permission_change" && row.at >= control.start && row.terminalAt! <= control.end);
        if (windows.length === 1) {
          const control = windows[0]!, originalIdentities = [...new Set(sessionObservations.filter(value => value.generation === control.generation &&
            value.at <= control.start).map(value => value.authority))];
          const transitionDocuments = requests.filter(value => value.navigation && value.resourceType === "document" && value.method === "GET" &&
            value.path === `/listings/${listingId}` && value.generation > control.generation && value.at >= control.start && value.at <= control.end);
          const ready = permissionDocuments.filter(value => value.ordinal === document[0]!.ordinal && value.generation === row.generation &&
            value.terminalAt === document[0]!.terminalAt && value.terminalAt < row.at && value.readyAt < row.at && value.readyAt >= document[0]!.at);
          const fresh = sessionObservations.filter(value => value.generation === row.generation && value.authority === identities[0] &&
            value.at > row.terminalAt! && value.at <= control.end);
          if (transitionDocuments.length === 1 && transitionDocuments[0] === document[0] && ready.length === 1 &&
            originalIdentities.length === 1 && originalIdentities[0] === row.personal && originalIdentities[0] !== identities[0] && fresh.length > 0 &&
            row.timing.startTime >= ready[0]!.readyAt && row.timing.startTime + row.timing.responseEnd <= control.end &&
            navigationLinks.some(link => link.generation === row.generation && link.path === row.path && link.at >= fresh[0]!.at && link.at <= control.end))
            return "permission_document_exact_prefetch_cancel_before_session_observation";
        }
      }
    }
    return null;
  }
  return { currentAuthority, held: (request: Request) => { held.add(request); }, released: (request: Request) => { held.delete(request); },
    registerOriginalLink, followOriginalLink,
    originalHeld200: (request: Request) => { held200.add(request); },
    originalLoss: (request: Request) => { losses.add(request); },
    async originalListingSelected() {
      const choice = page.getByRole("region", { name: "十二类原生工具模型任务", exact: true }).getByRole("combobox", { name: "选择原业务对象", exact: true });
      await expect(choice).toHaveValue(listingId); expect(personal && known.has(personal)).toBeTruthy();
      selectedListings.push({ generation, at: Date.now(), authority: personal! });
    },
    async permissionDocumentReady() {
      const control = controls.at(-1);
      expect(control?.kind).toBe("permission_change"); expect(control?.end).toBe(Number.POSITIVE_INFINITY);
      const documents = () => requests.filter(row => row.navigation && row.resourceType === "document" && row.method === "GET" &&
        row.path === `/listings/${listingId}` && row.generation > control!.generation && row.at >= control!.start && row.at <= control!.end);
      await expect.poll(() => documents().length, { timeout: 20_000 }).toBe(1);
      const document = documents()[0]!;
      await expect.poll(() => ({ count: documents().length, status: document.status, finished: document.finished, failed: document.failed,
        domReady: documentReady.some(row => row.generation === document.generation && row.at >= document.at) }), { timeout: 20_000 })
        .toEqual({ count: 1, status: 200, finished: true, failed: false, domReady: true });
      await page.waitForLoadState("domcontentloaded"); expect(generation).toBe(document.generation);
      permissionDocuments.push({ ordinal: document.ordinal, generation: document.generation, terminalAt: document.terminalAt!,
        readyAt: documentReady.find(row => row.generation === document.generation && row.at >= document.at)!.at });
    },
    async control<T>(kind: "login_and_fill" | "open_original_source" | "refresh_original" | "reload_original" | "permission_change", action: () => Promise<T>) {
      const value = { kind, start: Date.now(), end: Number.POSITIVE_INFINITY, generation }; controls.push(value);
      try { return await action(); } finally { value.end = Date.now(); }
    },
    async stable() { await expect.poll(() => requests.filter(row => !held.has(row.request) && !row.finished && !row.failed).length, { timeout: 20_000 }).toBe(0); },
    proof: () => ({ requests: requests.map(row => ({ ...row, request: undefined, exactListingCandidates: candidateRequests.has(row.request), classification: classify(row) })),
      readAudit: reads, controls, sessionObservations, navigationLinks, selectedListings, exactTargets, originalNavigations, documentReady, permissionDocuments, consoleErrors, pageErrors }),
    check() { const failures = requests.filter(row => row.failed && !classify(row));
      for (const request of losses) { const row = requests.find(value => value.request === request); if (!row?.failed) continue;
        const error = consoleErrors.filter(value => !value.consumed && value.path === row.path && row.terminalAt !== null && Math.abs(value.at - row.terminalAt) <= 2000);
        if (error.length === 1) error[0]!.consumed = true;
      }
      expect(requests.filter(row => row.status !== null && row.status >= 400).map(row => ({ ordinal: row.ordinal, path: row.path, status: row.status }))).toEqual([]);
      expect(failures.map(row => ({ ordinal: row.ordinal, method: row.method, path: row.path, status: row.status, query: row.query }))).toEqual([]);
      expect(requests.filter(row => !row.failed && !row.finished && !held.has(row.request)).map(row => ({ ordinal: row.ordinal, method: row.method, path: row.path }))).toEqual([]);
      expect(consoleErrors.filter(value => !value.consumed)).toEqual([]); expect(pageErrors).toEqual([]);
    } };
}
