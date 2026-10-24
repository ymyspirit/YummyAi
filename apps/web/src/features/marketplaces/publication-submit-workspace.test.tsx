import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { Permission } from "@yummyai/authz/permissions";
import { CreatePublicationSubmitInputSchema, PublicationSubmitWorkspaceSchema, PublicationSubmitRequestViewSchema, PublicationStatusReadViewSchema,
  publicationSubmitRequestText, publicationStatusRequestText, type PublicationSubmitTarget, type PublicationStatusTarget } from "@yummyai/contracts/marketplace/publication-submit";
import { PersonalSessionError } from "../../identity/core";
import { PersonalAccessFixture } from "../identity/erp-access.fixture";
import { previewId, publicationPreviewFixture } from "./publication-preview.test-fixture";
import { PublicationSubmitWorkspace } from "./publication-submit-workspace";
import { PublicationSubmitReceipt, PublicationStatusReceipt } from "./publication-submit-receipt";
import { publicationSubmitHash, readPublicationSubmitWorkspace, createPublicationSubmission, readPublicationSubmitReceipt, verifyPublicationStatus, verifyPublicationSubmission,
  publicationSubmitDenied, PublicationSubmitError } from "./publication-submit-client";
import { publicationSubmitProxy } from "../../app/api/erp-publication-submit/proxy";

const boundary = vi.hoisted(() => ({ api: vi.fn(), current: vi.fn(), identity: vi.fn() }));
vi.mock("../../server-api", () => ({ apiFetch: boundary.api }));
vi.mock("../../erp-auth/server", () => ({ erpRequestIdentity: boundary.identity, assertErpIdentityCurrent: boundary.current,
  erpAuthFailure: (error: { status: number; code: string }) => Response.json({ message: "Current identity unavailable", code: error.code }, { status: error.status }) }));
beforeEach(() => { boundary.api.mockReset(); boundary.current.mockReset().mockResolvedValue(undefined); boundary.identity.mockReset(); process.env.API_BASE_URL = "http://api.invalid"; });
afterEach(() => { vi.unstubAllGlobals(); });
async function fixture() {
  const preview = await publicationPreviewFixture(); preview.value.request.current.status = "validation_passed"; preview.value.execution!.state = "succeeded";
  const context = { ...preview.context, previewRequestId: preview.value.request.id };
  const target: PublicationSubmitTarget = { ...preview.target, previewRequestId: context.previewRequestId, previewEventId: preview.value.request.current.id,
    previewEventSequence: preview.value.request.current.sequence, previewExecutionId: preview.value.execution!.id, sku: "SYNTHETIC-FORMAL-SKU" };
  const input = CreatePublicationSubmitInputSchema.parse({ ...target, requestKey: previewId(19), requestChecksum: await publicationSubmitHash(publicationSubmitRequestText(target)), acknowledgeReplacement: true });
  const statusTarget: PublicationStatusTarget = { ...preview.target, publicationRequestId: previewId(20), submissionExecutionId: previewId(21), submissionTargetChecksum: input.requestChecksum,
    sourceEventId: previewId(22), sourceEventSequence: 1, sourceSubmissionId: null, sku: target.sku };
  const value = PublicationSubmitRequestViewSchema.parse({ protocol: "erp-publication-submit-v1", request: { ...preview.value.request, id: statusTarget.publicationRequestId,
    action: "amazon_submit", parentRequestId: target.previewRequestId, current: { ...preview.value.request.current, id: statusTarget.sourceEventId, status: "queued" } },
    intent: { requestKey: input.requestKey, requestChecksum: input.requestChecksum, target }, execution: { ...preview.value.execution, id: statusTarget.submissionExecutionId, state: "waiting_node" },
    result: null, statusTarget, statusReads: [], access: { canCancel: true, canReadStatus: true }, statusReason: "ready" });
  const workspace = PublicationSubmitWorkspaceSchema.parse({ protocol: value.protocol, context: { actorId: context.actorId, tenantId: context.tenantId, authority: context.authority },
    preview: preview.value, target, access: { canRead: true, canSubmit: true }, reason: "ready", recent: [], observedAt: "2026-10-23T00:00:00.000Z" });
  const status = PublicationStatusReadViewSchema.parse({ protocol: value.protocol, id: previewId(23), requestId: value.request.id, requestKey: previewId(24),
    requestChecksum: await publicationSubmitHash(publicationStatusRequestText(statusTarget)), target: statusTarget, execution: { ...value.execution, id: previewId(25) },
    result: { publicationRequestId: value.request.id, payloadChecksum: target.payloadChecksum, externalListingId: target.sku, externalState: "DISCOVERABLE", issues: [],
      submittedAt: "2026-10-23T00:00:00.000Z", status: "published", sourceSubmissionId: null }, adoptedAsRequestStatus: false, createdAt: "2026-10-23T00:00:00.000Z" });
  const receipt = { protocol: value.protocol, requestKey: input.requestKey, requestChecksum: input.requestChecksum, found: true, request: value, observedAt: workspace.observedAt };
  return { context, target, input, value, workspace, status, receipt };
}
const json = (body: unknown, authority: string, status = 200) => Response.json(body, { status, headers: { "x-yummyai-context-authority": authority } });
const okHead = (authority: string) => new Response(null, { headers: { "x-yummyai-context-authority": authority } });
function identity(context: { authority: string; actorId: string; tenantId: string }, permissions: Permission[] = [Permission.ListingRead, Permission.StoreRead, Permission.ListingPublish]) {
  boundary.identity.mockResolvedValue({ authority: context.authority, view: { userId: context.actorId, tenantId: context.tenantId, permissions, dataScope: "tenant" } });
}
function incoming(path: string, authority: string, body?: unknown, method = body === undefined ? "GET" : "POST") {
  return new Request(`http://localhost/api/erp-publication-submit/${path}`, { method, headers: { origin: "http://localhost", "x-yummyai-context-authority": authority,
    ...(body === undefined ? {} : { "content-type": "application/json" }) }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
}
describe("publication submit interface and transport", () => {
  it("opens only an explicit read-only disclosure and requires Listing and Store reads separately before showing private content", () => {
    const props = { previewRequestId: previewId(11), listingId: previewId(3), listingVersionId: previewId(4) };
    for (const permissions of [[], [Permission.ListingRead], [Permission.StoreRead]]) {
      const html = renderToStaticMarkup(<PersonalAccessFixture permissions={permissions}><PublicationSubmitWorkspace {...props} /></PersonalAccessFixture>);
      expect(html).toContain("原正式提交资料已隐藏"); expect(html).not.toContain("核对正式提交完整替换");
    }
    const html = renderToStaticMarkup(<PersonalAccessFixture permissions={[Permission.ListingRead, Permission.StoreRead, Permission.ListingPublish]}><PublicationSubmitWorkspace {...props} /></PersonalAccessFixture>);
    expect(html).toContain("正式提交本次原预览"); expect(html).not.toContain("<details class=\"psu-workspace\" open"); expect(html).not.toContain("确认正式提交至 Amazon");
    expect(html).not.toContain("SYNTHETIC-FORMAL-SKU");
  });
  it("shows fixed original identifiers and honest replacement, unknown-write and independent SKU-observation meanings", async () => {
    const { value, status } = await fixture(); value.execution.state = "unknown_outcome"; value.request.current.status = "reconciliation_required";
    const html = renderToStaticMarkup(<PublicationSubmitReceipt value={value} busy={false} cancelBlocked={true} onRefresh={() => {}} onCancel={() => {}} />);
    for (const original of [value.request.id, value.request.listingVersionId, value.intent.requestChecksum, value.intent.target.sku]) expect(html).toContain(original);
    expect(html).toContain("完整替换"); expect(html).toContain("不换键重新提交"); expect(html).toContain("不等于已经可售");
    const observed = renderToStaticMarkup(<PublicationStatusReceipt value={status} />);
    expect(observed).toContain("不能证明原未知 PUT 已成功"); expect(observed).toContain("不能据此将原正式提交标为成功"); expect(observed).toContain(status.id);
  });
  it("accepts a new status node only for the exact original submission source and rejects changed write pins or checksums", async () => {
    const { value, status } = await fixture();
    await verifyPublicationSubmission(value);
    status.target.nodeId = previewId(40); status.target.certificateGeneration = 5; status.target.bindingRevision = 7;
    status.execution.nodeId = status.target.nodeId; status.execution.certificateGeneration = 5; status.execution.bindingRevision = 7;
    status.requestChecksum = await publicationSubmitHash(publicationStatusRequestText(status.target));
    await expect(verifyPublicationStatus(status, { parent: value })).resolves.toBeUndefined();
    await expect(verifyPublicationStatus({ ...status, target: { ...status.target, submissionTargetChecksum: "0".repeat(64) } }, { parent: value })).rejects.toThrow();
    await expect(verifyPublicationSubmission({ ...value, execution: { ...value.execution, nodeId: previewId(41) } })).rejects.toThrow();
  });
  it("uses an exact final same-object HEAD after parsing and refuses a delayed 200 when access or response authority changes", async () => {
    const { context, workspace } = await fixture(), fetcher = vi.fn().mockResolvedValueOnce(json(workspace, context.authority)).mockResolvedValueOnce(new Response(null, { status: 403 })); vi.stubGlobal("fetch", fetcher);
    await expect(readPublicationSubmitWorkspace(context)).rejects.toMatchObject({ status: 403 });
    expect(fetcher.mock.calls.map(call => call[1].method)).toEqual(["GET", "HEAD"]);
    expect(fetcher.mock.calls[1]![0]).toBe(`/api/erp-publication-submit/workspace?previewRequestId=${context.previewRequestId}`);
    fetcher.mockReset().mockResolvedValueOnce(json(workspace, "0".repeat(64)));
    await expect(readPublicationSubmitWorkspace(context)).rejects.toMatchObject({ status: 409, code: "authority_changed" }); expect(fetcher).toHaveBeenCalledTimes(1);
  });
  it("does not resend a committed POST after an unavailable final check and recovers only by the original key and checksum", async () => {
    const { context, input, value, receipt } = await fixture(), fetcher = vi.fn().mockResolvedValueOnce(json(value, context.authority, 201)).mockResolvedValueOnce(new Response(null, { status: 503 })); vi.stubGlobal("fetch", fetcher);
    await expect(createPublicationSubmission(context, input)).rejects.toMatchObject({ submitted: true });
    expect(fetcher.mock.calls.filter(call => call[1].method === "POST")).toHaveLength(1);
    fetcher.mockResolvedValueOnce(json(receipt, context.authority)).mockResolvedValueOnce(okHead(context.authority));
    expect((await readPublicationSubmitReceipt(context, { requestKey: input.requestKey, requestChecksum: input.requestChecksum })).request?.request.id).toBe(value.request.id);
    expect(fetcher.mock.calls.map(call => call[1].method)).toEqual(["POST", "HEAD", "GET", "HEAD"]);
    expect(fetcher.mock.calls[2]![0]).toBe(`/api/erp-publication-submit/receipt?requestKey=${input.requestKey}&requestChecksum=${input.requestChecksum}`);
    expect(publicationSubmitDenied(new PublicationSubmitError(409, "store_node_application_reauthorization_required"))).toBe(false);
  });
});
describe("publication submit finite personal BFF", () => {
  it("rejects duplicate query, authority, independent Store read and write permission violations without forwarding", async () => {
    const { context, input } = await fixture(); identity(context);
    const duplicate = await publicationSubmitProxy(incoming(`workspace?previewRequestId=${context.previewRequestId}&previewRequestId=${context.previewRequestId}`, context.authority, undefined, "HEAD"), "workspace");
    expect(duplicate.status).toBe(400); expect(await duplicate.text()).toBe("");
    expect((await publicationSubmitProxy(incoming("requests", "0".repeat(64), input), "create")).status).toBe(409);
    identity(context, [Permission.ListingRead, Permission.ListingPublish]);
    expect((await publicationSubmitProxy(incoming("requests", context.authority, input), "create")).status).toBe(403);
    identity(context, [Permission.ListingRead, Permission.StoreRead]);
    expect((await publicationSubmitProxy(incoming(`requests/${previewId(20)}/status`, context.authority, {}), "status", previewId(20))).status).toBe(403);
    expect(boundary.api).not.toHaveBeenCalled();
  });
  it("binds a single 201 submission to the exact original receipt and refuses replacement proof", async () => {
    const { context, input, value, receipt } = await fixture(); identity(context);
    boundary.api.mockResolvedValueOnce(json(value, context.authority, 201)).mockResolvedValueOnce(json(receipt, context.authority)).mockResolvedValueOnce(okHead(context.authority));
    const response = await publicationSubmitProxy(incoming("requests", context.authority, input), "create");
    expect(response.status).toBe(201); expect((await response.json()).request.id).toBe(value.request.id);
    expect(boundary.api.mock.calls.map(call => call[1].method)).toEqual(["POST", "GET", "HEAD"]);
    expect(new URL(boundary.api.mock.calls[1]![0]).searchParams.get("requestKey")).toBe(input.requestKey);
    boundary.api.mockReset().mockResolvedValueOnce(json(value, context.authority, 201)).mockResolvedValueOnce(json({ ...receipt, requestChecksum: "0".repeat(64) }, context.authority));
    expect((await publicationSubmitProxy(incoming("requests", context.authority, input), "create")).status).toBe(502);
    expect(boundary.api.mock.calls.filter(call => call[1].method === "POST")).toHaveLength(1);
  });
  it("keeps a committed request unknown when receipt proof is missing and suppresses private bodies after current-object or membership denial", async () => {
    const { context, input, value } = await fixture(); identity(context);
    boundary.api.mockResolvedValueOnce(json(value, context.authority, 201)).mockResolvedValueOnce(Response.json({ message: "not found" }, { status: 404 }));
    expect((await publicationSubmitProxy(incoming("requests", context.authority, input), "create")).status).toBe(502);
    expect(boundary.api.mock.calls.map(call => call[1].method)).toEqual(["POST", "GET"]);
    boundary.api.mockReset().mockResolvedValueOnce(json(value, context.authority)).mockResolvedValueOnce(new Response(null, { status: 403 }));
    const denied = await publicationSubmitProxy(incoming(`requests/${value.request.id}`, context.authority), "view", value.request.id);
    expect(denied.status).toBe(403); expect(await denied.text()).not.toContain(value.intent.target.sku);
    boundary.api.mockReset().mockResolvedValueOnce(json(value, context.authority)); boundary.current.mockReset().mockResolvedValueOnce(undefined).mockRejectedValueOnce(new PersonalSessionError(409, "authority_changed"));
    const changed = await publicationSubmitProxy(incoming(`requests/${value.request.id}`, context.authority), "view", value.request.id);
    expect(changed.status).toBe(409); expect(await changed.text()).not.toContain(value.request.id); expect(boundary.api).toHaveBeenCalledTimes(1);
  });
  it("keeps status queries separate from PUT and binds current status-node pins to the exact submitted source", async () => {
    const { context, value, status } = await fixture(); identity(context);
    const body = { ...status.target, requestKey: status.requestKey, requestChecksum: status.requestChecksum };
    const proof = { protocol: status.protocol, requestKey: status.requestKey, requestChecksum: status.requestChecksum, found: true, operation: status, observedAt: status.createdAt };
    boundary.api.mockResolvedValueOnce(json(value, context.authority)).mockResolvedValueOnce(okHead(context.authority)).mockResolvedValueOnce(json(status, context.authority, 201))
      .mockResolvedValueOnce(json(proof, context.authority)).mockResolvedValueOnce(okHead(context.authority));
    const response = await publicationSubmitProxy(incoming(`requests/${value.request.id}/status`, context.authority, body), "status", value.request.id);
    expect(response.status).toBe(201); expect((await response.json()).adoptedAsRequestStatus).toBe(false);
    expect(boundary.api.mock.calls.map(call => call[1].method)).toEqual(["GET", "HEAD", "POST", "GET", "HEAD"]);
    expect(new URL(boundary.api.mock.calls[2]![0]).pathname).toBe(`/v1/marketplace-publication-submissions/requests/${value.request.id}/status`);
    expect(JSON.parse(boundary.api.mock.calls[2]![1].body).sourceSubmissionId).toBeNull();
  });
  it("cancels only the exact readable original request after an explicit reason and respects the current server cancellation gate", async () => {
    const { context, value } = await fixture(); identity(context);
    const cancelled = PublicationSubmitRequestViewSchema.parse({ ...value, request: { ...value.request, current: { ...value.request.current, id: previewId(50), sequence: 2, status: "cancelled" } },
      execution: { ...value.execution, state: "cancelled" }, access: { ...value.access, canCancel: false } });
    const body = { reason: "Synthetic explicit operator cancellation" };
    boundary.api.mockResolvedValueOnce(json(value, context.authority)).mockResolvedValueOnce(okHead(context.authority))
      .mockResolvedValueOnce(json(cancelled, context.authority)).mockResolvedValueOnce(okHead(context.authority));
    const response = await publicationSubmitProxy(incoming(`requests/${value.request.id}/cancel`, context.authority, body), "cancel", value.request.id);
    expect(response.status).toBe(200); expect((await response.json()).request.id).toBe(value.request.id);
    expect(boundary.api.mock.calls.map(call => call[1].method)).toEqual(["GET", "HEAD", "POST", "HEAD"]);
    expect(JSON.parse(boundary.api.mock.calls[2]![1].body)).toEqual(body);
    boundary.api.mockReset().mockResolvedValueOnce(json(cancelled, context.authority)).mockResolvedValueOnce(okHead(context.authority));
    expect((await publicationSubmitProxy(incoming(`requests/${value.request.id}/cancel`, context.authority, body), "cancel", value.request.id)).status).toBe(409);
    expect(boundary.api.mock.calls.map(call => call[1].method)).toEqual(["GET", "HEAD"]);
  });
});
