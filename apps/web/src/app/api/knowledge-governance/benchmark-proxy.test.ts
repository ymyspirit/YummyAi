import { createHash } from "node:crypto";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { erpSessionAuthority, type ErpSessionView } from "@yummyai/contracts/auth/session";
import { canonicalJson } from "@yummyai/contracts/common/canonical-json";
import {
  BenchmarkCommandReceiptSchema, BenchmarkDatasetSchema, BenchmarkVersionSchema, BusinessBenchmarkCaseSchema, RecordBenchmarkExpenseSchema,
  benchmarkCommandCanonical, type BenchmarkCase,
} from "@yummyai/contracts/knowledge/benchmark";
import { AssistTaskBasisSchema } from "@yummyai/contracts/ai/task-workspace";
import { PersonalSessionError } from "../../../identity/core";

const mocks = vi.hoisted(() => ({
  upstream: vi.fn<typeof fetch>(), identity: vi.fn(),
  current: vi.fn<() => Promise<void>>(), failure: vi.fn<(error: PersonalSessionError) => Response>(),
}));
vi.mock("../../../server-api", () => ({ apiFetch: mocks.upstream }));
vi.mock("../../../erp-auth/server", () => ({
  erpRequestIdentity: mocks.identity, assertErpIdentityCurrent: mocks.current, erpAuthFailure: mocks.failure,
}));
import { GET, POST } from "./[...path]/route";

const origin = "http://localhost:3130", base = "http://127.0.0.1:8130/v1/knowledge-governance/benchmarks";
const ids = {
  tenant: "019f0000-0000-7000-8000-000000000001", actor: "019f0000-0000-7000-8000-000000000002",
  experiment: "019f0000-0000-7000-8000-000000000003", expense: "019f0000-0000-7000-8000-000000000004",
  other: "019f0000-0000-7000-8000-000000000005", dataset: "019f0000-0000-7000-8000-000000000006",
  version: "019f0000-0000-7000-8000-000000000007", item1: "019f0000-0000-7000-8000-000000000008",
  item2: "019f0000-0000-7000-8000-000000000009", case1: "019f0000-0000-7000-8000-000000000010",
  case2: "019f0000-0000-7000-8000-000000000011",
  request: "1b699b6e-e697-4d74-b676-c12218161230",
};
const at = "2026-10-21T08:00:00.000Z";
const actor: ErpSessionView = {
  authenticated: true, canUseErp: true, tenantId: ids.tenant, userId: ids.actor,
  displayName: "Synthetic benchmark operator", organizationName: "Synthetic disposable tenant",
  dataScope: "self", permissions: ["workflow:read", "workflow:manage", "workflow:run", "workflow:approve"],
  permissionScopes: { "workflow:read": "self", "workflow:manage": "self", "workflow:run": "self", "workflow:approve": "self" },
};
const authority = erpSessionAuthority(actor);
const businessActor: ErpSessionView = { ...actor,
  permissions: [...actor.permissions, "procurement:read", "inventory:read", "finance:read", "order:read"],
  permissionScopes: { ...actor.permissionScopes, "procurement:read": "tenant", "inventory:read": "tenant", "finance:read": "tenant", "order:read": "tenant" },
};
const businessAuthority = erpSessionAuthority(businessActor);
const roleActor: ErpSessionView = { ...businessActor,
  permissions: [...businessActor.permissions, "design:read", "design:write", "research:read", "order:pii:read", "order:write", "listing:read", "listing:write", "product:read", "asset:read"],
  permissionScopes: { ...businessActor.permissionScopes, "design:read": "team", "design:write": "self", "research:read": "self", "order:pii:read": "tenant", "order:write": "tenant", "listing:read": "self", "listing:write": "self", "product:read": "team", "asset:read": "self" },
};
const roleAuthority = erpSessionAuthority(roleActor);
const newRoles = ["creative", "order_review", "artwork_preflight", "template_config", "sku_package", "after_sales_review"] as const;
const hash = (value: unknown) => createHash("sha256").update(canonicalJson(value)).digest("hex");
const context = (...path: string[]) => ({ params: Promise.resolve({ path: ["benchmarks", ...path] }) });
function request(path: string, body?: unknown, stamp: string | null = authority) {
  const headers = new Headers(stamp === null ? undefined : { "x-yummyai-context-authority": stamp });
  if (body !== undefined) { headers.set("origin", origin); headers.set("content-type", "application/json"); }
  return new Request(`${origin}/api/knowledge-governance/benchmarks/${path}`, {
    method: body === undefined ? "GET" : "POST", headers,
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
}
const expensePath = `experiments/${ids.experiment}/expenses`;
const expenseContext = () => context("experiments", ids.experiment, "expenses");
const expenseInput = () => ({
  arm: "candidate", expectedExpenseId: null, storageUsd: "0.10", maintenanceUsd: null,
  expectedActivityFingerprint: "a".repeat(64), periodStart: at, periodEnd: "2026-10-21T08:10:00.000Z",
  allocationBasis: "  Synthetic cumulative actual costs  ", confirmedActual: true, requestId: ids.request,
});
const receipt = { id: ids.expense, revision: 1 };
function recordedCommand() {
  const input = RecordBenchmarkExpenseSchema.parse(expenseInput());
  return BenchmarkCommandReceiptSchema.parse({
    requestId: input.requestId, operation: "expense.record", parentId: ids.experiment,
    requestChecksum: createHash("sha256").update(benchmarkCommandCanonical("expense.record", ids.experiment, input)).digest("hex"),
    receipt, createdAt: at,
  });
}
function businessBasis() {
  return { fingerprint: "a".repeat(64),
    input: { kind: "business_review" as const, runId: ids.experiment, comparisonRunId: null,
      expectedFingerprint: "b".repeat(64), expectedTaskFingerprint: "a".repeat(64), taskGoal: "Synthetic fixed analysis" },
    scope: `finance:${ids.experiment}`, href: "/finance", rows: [{ label: "原计算", value: ids.experiment }],
    sources: [{ id: ids.experiment, label: "Synthetic original profit run", href: null }], checks: [], diagnostics: [], methodSelection: null };
}
function roleBasis(role: typeof newRoles[number]) {
  const shared = { expectedTaskFingerprint: "a".repeat(64), taskGoal: "Synthetic fixed role task" };
  const task = role === "creative" ? { ...shared, kind: role, projectId: ids.dataset, scopeId: ids.other, prompt: "Original fixed project prompt", requirements: { mode: "fixed" }, sources: [{ researchItemId: ids.case1, snapshotId: ids.version }] }
    : role === "order_review" ? { ...shared, kind: role, orderLineId: ids.dataset, expectedRevision: 2, expectedSourceVersionId: ids.version }
      : role === "artwork_preflight" ? { ...shared, kind: role, orderLineId: ids.dataset, expectedRevision: 2, expectedEditorVersionId: ids.version }
        : role === "template_config" ? { ...shared, kind: role, inspectionId: ids.dataset }
          : role === "sku_package" ? { ...shared, kind: role, listingId: ids.dataset, expectedVersionId: ids.version }
            : { ...shared, kind: role, caseId: ids.dataset, locale: "en-US", contextNotes: shared.taskGoal, expectedFingerprint: "b".repeat(64) };
  const input = BusinessBenchmarkCaseSchema.shape.task.parse(task);
  const scope = role === "creative" ? `creative:${ids.other}` : role === "template_config" ? `template:${ids.dataset}` : role === "sku_package" ? `listing:${ids.dataset}` : role === "after_sales_review" ? `case:${ids.dataset}` : `order:${ids.dataset}`;
  return AssistTaskBasisSchema.parse({ input, fingerprint: shared.expectedTaskFingerprint, scope, href: "/synthetic-source", rows: [{ label: "原对象", value: ids.dataset }], sources: [{ id: ids.dataset, label: "Synthetic source owned by the original owner", href: null }], checks: [], diagnostics: [], methodSelection: null });
}
function publishedRoleVersion(workflowScope: "self" | "tenant" = "self") {
  const fields = { name: "Six real role protocol fixtures", description: "Original fixed six-role description", items: newRoles.map(role => BusinessBenchmarkCaseSchema.parse({ key: role, role, label: `Original ${role}`, task: roleBasis(role).input, expectedFacts: [], forbiddenClaims: [], expectRefusal: false })) };
  const pinned = fields.items.map((item, ordinal) => ({ id: `019f0000-0000-7000-8000-${String(100 + ordinal).padStart(12, "0")}`, caseId: null, ordinal, fields: item, caseChecksum: hash(item), basisFingerprint: "e".repeat(64), taskFingerprint: item.task.expectedTaskFingerprint,
    sourcePins: Array.from({ length: item.role === "template_config" ? 61 : 1 }, (_, index) => ({ sourceId: `${item.role}-source-${index}`, kind: "business", resourceId: roleBasis(item.role as typeof newRoles[number]).scope, checksum: "a".repeat(64), title: `Original source ${index}`,
      ...(index === 0 ? { resourceBindings: { version: "role-benchmark-resources-v1", teamIds: roleActor.teamIds ?? [], items: [{ kind: "asset", id: ids.other, checksum: "b".repeat(64) }], permissionScopes: { ...roleActor.permissionScopes, "workflow:read": workflowScope } } } : {}) })), method: null, expiresAt: "2026-10-22T08:00:00.000Z" }));
  return BenchmarkVersionSchema.parse({ id: ids.version, datasetId: ids.dataset, version: 2, datasetRevision: 4, name: fields.name, description: fields.description, checksum: hash({ version: "knowledge-benchmark-dataset-v1", fields, items: pinned }), itemCount: pinned.length, dataScope: workflowScope, createdAt: at, basisExpiresAt: "2026-10-22T08:00:00.000Z", items: pinned.map(item => ({ ...item, versionId: ids.version, usable: true })) });
}
function publishedVersion(family: "knowledge" | "business") {
  const items: BenchmarkCase[] = family === "business" ? [{ key: "business_1", role: "business_review", label: "Synthetic finance sample",
    task: businessBasis().input, expectedFacts: ["Use the original run"], forbiddenClaims: ["The bank verified this"], expectRefusal: false },
  { key: "procurement_2", role: "procurement_review", label: "Synthetic procurement sample",
    task: { kind: "procurement_review", stockItemId: ids.other, locationId: ids.dataset,
      expectedFingerprint: "c".repeat(64), expectedTaskFingerprint: "d".repeat(64), taskGoal: "Synthetic replenishment evidence" },
    expectedFacts: [], forbiddenClaims: [], expectRefusal: true }]
    : [1, 2].map(index => ({ key: `knowledge_${index}`, role: "knowledge_answer", calculations: [], evaluation: {
      label: `Synthetic knowledge sample ${index}`, search: { query: `Synthetic question ${index}`, topic: "all", platform: "all", market: "ALL", spuIds: [] },
      expectedFacts: [], forbiddenClaims: [], requiredEntryIds: [], expectRefusal: false } }));
  const fields = { name: "Synthetic original published dataset", description: "Original published description", items };
  const pinned = items.map((item, ordinal) => ({ id: ordinal === 0 ? ids.item1 : ids.item2,
    caseId: item.role === "knowledge_answer" ? ordinal === 0 ? ids.case1 : ids.case2 : null,
    ordinal, fields: item, caseChecksum: hash(item.role === "knowledge_answer" ? item.evaluation : item),
    basisFingerprint: "e".repeat(64), taskFingerprint: "f".repeat(64),
    sourcePins: item.role === "knowledge_answer" ? [] : [{ sourceId: `business-source-${ordinal}`, kind: "business", resourceId: ids.experiment,
      checksum: "a".repeat(64), title: "Synthetic original source" }], method: null, expiresAt: "2026-10-22T08:00:00.000Z" }));
  return BenchmarkVersionSchema.parse({ id: ids.version, datasetId: ids.dataset, version: 1, datasetRevision: 2,
    name: fields.name, description: fields.description,
    checksum: hash({ version: "knowledge-benchmark-dataset-v1", fields, items: pinned }),
    itemCount: 2, dataScope: "self", createdAt: at, basisExpiresAt: "2026-10-22T08:00:00.000Z",
    items: pinned.map(item => ({ ...item, versionId: ids.version, usable: true })) });
}

beforeEach(() => {
  mocks.upstream.mockReset(); mocks.identity.mockReset(); mocks.current.mockReset(); mocks.failure.mockReset();
  vi.stubEnv("API_BASE_URL", "http://127.0.0.1:8130");
  mocks.identity.mockResolvedValue({ view: actor }); mocks.current.mockResolvedValue(undefined);
  mocks.failure.mockImplementation(error => Response.json({ message: "Current personal authority unavailable", code: error.code }, { status: error.status }));
});
afterEach(() => vi.unstubAllEnvs());

describe("personal benchmark BFF protects original command and private evidence", () => {
  it("keeps unknown benchmark paths and duplicate queries out of the legacy transport", async () => {
    for (const parts of [["unknown"], ["toString", ids.dataset], ["datasets", ids.dataset, "extra"], ["experiments", ids.experiment, "attempts", "start"]])
      expect((await GET(request(parts.join("/")), context(...parts))).status).toBe(404);
    expect((await POST(request(`requests/${ids.request}`, {}), context("requests", ids.request))).status).toBe(404);
    expect((await GET(request("datasets?limit=1&limit=2"), context("datasets"))).status).toBe(400);
    expect((await GET(request(`datasets/${ids.dataset}?cursor=${ids.other}`), context("datasets", ids.dataset))).status).toBe(400);
    expect(mocks.upstream).not.toHaveBeenCalled(); expect(mocks.identity).not.toHaveBeenCalled();
  });

  it("requires each current operation permission and the exact personal authority before forwarding", async () => {
    for (const permission of ["workflow:read", "workflow:approve"]) {
      mocks.identity.mockResolvedValue({ view: { ...actor, permissions: actor.permissions.filter(bit => bit !== permission) } });
      expect((await POST(request(expensePath, expenseInput()), expenseContext())).status).toBe(403);
    }
    mocks.identity.mockResolvedValue({ view: { ...actor, permissionScopes: { "workflow:read": "self" } } });
    expect((await POST(request(expensePath, expenseInput()), expenseContext())).status).toBe(403);
    mocks.identity.mockResolvedValue({ view: actor });
    for (const stamp of [null, erpSessionAuthority({ ...actor, userId: ids.other })]) {
      const response = await POST(request(expensePath, expenseInput(), stamp), expenseContext());
      expect(response.status).toBe(409); expect(await response.json()).toMatchObject({ code: "authority_changed" });
    }
    expect(mocks.upstream).not.toHaveBeenCalled();
  });

  it("accepts a 201 only after the exact normalized command receipt is read and bound to its original parent", async () => {
    const original = expenseInput(), normalized = RecordBenchmarkExpenseSchema.parse(original), command = recordedCommand();
    mocks.upstream.mockResolvedValueOnce(Response.json(receipt, { status: 201 })).mockResolvedValueOnce(Response.json(command));
    const response = await POST(request(expensePath, original), expenseContext());
    expect(response.status).toBe(201); expect(await response.json()).toEqual(receipt);
    expect(response.headers.get("x-yummyai-context-authority")).toBe(authority);
    expect(response.headers.get("cache-control")).toBe("private, no-store");
    expect(mocks.upstream).toHaveBeenCalledTimes(2);
    const [writeUrl, write] = mocks.upstream.mock.calls[0]!, [readUrl, read] = mocks.upstream.mock.calls[1]!;
    expect(writeUrl).toBe(`${base}/${expensePath}`); expect(write?.method).toBe("POST");
    expect(JSON.parse(write?.body as string)).toEqual(normalized);
    expect(original.storageUsd).toBe("0.10"); expect(original.allocationBasis).toBe("  Synthetic cumulative actual costs  ");
    expect(readUrl).toBe(`${base}/requests/${ids.request}`); expect(read?.method).toBe("GET"); expect(read?.body).toBeUndefined();
    expect(write?.cache).toBe("no-store"); expect(read?.cache).toBe("no-store");
    expect(new Headers(write?.headers).has("x-tenant-id")).toBe(false);
    const replacedInput = { ...normalized, storageUsd: "0.20000000" };
    const substitutedHash = createHash("sha256").update(benchmarkCommandCanonical("expense.record", ids.experiment, replacedInput)).digest("hex");
    for (const substituted of [
      { ...command, requestChecksum: substitutedHash }, { ...command, parentId: ids.other },
      { ...command, operation: "report.create" }, { ...command, receipt: { ...receipt, id: ids.other } },
      { ...command, receipt: { ...receipt, revision: 2 } },
    ]) {
      mocks.upstream.mockReset();
      mocks.upstream.mockResolvedValueOnce(Response.json(receipt, { status: 201 })).mockResolvedValueOnce(Response.json(substituted));
      expect((await POST(request(expensePath, original), expenseContext())).status).toBe(502);
      expect(mocks.upstream).toHaveBeenCalledTimes(2);
    }
  });

  it("keeps a committed write unknown when its receipt is missing and rejects private 200 data after a late authority change", async () => {
    mocks.upstream.mockResolvedValueOnce(Response.json(receipt, { status: 201 }))
      .mockResolvedValueOnce(Response.json({ message: "SYNTHETIC_PRIVATE_RECEIPT_DIAGNOSTIC" }, { status: 404 }));
    const unknown = await POST(request(expensePath, expenseInput()), expenseContext());
    expect(unknown.status).toBe(502); expect(await unknown.text()).not.toContain("SYNTHETIC_PRIVATE_RECEIPT_DIAGNOSTIC");
    expect(mocks.upstream).toHaveBeenCalledTimes(2);
    expect(mocks.upstream.mock.calls.map(([, init]) => init?.method)).toEqual(["POST", "GET"]);

    const privateName = "SYNTHETIC_PRIVATE_DATASET_NAME";
    const record = BenchmarkDatasetSchema.parse({
      id: ids.dataset, revision: 1, name: privateName, itemCount: 1, createdAt: at, updatedAt: at,
      fields: { name: privateName, description: "Synthetic private draft", items: [{
        key: "sample_1", role: "knowledge_answer", calculations: [], evaluation: {
          label: "Synthetic question", search: { query: "Synthetic private question", topic: "all", platform: "all", market: "ALL", spuIds: [] },
          expectedFacts: [], forbiddenClaims: [], requiredEntryIds: [], expectRefusal: false,
        },
      }] },
    });
    let bodyRead = false, revoked = false;
    const stream = new ReadableStream<Uint8Array>({ pull(controller) {
      bodyRead = true; revoked = true;
      controller.enqueue(new TextEncoder().encode(JSON.stringify(record))); controller.close();
    } }, { highWaterMark: 0 });
    mocks.upstream.mockReset(); mocks.current.mockReset();
    mocks.current.mockImplementation(async () => { if (revoked) throw new PersonalSessionError(409, "authority_changed"); });
    mocks.upstream.mockResolvedValueOnce(new Response(stream, { status: 200, headers: { "content-type": "application/json" } }));
    const denied = await GET(request(`datasets/${ids.dataset}`), context("datasets", ids.dataset));
    expect(bodyRead).toBe(true); expect(denied.status).toBe(409);
    const deniedBody = await denied.text(); expect(deniedBody).toContain("authority_changed"); expect(deniedBody).not.toContain(privateName);
    expect(mocks.upstream).toHaveBeenCalledOnce();
    expect(denied.headers.get("cache-control")).toBe("private, no-store");

    mocks.current.mockReset(); mocks.current.mockResolvedValue(undefined); mocks.upstream.mockReset();
    mocks.upstream.mockResolvedValueOnce(Response.json({ message: "SYNTHETIC_PRIVATE_ACTIVITY_DIAGNOSTIC" }, { status: 412 }));
    const outdatedPeriod = await POST(request(expensePath, expenseInput()), expenseContext());
    expect(outdatedPeriod.status).toBe(412); expect(await outdatedPeriod.text()).not.toContain("SYNTHETIC_PRIVATE_ACTIVITY_DIAGNOSTIC");
    expect(mocks.upstream).toHaveBeenCalledOnce();
  });

  it("retains the two original aggregate tenant gates and explicit partial results", async () => {
    for (const path of ["task-targets?kind=knowledge_answer", "task-targets?kind=business_review&kind=procurement_review", "task-targets?kind=business_review&cursor=" + ids.other])
      expect((await GET(request(path), context("task-targets"))).status).toBe(400);
    expect((await GET(request("task-basis"), context("task-basis"))).status).toBe(404);
    expect((await POST(request("task-targets", {}), context("task-targets"))).status).toBe(404);
    expect(mocks.upstream).not.toHaveBeenCalled();
    for (const [kind, bit] of [["business_review", "finance:read"], ["business_review", "order:read"], ["procurement_review", "procurement:read"], ["procurement_review", "inventory:read"]] as const) {
      const narrowed = { ...businessActor, permissionScopes: { ...businessActor.permissionScopes, [bit]: "self" as const } };
      mocks.identity.mockResolvedValue({ view: narrowed });
      expect((await GET(request(`task-targets?kind=${kind}`, undefined, erpSessionAuthority(narrowed)), context("task-targets"))).status).toBe(403);
    }
    expect(mocks.upstream).not.toHaveBeenCalled();
    mocks.identity.mockResolvedValue({ view: businessActor });
    for (const [kind, target] of [["business_review", ids.experiment], ["procurement_review", `${ids.other}:${ids.dataset}`]] as const) {
      const targets = { items: [{ id: target, label: "Synthetic actual target", detail: "Existing owner record", href: "/finance" }], hasMore: true };
      mocks.upstream.mockResolvedValueOnce(Response.json(targets));
      const response = await GET(request(`task-targets?kind=${kind}&q=%20Synthetic%20`, undefined, businessAuthority), context("task-targets"));
      expect(response.status).toBe(200); expect(await response.json()).toEqual(targets);
      expect(response.headers.get("x-yummyai-context-authority")).toBe(businessAuthority);
      expect(mocks.upstream.mock.calls.at(-1)?.[0]).toBe(`${base}/task-targets?kind=${kind}&q=Synthetic`);
    }
    mocks.upstream.mockResolvedValueOnce(Response.json({ items: [{ id: ids.experiment, label: "Wrong target shape", detail: "", href: "/procurement" }], hasMore: false }));
    expect((await GET(request("task-targets?kind=procurement_review", undefined, businessAuthority), context("task-targets"))).status).toBe(502);
  });

  it("reads a fixed business basis without a mutation receipt and rejects substituted targets, scope, or task pins", async () => {
    const input = { kind: "business_review", targetId: ids.experiment.toUpperCase(), taskGoal: "  Synthetic fixed analysis  " };
    expect((await POST(request("task-basis", input), context("task-basis"))).status).toBe(403);
    expect(mocks.upstream).not.toHaveBeenCalled();
    for (const permission of ["workflow:run", "workflow:manage"]) {
      const narrowed = { ...businessActor, permissions: businessActor.permissions.filter(bit => bit !== permission) };
      mocks.identity.mockResolvedValue({ view: narrowed });
      expect((await POST(request("task-basis", input, erpSessionAuthority(narrowed)), context("task-basis"))).status).toBe(403);
    }
    expect(mocks.upstream).not.toHaveBeenCalled();
    mocks.identity.mockResolvedValue({ view: businessActor });
    const basis = businessBasis();
    mocks.upstream.mockResolvedValueOnce(Response.json(basis));
    const response = await POST(request("task-basis", input, businessAuthority), context("task-basis"));
    expect(response.status).toBe(200); expect(await response.json()).toEqual(basis);
    expect(mocks.upstream).toHaveBeenCalledOnce();
    const [url, transport] = mocks.upstream.mock.calls[0]!;
    expect(url).toBe(`${base}/task-basis`); expect(transport?.method).toBe("POST");
    expect(JSON.parse(transport?.body as string)).toEqual({ ...input, targetId: ids.experiment, taskGoal: "Synthetic fixed analysis" });
    expect(transport?.signal).toBeInstanceOf(AbortSignal);
    expect(basis.input.expectedFingerprint).not.toBe(basis.fingerprint);
    for (const replaced of [
      { ...basis, input: { ...basis.input, runId: ids.other } },
      { ...basis, input: { ...basis.input, comparisonRunId: ids.other } },
      { ...basis, input: { ...basis.input, expectedTaskFingerprint: "c".repeat(64) } },
      { ...basis, input: { ...basis.input, taskGoal: "Different fixed goal" } },
      { ...basis, scope: `finance:${ids.other}` },
    ]) {
      mocks.upstream.mockReset(); mocks.upstream.mockResolvedValueOnce(Response.json(replaced));
      expect((await POST(request("task-basis", input, businessAuthority), context("task-basis"))).status).toBe(502);
      expect(mocks.upstream).toHaveBeenCalledOnce();
    }
    mocks.upstream.mockReset();
    expect((await POST(request("task-basis", { ...input, requestId: ids.request }, businessAuthority), context("task-basis"))).status).toBe(400);
    expect(mocks.upstream).not.toHaveBeenCalled();
  });

  it("verifies both original knowledge and business manifests including original description and every source pin", async () => {
    mocks.identity.mockResolvedValue({ view: businessActor });
    for (const family of ["knowledge", "business"] as const) {
      const version = publishedVersion(family);
      mocks.upstream.mockResolvedValueOnce(Response.json(version));
      const response = await GET(request(`versions/${ids.version}`, undefined, businessAuthority), context("versions", ids.version));
      expect(response.status).toBe(200); expect(await response.json()).toEqual(version);
      const missingDescription = { ...version, description: undefined };
      const alteredItem = structuredClone(version); alteredItem.items[0]!.basisFingerprint = "0".repeat(64);
      const alteredField = structuredClone(version);
      if (alteredField.items[0]!.fields.role === "knowledge_answer") alteredField.items[0]!.fields.evaluation.label = "Substituted current draft";
      else alteredField.items[0]!.fields.label = "Substituted current draft";
      for (const substituted of [missingDescription, { ...version, description: "Today's draft description" }, alteredItem, alteredField]) {
        mocks.upstream.mockResolvedValueOnce(Response.json(substituted));
        expect((await GET(request(`versions/${ids.version}`, undefined, businessAuthority), context("versions", ids.version))).status).toBe(502);
      }
      if (family === "business") {
        const alteredPin = structuredClone(version); alteredPin.items[0]!.sourcePins[0]!.checksum = "0".repeat(64);
        mocks.upstream.mockResolvedValueOnce(Response.json(alteredPin));
        expect((await GET(request(`versions/${ids.version}`, undefined, businessAuthority), context("versions", ids.version))).status).toBe(502);
        expect(version.items.every(item => item.caseId === null && item.caseChecksum === hash(item.fields))).toBe(true);
      }
    }
  });

  it.each(newRoles)("binds the %s real selector and read-only basis without a model or mutation receipt", async role => {
    mocks.identity.mockResolvedValue({ view: roleActor });
    const targets = { items: [{ id: ids.dataset, label: `Real owner target for ${role}`, detail: "Server-authorized original object", href: "/synthetic-source" }], hasMore: true };
    mocks.upstream.mockResolvedValueOnce(Response.json(targets));
    const selected = await GET(request(`task-targets?kind=${role}`, undefined, roleAuthority), context("task-targets"));
    expect(selected.status).toBe(200); expect(await selected.json()).toEqual(targets);
    mocks.upstream.mockReset();
    const basis = roleBasis(role), input = { kind: role, targetId: ids.dataset, taskGoal: "Synthetic fixed role task" };
    mocks.upstream.mockResolvedValueOnce(Response.json(basis));
    const response = await POST(request("task-basis", input, roleAuthority), context("task-basis"));
    expect(response.status).toBe(200); expect(await response.json()).toEqual(basis);
    expect(mocks.upstream).toHaveBeenCalledOnce(); expect(mocks.upstream.mock.calls[0]?.[0]).toBe(`${base}/task-basis`);
    for (const replaced of [{ ...basis, scope: "another-owner-scope" }, { ...basis, input: { ...basis.input, expectedTaskFingerprint: "0".repeat(64) } }]) {
      mocks.upstream.mockReset(); mocks.upstream.mockResolvedValueOnce(Response.json(replaced));
      expect((await POST(request("task-basis", input, roleAuthority), context("task-basis"))).status).toBe(502);
      expect(mocks.upstream).toHaveBeenCalledOnce();
    }
    if (role === "artwork_preflight" || role === "after_sales_review") {
      for (const patch of role === "artwork_preflight" ? [{ automaticAudit: true }, { retryAudit: true }] : [{ locale: "zh-CN" }, { contextNotes: "Unrequested notes" }]) {
        mocks.upstream.mockReset(); mocks.upstream.mockResolvedValueOnce(Response.json({ ...basis, input: { ...basis.input, ...patch } }));
        expect((await POST(request("task-basis", input, roleAuthority), context("task-basis"))).status).toBe(502);
      }
    }
  });

  it("uses each role's actual read/run scope without borrowing workflow or imposing tenant on creative resources", async () => {
    for (const [role, bit, scope] of [
      ["order_review", "order:pii:read", "self"], ["after_sales_review", "order:read", "team"],
      ["artwork_preflight", "design:read", null], ["template_config", "design:write", null],
      ["sku_package", "listing:write", null], ["creative", "research:read", null],
      ["order_review", "order:write", "self"],
    ] as const) {
      const narrowed: ErpSessionView = { ...roleActor, permissions: scope === null ? roleActor.permissions.filter(value => value !== bit) : roleActor.permissions, permissionScopes: { ...roleActor.permissionScopes, ...(scope === null ? {} : { [bit]: scope }) } };
      mocks.identity.mockResolvedValue({ view: narrowed });
      const response = await POST(request("task-basis", { kind: role, targetId: ids.dataset, taskGoal: "Synthetic fixed role task" }, erpSessionAuthority(narrowed)), context("task-basis"));
      expect(response.status).toBe(403);
    }
    expect(mocks.upstream).not.toHaveBeenCalled();
    const readOnly: ErpSessionView = { ...roleActor, permissions: roleActor.permissions.filter(bit => !bit.endsWith(":write") && !["workflow:manage", "workflow:run"].includes(bit)) };
    mocks.identity.mockResolvedValue({ view: readOnly });
    mocks.upstream.mockResolvedValueOnce(Response.json({ items: [], hasMore: false }));
    expect((await GET(request("task-targets?kind=creative", undefined, erpSessionAuthority(readOnly)), context("task-targets"))).status).toBe(200);
  });

  it("keeps all sealed role sources and resource scopes while allowing owner-authorized read narrowing without old write grants", async () => {
    const version = publishedRoleVersion("tenant");
    const readOnly: ErpSessionView = { ...roleActor, dataScope: "tenant", permissions: roleActor.permissions.filter(bit => !bit.endsWith(":write") && !["workflow:manage", "workflow:run", "workflow:approve"].includes(bit)), permissionScopes: { ...roleActor.permissionScopes, "workflow:read": "tenant", "design:read": "self", "product:read": "self", "asset:read": "self" } };
    mocks.identity.mockResolvedValue({ view: readOnly });
    mocks.upstream.mockResolvedValueOnce(Response.json(version));
    const response = await GET(request(`versions/${ids.version}`, undefined, erpSessionAuthority(readOnly)), context("versions", ids.version));
    expect(response.status).toBe(200); expect(await response.json()).toEqual(version);
    expect(version.dataScope).toBe("tenant"); expect(readOnly.permissionScopes).toMatchObject({ "workflow:read": "tenant", "design:read": "self", "product:read": "self", "asset:read": "self" });
    expect(readOnly.permissions.some(bit => bit.endsWith(":write") || ["workflow:manage", "workflow:run", "workflow:approve"].includes(bit))).toBe(false);
    expect(version.items.find(item => item.fields.role === "template_config")?.sourcePins).toHaveLength(61);
    const replaced = structuredClone(version), first = replaced.items[0]!.sourcePins[0]!;
    if (!("kind" in first) || !first.resourceBindings) throw new Error("Synthetic role resources missing");
    first.resourceBindings.items[0]!.id = ids.case2;
    mocks.upstream.mockResolvedValueOnce(Response.json(replaced));
    expect((await GET(request(`versions/${ids.version}`, undefined, erpSessionAuthority(readOnly)), context("versions", ids.version))).status).toBe(502);
    for (const missing of ["asset:read", "product:read"]) {
      const noDynamic: ErpSessionView = { ...readOnly, permissions: readOnly.permissions.filter(bit => bit !== missing) };
      mocks.identity.mockResolvedValue({ view: noDynamic }); mocks.upstream.mockResolvedValueOnce(Response.json({ message: version.name }, { status: 403 }));
      const denied = await GET(request(`versions/${ids.version}`, undefined, erpSessionAuthority(noDynamic)), context("versions", ids.version));
      expect(denied.status).toBe(403); expect(await denied.text()).not.toContain(version.name);
      // An upstream that wrongly returns private 200 content still fails closed
      // at this transport boundary; it is not recast as a legitimate read.
      mocks.upstream.mockResolvedValueOnce(Response.json(version));
      const invalidPrivate = await GET(request(`versions/${ids.version}`, undefined, erpSessionAuthority(noDynamic)), context("versions", ids.version));
      expect(invalidPrivate.status).toBe(502); expect(await invalidPrivate.text()).not.toContain(version.name);
    }
  });
});
