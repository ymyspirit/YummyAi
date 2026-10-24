import { createHash } from "node:crypto";
import { expect, type Page, type Request } from "@playwright/test";
import { z } from "zod";
import { PublicationPreviewWorkspaceSchema, publicationPreviewReadCheckInput } from "@yummyai/contracts/marketplace/publication-preview";
import { observePublicationPreview } from "./publication-node-preview-network.test-fixture";

type Binding = { listingId: string; versionId: string; accountId: string; variantSkuId: string; requestId: string; scenario: "listing_self" | "store_self" | "withdraw_store" };
const sha = (text: string) => createHash("sha256").update(text).digest("hex");
const HeadAudit = z.object({ document: z.uuid(), sequence: z.int().positive(), method: z.literal("HEAD"), path: z.string().max(180),
  urlSha256: z.string().regex(/^[a-f0-9]{64}$/), authority: z.string().regex(/^[a-f0-9]{64}$/).nullable(),
  start: z.number().finite(), startHighResolution: z.number().finite(), resolveAt: z.number().finite().nullable(),
  status: z.int().min(100).max(599).nullable(), bodyless: z.boolean().nullable(), abortSeenAtResolve: z.boolean().nullable(),
  signalAbortAt: z.number().finite().nullable(), responseAuthority: z.string().regex(/^[a-f0-9]{64}$/).nullable(),
  fetchError: z.enum(["AbortError", "Other"]).nullable() }).strict();

/** Reuse the frozen exact-Request/real-session/passive-EOF observer, with this family's
 * independently witnessed current-read refusals. No successful body or cancellation is fabricated. */
export async function observePublicationAuthority(page: Page, binding: Binding) {
  const original = await observePublicationPreview(page, binding.listingId), wireRequests: Request[] = [],
    responses = new Map<Request, { errorCode: string | null; urlSha256: string }>(),
    consoleErrors: Array<{ at: number; path: string; urlSha256: string; status: number | null; expectedText: boolean }> = [], workspaceChecks = new Set<string>();
  const windows: Array<{ start: number; end: number; changedAt: number | null; oldAuthority: string; newAuthority: string | null; mutationObserved: boolean }> = [];
  const listingPath = `/api/listings/${binding.listingId}`, requestPath = `/api/erp-publication-preview/requests/${binding.requestId}`;
  const settingsLinks: Array<{ generation: number; authority: string; hrefSha256: string; sourceQuerySha256: string; documentOrdinal: number; observedAt: number[] }> = [];
  const heads: Array<z.infer<typeof HeadAudit>> = []; let headEvents = 0, headRejected = 0;
  await page.exposeBinding("__publicationAuthorityHeadAudit", (source, raw: unknown) => {
    if (source.frame !== page.mainFrame()) return;
    if (++headEvents > 250) { headRejected++; return; }
    const parsed = HeadAudit.safeParse(raw);
    if (!parsed.success || ![listingPath, requestPath, "/api/erp-publication-preview/workspace"].includes(parsed.data.path)) { headRejected++; return; }
    const value = parsed.data, previous = heads.find(item => item.document === value.document && item.sequence === value.sequence);
    if (!previous) { heads.push(value); return; }
    if (["method", "path", "urlSha256", "authority", "start", "startHighResolution"].some(key => previous[key as keyof typeof previous] !== value[key as keyof typeof value]) ||
      previous.resolveAt !== null && value.resolveAt !== null && (previous.resolveAt !== value.resolveAt || previous.status !== value.status || previous.bodyless !== value.bodyless || previous.abortSeenAtResolve !== value.abortSeenAtResolve)) {
      headRejected++; return;
    }
    // A delayed start/abort binding cannot overwrite the first actual resolve observation.
    const resolved = previous.resolveAt !== null && value.resolveAt === null ? previous : value;
    Object.assign(previous, resolved, { signalAbortAt: previous.signalAbortAt ?? value.signalAbortAt, fetchError: previous.fetchError ?? value.fetchError });
  });
  await page.addInitScript(({ listingPath, requestPath, listingId, versionId, accountId }) => {
    const nativeFetch = globalThis.fetch, document = crypto.randomUUID(); let sequence = 0;
    const digest = async (value: string) => Array.from(new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(value))), byte => byte.toString(16).padStart(2, "0")).join("");
    const authority = (raw: string | null) => raw === null ? Promise.resolve(null) : /^[a-f0-9]{64}$/.test(raw) ? Promise.resolve(raw) : digest(raw);
    globalThis.fetch = function(...args: Parameters<typeof fetch>) {
      const [input, init] = args; let url: URL, rawAuthority: string | null, signal: AbortSignal | null | undefined;
      try {
        const method = (init?.method ?? (input instanceof Request ? input.method : "GET")).toUpperCase();
        url = new URL(input instanceof Request ? input.url : String(input), location.href);
        if (method !== "HEAD" || url.origin !== location.origin || url.hash || url.username || url.password) return Reflect.apply(nativeFetch, this, args);
        const keys = [...url.searchParams.keys()];
        if (url.pathname === listingPath || url.pathname === requestPath) { if (url.search) return Reflect.apply(nativeFetch, this, args); }
        else if (url.pathname === "/api/erp-publication-preview/workspace") {
          const ids = url.searchParams.get("accountIds")?.split(",") ?? [];
          if (keys.length !== 3 || new Set(keys).size !== 3 || !keys.every(key => ["listingId", "listingVersionId", "accountIds"].includes(key)) ||
            url.searchParams.get("listingId") !== listingId || url.searchParams.get("listingVersionId") !== versionId || ids.length > 120 ||
            ids.some(id => !/^[a-f0-9]{8}-(?:[a-f0-9]{4}-){3}[a-f0-9]{12}$/.test(id)) || !ids.includes(accountId) ||
            ids.join(",") !== [...new Set(ids)].sort().join(",")) return Reflect.apply(nativeFetch, this, args);
        } else return Reflect.apply(nativeFetch, this, args);
        rawAuthority = new Headers(init?.headers ?? (input instanceof Request ? input.headers : undefined)).get("x-yummyai-context-authority");
        signal = init?.signal ?? (input instanceof Request ? input.signal : undefined);
      } catch { return Reflect.apply(nativeFetch, this, args); }
      const identity = Promise.all([digest(url.href), authority(rawAuthority)]);
      let responseStamp: Promise<string | null> = Promise.resolve(null);
      const state = { document, sequence: ++sequence, method: "HEAD" as const, path: url.pathname, start: Date.now(), startHighResolution: performance.timeOrigin + performance.now(),
        resolveAt: null as number | null, status: null as number | null, bodyless: null as boolean | null, abortSeenAtResolve: null as boolean | null,
        signalAbortAt: signal?.aborted ? Date.now() : null as number | null, fetchError: null as "AbortError" | "Other" | null };
      const emit = () => { const snapshot = { ...state }, stamp = responseStamp;
        void Promise.all([identity, stamp]).then(([[urlSha256, authority], responseAuthority]) =>
          (globalThis as unknown as { __publicationAuthorityHeadAudit(value: unknown): Promise<void> }).__publicationAuthorityHeadAudit({ ...snapshot, urlSha256, authority, responseAuthority })).catch(() => {});
      };
      signal?.addEventListener("abort", () => { state.signalAbortAt ??= Date.now(); emit(); }, { once: true });
      emit(); const promise = Reflect.apply(nativeFetch, this, args);
      void promise.then(response => {
        state.resolveAt = Date.now(); state.status = response.status; state.bodyless = response.body === null; state.abortSeenAtResolve = Boolean(signal?.aborted);
        responseStamp = authority(response.headers.get("x-yummyai-context-authority")); emit();
      }, error => { state.fetchError = error && typeof error === "object" && "name" in error && error.name === "AbortError" ? "AbortError" : "Other"; emit(); });
      return promise;
    };
  }, { listingPath, requestPath, listingId: binding.listingId, versionId: binding.versionId, accountId: binding.accountId });
  const current = () => windows.at(-1);
  page.on("request", request => { if (new URL(request.url()).origin === "http://localhost:3130") wireRequests.push(request); });
  page.on("response", response => {
    const request = response.request(), url = new URL(response.url()); if (url.origin !== "http://localhost:3130") return;
    const info = { errorCode: response.headers()["x-yummyai-error-code"] ?? null, urlSha256: sha(url.href) }; responses.set(request, info);
    if (response.status() === 409 && request.method() === "GET") void response.json().then((body: unknown) => {
      if (body && typeof body === "object" && "code" in body && body.code === "authority_changed") info.errorCode = "authority_changed";
    }).catch(() => {});
  });
  page.on("console", message => {
    if (message.type() !== "error") return;
    try {
      const url = new URL(message.location().url), text = message.text(), match = /^Failed to load resource: the server responded with a status of (403|404|409)(?:\s|$)/.exec(text);
      consoleErrors.push({ at: Date.now(), path: url.pathname, urlSha256: sha(url.href), status: match ? Number(match[1]) : null, expectedText: Boolean(match) });
    } catch { consoleErrors.push({ at: Date.now(), path: "unknown", urlSha256: "", status: null, expectedText: false }); }
  });
  function query(url: URL) {
    if (url.origin !== "http://localhost:3130" || url.hash || url.username || url.password) return null;
    const keys = [...url.searchParams.keys()]; if (keys.length !== new Set(keys).size) return null;
    return JSON.stringify([...url.searchParams.entries()].sort(([a], [b]) => a.localeCompare(b)));
  }
  function sourceQuery(url: URL) {
    const normalized = query(url), keys = [...url.searchParams.keys()];
    if (normalized === null || url.pathname !== `/listings/${binding.listingId}` || !keys.includes("publicationRequestId") ||
      keys.some(key => !["publicationRequestId", "listingVersionId", "tab"].includes(key)) || url.searchParams.get("publicationRequestId") !== binding.requestId ||
      url.searchParams.has("listingVersionId") && url.searchParams.get("listingVersionId") !== binding.versionId ||
      url.searchParams.has("tab") && !["Publish", "Content"].includes(url.searchParams.get("tab")!)) return null;
    return sha(JSON.stringify([url.pathname, normalized]));
  }
  function settingsTarget(url: URL, transport: boolean) {
    const keys = [...url.searchParams.keys()];
    if (query(url) === null || url.pathname !== "/settings/ai" || !keys.includes("returnTo") ||
      keys.some(key => key !== "returnTo" && !(transport && key === "_rsc")) ||
      url.searchParams.has("_rsc") && (!url.searchParams.get("_rsc") || url.searchParams.get("_rsc")!.length > 128)) return null;
    const raw = url.searchParams.get("returnTo")!;
    if (!raw.startsWith("/") || raw.includes("\\") || [...raw].some(char => char.charCodeAt(0) < 32)) return null;
    const back = new URL(raw, "http://localhost:3130"), source = sourceQuery(back);
    if (!source) return null;
    return { hrefSha256: sha(JSON.stringify([url.origin, url.pathname, [...url.searchParams.entries()].filter(([key]) => key !== "_rsc").sort(([a], [b]) => a.localeCompare(b))])), sourceQuerySha256: source };
  }
  async function observeSettingsLink() {
    const before = original.proof(), identity = before.sessionObservations.at(-1);
    if (!identity || before.requests.at(-1)?.generation !== identity.generation) return;
    const links = await page.getByRole("link", { name: "前往 AI 模型配置", exact: true }).evaluateAll(elements =>
      elements.map(element => ({ href: element.getAttribute("href"), pageHref: location.href })));
    if (links.length !== 1 || !links[0]!.href || original.proof().requests.at(-1)?.generation !== identity.generation) return;
    const pageQuery = sourceQuery(new URL(links[0]!.pageHref)), target = settingsTarget(new URL(links[0]!.href, "http://localhost:3130"), false);
    if (!target || !pageQuery || target.sourceQuerySha256 !== pageQuery) return;
    const documents = original.proof().requests.filter(row => row.generation === identity.generation && row.navigation && row.resourceType === "document" &&
      row.method === "GET" && row.status === 200 && row.finished && !row.failed && sourceQuery(new URL(wireRequests[row.ordinal - 1]!.url())) === pageQuery);
    if (documents.length !== 1) return;
    const previous = settingsLinks.find(link => link.generation === identity.generation && link.authority === identity.authority && link.hrefSha256 === target.hrefSha256 &&
      link.sourceQuerySha256 === pageQuery && link.documentOrdinal === documents[0]!.ordinal);
    if (previous) { if (previous.observedAt.length < 25) previous.observedAt.push(Date.now()); }
    else if (settingsLinks.length < 25) settingsLinks.push({ generation: identity.generation, authority: identity.authority, ...target, documentOrdinal: documents[0]!.ordinal, observedAt: [Date.now()] });
  }
  function registerWorkspace(raw: unknown) {
    const value = PublicationPreviewWorkspaceSchema.parse(raw);
    expect(value.listing.id).toBe(binding.listingId); expect(value.listing.versionId).toBe(binding.versionId);
    const check = publicationPreviewReadCheckInput(value); expect(check.accountIds.split(",")).toContain(binding.accountId);
    workspaceChecks.add(query(new URL("/api/erp-publication-preview/workspace?" + new URLSearchParams(check), "http://localhost:3130"))!);
  }
  function expectedPath(request: Request) {
    const url = new URL(request.url()), keys = [...url.searchParams.keys()];
    if (url.pathname === listingPath || url.pathname === requestPath) return !url.search;
    if (url.pathname !== "/api/erp-publication-preview/workspace" || query(url) === null) return false;
    if (request.method() === "HEAD") return workspaceChecks.has(query(url)!);
    return keys.every(key => ["listingId", "listingVersionId", "variantSkuId"].includes(key)) &&
      url.searchParams.get("listingId") === binding.listingId && url.searchParams.get("listingVersionId") === binding.versionId &&
      (!url.searchParams.has("variantSkuId") || url.searchParams.get("variantSkuId") === binding.variantSkuId);
  }
  function headFor(row: ReturnType<typeof original.proof>["requests"][number]) {
    const request = wireRequests[row.ordinal - 1], value = original.proof();
    if (!request || row.method !== "HEAD" || row.resourceType !== "fetch" || row.navigation || !expectedPath(request) || row.status === null ||
      !(row.finished && !row.failed || row.failed && row.aborted) || row.terminalAt === null || row.authority === null ||
      row.timing.startTime <= 0 || row.timing.responseStart < 0 || row.timing.responseEnd < row.timing.responseStart ||
      !value.sessionObservations.some(session => session.generation === row.generation && session.authority === row.authority)) return null;
    const matches = (audit: z.infer<typeof HeadAudit>, candidate: typeof row) => {
      const wire = wireRequests[candidate.ordinal - 1];
      return Boolean(wire && candidate.method === "HEAD" && candidate.status === audit.status && candidate.authority === audit.authority &&
        candidate.path === audit.path && audit.urlSha256 === sha(wire.url()) && candidate.timing.startTime > 0 &&
        Math.abs(audit.startHighResolution - candidate.timing.startTime) <= 25);
    };
    const found = heads.filter(audit => matches(audit, row));
    if (found.length !== 1 || value.requests.filter(candidate => matches(found[0]!, candidate)).length !== 1) return null;
    const audit = found[0]!;
    for (const neighbor of heads.filter(other => other.document === audit.document && other.urlSha256 === audit.urlSha256 && other.authority === audit.authority && other.sequence !== audit.sequence)) {
      const paired = value.requests.filter(candidate => matches(neighbor, candidate));
      if (paired.length === 1 && Math.sign(neighbor.sequence - audit.sequence) !== Math.sign(paired[0]!.ordinal - row.ordinal)) return null;
    }
    // HEAD has no HTTP response content, but browsers may expose a non-null empty
    // stream (MDN Response.body#value). Keep that observed representation; do not read it or invent EOF/bytes.
    if (audit.resolveAt === null || audit.bodyless === null || audit.abortSeenAtResolve !== false || audit.fetchError !== null ||
      audit.responseAuthority !== row.responseAuthority || row.status === 200 && audit.responseAuthority !== row.authority) return null;
    // Both clocks remain in the proof; native resolve is not causally ordered against Node's failure callback.
    return audit;
  }
  function denied(row: ReturnType<typeof original.proof>["requests"][number]) {
    const request = wireRequests[row.ordinal - 1], window = current();
    if (!request || !window?.mutationObserved || window.changedAt === null || window.newAuthority === null ||
      !["GET", "HEAD"].includes(row.method) || row.resourceType !== "fetch" || row.navigation ||
      (row.method === "HEAD" ? !headFor(row) : row.failed || !row.finished) ||
      row.at < window.start || row.terminalAt === null || row.terminalAt < window.changedAt || row.terminalAt > window.end ||
      row.authority === null || ![window.oldAuthority, window.newAuthority].includes(row.authority) ||
      row.timing.startTime <= 0 || row.timing.responseEnd < 0) return null;
    if (expectedPath(request) && row.status === (binding.scenario === "listing_self" ? 404 : 403) &&
      (row.path !== listingPath || binding.scenario === "listing_self")) return "witnessed_current_object_read_refusal";
    const metadata = ["/api/agent-native-v3/workspace", "/api/agent-native-v2/workspace", "/api/agent-native/workspace", "/api/agent-tools/workspace",
      "/api/agent-loops/workspace", "/api/agent-plans/workspace", "/api/agent-commands/workspace", "/api/agent-read/workspace", "/api/ai-assists/task-workspace", "/api/ai-assists/models", "/api/ai-assists/runs"];
    if (binding.scenario === "withdraw_store" && window.oldAuthority !== window.newAuthority && row.status === 409 &&
      (expectedPath(request) || row.method === "GET" && metadata.includes(row.path) && ["none", "assist_page1"].includes(row.query)) && row.authority === window.oldAuthority &&
      responses.get(request)?.errorCode === "authority_changed") return "witnessed_old_authority_metadata_refusal";
    return null;
  }
  function classification(row: ReturnType<typeof original.proof>["requests"][number]) {
    const refusal = denied(row);
    if (refusal) return row.failed && row.method === "HEAD" ? refusal + "_resolved_head_terminal_abort" : refusal;
    if (row.failed && row.aborted && row.method === "HEAD" && row.status === 200 && headFor(row)) return "resolved_exact_head_with_terminal_abort";
    if (row.failed && row.aborted && row.method === "GET" && row.path === "/settings/ai" && row.status === 200 && row.prefetch && row.resourceType === "fetch" &&
      !row.navigation && row.authority === null && row.responseAuthority === null && row.personal !== null && row.terminalAt !== null &&
      row.timing.startTime > 0 && row.timing.responseStart >= 0 && row.timing.responseEnd >= row.timing.responseStart) {
      const value = original.proof(), request = wireRequests[row.ordinal - 1]!, target = settingsTarget(new URL(request.url()), true);
      const controls = value.controls.filter(control => control.kind === "permission_change" && row.at >= control.start && row.terminalAt! <= control.end);
      const identities = [...new Set(value.sessionObservations.filter(identity => identity.generation === row.generation).map(identity => identity.authority))];
      if (target && controls.length === 1 && identities.length === 1 && identities[0] === row.personal) {
        const control = controls[0]!, mutation = windows.filter(window => window.mutationObserved && window.start >= control.start && window.end <= control.end &&
          window.changedAt !== null && row.at >= window.changedAt && window.newAuthority === row.personal && row.terminalAt! <= window.end);
        const links = settingsLinks.filter(link => link.generation === row.generation && link.authority === row.personal && link.hrefSha256 === target.hrefSha256 &&
          link.sourceQuerySha256 === target.sourceQuerySha256 && link.observedAt.some(at => at >= control.start && at <= control.end));
        const documents = value.requests.filter(document => document.generation === row.generation && document.navigation && document.resourceType === "document" && document.method === "GET" &&
          document.status === 200 && document.finished && !document.failed && document.terminalAt !== null && document.terminalAt <= row.at &&
          sourceQuery(new URL(wireRequests[document.ordinal - 1]!.url())) === target.sourceQuerySha256);
        if (mutation.length === 1 && links.length === 1 && documents.length === 1 && links[0]!.documentOrdinal === documents[0]!.ordinal &&
          row.timing.startTime + row.timing.responseEnd <= control.end) return "controlled_exact_dom_settings_prefetch_cancel";
      }
    }
    return row.classification;
  }
  return { ...original, registerWorkspace,
    async currentAuthority() { const identity = await original.currentAuthority(); await observeSettingsLink(); return identity; },
    async stable() { await original.stable(); await observeSettingsLink(); },
    async change<T>(oldAuthority: string, action: () => Promise<T>) {
      return original.control("permission_change", async () => {
        const window = { start: Date.now(), end: Number.POSITIVE_INFINITY, changedAt: null as number | null, oldAuthority, newAuthority: null as string | null, mutationObserved: false };
        windows.push(window); try { return await action(); } finally { window.end = Date.now(); }
      });
    },
    changed(newAuthority: string, sameAuthority: boolean) {
      const window = current(); expect(window?.end).toBe(Number.POSITIVE_INFINITY);
      expect(newAuthority === window!.oldAuthority).toBe(sameAuthority);
      window!.newAuthority = newAuthority; window!.changedAt = Date.now(); window!.mutationObserved = true;
    },
    hasSuccessfulHead(path: string) { return original.proof().requests.some(row => row.path === path && row.status === 200 && headFor(row)); },
    hasDeniedHead(path: string) { return original.proof().requests.some(row => row.method === "HEAD" && row.path === path && denied(row) === "witnessed_current_object_read_refusal"); },
    proof() { const value = original.proof(); return { ...value, authorityWindows: windows, authorizationConsole: consoleErrors, headAudit: heads, headEvents, headRejected, settingsLinks,
      headPairs: value.requests.filter(row => row.method === "HEAD").map(row => { const audit = headFor(row); return { ordinal: row.ordinal,
        auditDocument: audit?.document ?? null, auditSequence: audit?.sequence ?? null, unique: audit !== null }; }),
      requests: value.requests.map(row => ({ ...row, classification: classification(row) })) }; },
    check() {
      const value = original.proof(), refusals = value.requests.filter(row => denied(row));
      expect(value.requests.filter(row => row.status !== null && row.status >= 400 && !denied(row)).map(row => ({ ordinal: row.ordinal, path: row.path, method: row.method, status: row.status }))).toEqual([]);
      expect(value.requests.filter(row => row.failed && !classification(row)).map(row => ({ ordinal: row.ordinal, path: row.path, method: row.method, status: row.status }))).toEqual([]);
      expect(value.requests.filter(row => !row.failed && !row.finished).map(row => ({ ordinal: row.ordinal, path: row.path, method: row.method }))).toEqual([]);
      const available = new Set(refusals.map(row => row.ordinal));
      for (const error of consoleErrors) {
        expect(error.expectedText).toBe(true);
        const matching = refusals.filter(row => available.has(row.ordinal) && row.path === error.path && row.status === error.status &&
          responses.get(wireRequests[row.ordinal - 1]!)?.urlSha256 === error.urlSha256 && row.terminalAt !== null && Math.abs(error.at - row.terminalAt) <= 2000)
          .sort((a, b) => a.ordinal - b.ordinal);
        expect(matching.length).toBe(1); available.delete(matching[0]!.ordinal);
      }
      expect(value.consoleErrors.length).toBe(consoleErrors.length); expect(value.pageErrors).toEqual([]); expect(headRejected).toBe(0);
    },
  };
}
