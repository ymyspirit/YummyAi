import { createHash, createPublicKey } from "node:crypto";
import { request as httpRequest } from "node:http";
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { eq } from "drizzle-orm";
import { z } from "zod";
import { createEntityId } from "@yummyai/contracts";
import { PublicationPreviewRequestViewSchema } from "@yummyai/contracts/marketplace/publication-preview";
import {
  CreatePublicationSubmitInputSchema, CreatePublicationStatusInputSchema, PublicationSubmitWorkspaceSchema,
  PublicationSubmitRequestViewSchema, PublicationSubmitReceiptSchema, PublicationStatusReadViewSchema,
  PublicationStatusReceiptSchema, publicationSubmitRequestText, publicationStatusRequestText,
  type CreatePublicationSubmitInput, type CreatePublicationStatusInput,
} from "@yummyai/contracts/marketplace/publication-submit";
import { StoreNodeExecutionLeaseSchema } from "@yummyai/contracts/marketplace/store-node-execution";
import { marketplaceStoreNodeExecutions, marketplacePublicationNodeOperations, marketplacePublicationNodeResults,
  withTenant, type DatabaseConnection } from "@yummyai/database";
import { openStoreNodeJournal } from "../../../store-api-node/src/identity.js";
import { requirePublicationNodeSubmitEnvironment } from "../../../../tools/testing/publication-node-submit-environment.mjs";
import { executionBounded } from "./publication-node-preview-provider.test-fixture.js";
import { publicationNodePreviewFixture, nodeExecutionSha, safeCode,
  type ExecutionActor, type ExecutionNodeKeys } from "./publication-node-preview.test-fixture.js";

export const submissionApi = "/v1/marketplace-publication-submissions";
export const submissionTerminal = new Set(["succeeded", "failed", "unknown_outcome", "authority_changed", "cancelled", "expired"]);
const Id = /^[0-9a-f-]{36}$/;
export const submitFixtureDigest = (value: unknown) => createHash("sha256").update(JSON.stringify(value)).digest("hex");

/** A thin composition of the original owner/CLI fixture. No grants, pins or provider results are fabricated here. */
export function publicationNodeSubmitFixture(database: DatabaseConnection,
  options: NonNullable<Parameters<typeof publicationNodePreviewFixture>[1]> = {}) {
  const isolated = requirePublicationNodeSubmitEnvironment(process.env, "current");
  const original = publicationNodePreviewFixture(database, { amazonPublic: true, ...options });
  const io: Array<{ method: "GET" | "POST"; path: string; status: number; lost201: boolean }> = [];
  function checkedPath(path: string) {
    const url = new URL(path, "http://fixture.invalid"), keys = [...url.searchParams.keys()];
    const fixed = url.pathname === submissionApi + "/workspace" ? keys.length === 1 && keys[0] === "previewRequestId" && Id.test(url.searchParams.get("previewRequestId") ?? "")
      : [submissionApi + "/receipt", submissionApi + "/status-receipt"].includes(url.pathname)
        ? keys.length === 2 && keys.includes("requestKey") && keys.includes("requestChecksum")
        : !url.search && (url.pathname === submissionApi + "/requests" || new RegExp("^" + submissionApi + "/requests/[0-9a-f-]{36}(?:/status|/cancel)?$").test(url.pathname));
    if (url.origin !== "http://fixture.invalid" || url.hash || keys.length !== new Set(keys).size || !fixed)
      throw new Error("publication_submit_fixture_http_path_invalid");
    return url.pathname;
  }
  async function http(path: string, input?: unknown, who = original.a) {
    const pathname = checkedPath(path), method = input === undefined ? "GET" : "POST";
    const response = await fetch(original.origin + path, { method, redirect: "error", signal: AbortSignal.timeout(20_000),
      headers: { authorization: "Bearer " + await original.token(who), ...(input === undefined ? {} : { "content-type": "application/json" }) },
      ...(input === undefined ? {} : { body: JSON.stringify(input) }) });
    const body: unknown = await response.json(); io.push({ method, path: pathname, status: response.status, lost201: false });
    return { status: response.status, body };
  }
  /** The real original POST is adopted before this test-only client discards its actual 201 response. */
  async function lose201(path: string, input: unknown, who = original.a) {
    const pathname = checkedPath(path), bearer = await original.token(who), bytes = Buffer.from(JSON.stringify(input));
    return executionBounded(new Promise<{ status: 201; explicitResponseLoss: true }>((done, fail) => {
      const request = httpRequest(new URL(original.origin + path), { method: "POST", headers: { authorization: "Bearer " + bearer,
        "content-type": "application/json", "content-length": bytes.length } }, response => {
        const status = response.statusCode ?? 0; io.push({ method: "POST", path: pathname, status, lost201: true });
        response.on("error", () => { /* Explicit response loss is the injected client boundary. */ }); response.destroy();
        if (status !== 201) fail(new Error("publication_submit_loss_expected_201:" + status)); else done({ status: 201, explicitResponseLoss: true });
      });
      request.once("error", () => fail(new Error("publication_submit_loss_before_response"))); request.end(bytes);
    }), "publication_submit_loss_deadline");
  }
  async function scene(who = original.a, mode: "amazon_public" | "amazon_private" = "amazon_public") {
    const store = await original.createStore(who, "amazon", mode), node = await original.bindNode(store.id, await original.initNode(), who),
      capability = await original.submit(store.id, { amazonProductTypes: ["HOME"] }, who), capChild = await original.workNode(node.keys);
    try {
      const adopted = await original.waitExecution(store.id, capability.view.id, capChild, who);
      if (adopted.state !== "succeeded" || !adopted.snapshot?.capabilities.includes("listing_write")) throw new Error("publication_submit_original_capability_required");
    } finally { await capChild.close(); }
    const source = await original.seedListing(store.id, who), previewInput = await original.previewInput(source, who),
      response = await original.http("/v1/marketplace-publications/preview", previewInput, who);
    if (response.status !== 201) throw new Error("publication_submit_original_preview_create_failed:" + safeCode(response.body));
    const created = PublicationPreviewRequestViewSchema.parse(response.body), previewChild = await original.workNode(node.keys);
    let preview: z.infer<typeof PublicationPreviewRequestViewSchema>;
    try {
      preview = await original.waitPreview(created.request.id, previewChild, who);
      if (preview.request.current.status !== "validation_passed" || preview.execution?.state !== "succeeded")
        throw new Error("publication_submit_requires_original_passed_preview:" + JSON.stringify({ status: preview.request.current.status, state: preview.execution?.state, code: preview.execution?.errorCode }));
    } finally { await previewChild.close(); }
    original.provider.expectSubmission({ sellerId: source.sellerId, sku: source.sku, marketplaceId: "ATVPDKIKX0DER", locale: "en-US", productType: "HOME", attributes: source.attributes });
    return { who, store, node, source, preview, previewInput };
  }
  async function workspace(previewRequestId: string, who = original.a) {
    const response = await http(submissionApi + "/workspace?" + new URLSearchParams({ previewRequestId }), undefined, who);
    if (response.status !== 200) throw new Error("publication_submit_workspace_failed:" + JSON.stringify({ status: response.status, code: safeCode(response.body) }));
    return PublicationSubmitWorkspaceSchema.parse(response.body);
  }
  async function input(previewRequestId: string, who = original.a): Promise<CreatePublicationSubmitInput> {
    const value = await workspace(previewRequestId, who);
    if (!value.access.canSubmit || !value.target) throw new Error("publication_submit_original_target_unavailable:" + value.reason);
    return CreatePublicationSubmitInputSchema.parse({ ...value.target, requestKey: createEntityId(),
      requestChecksum: nodeExecutionSha(publicationSubmitRequestText(value.target)), acknowledgeReplacement: true });
  }
  async function create(raw: CreatePublicationSubmitInput, who = original.a) {
    const response = await http(submissionApi + "/requests", raw, who);
    if (response.status !== 201) throw new Error("publication_submit_create_failed:" + JSON.stringify({ status: response.status, code: safeCode(response.body) }));
    return PublicationSubmitRequestViewSchema.parse(response.body);
  }
  async function get(id: string, who = original.a) {
    const response = await http(submissionApi + "/requests/" + id, undefined, who);
    if (response.status !== 200) throw new Error("publication_submit_get_failed:" + JSON.stringify({ status: response.status, code: safeCode(response.body) }));
    return PublicationSubmitRequestViewSchema.parse(response.body);
  }
  async function receipt(raw: Pick<CreatePublicationSubmitInput, "requestKey" | "requestChecksum">, who = original.a) {
    const response = await http(submissionApi + "/receipt?" + new URLSearchParams({ requestKey: raw.requestKey, requestChecksum: raw.requestChecksum }), undefined, who);
    if (response.status !== 200) throw new Error("publication_submit_receipt_failed:" + JSON.stringify({ status: response.status, code: safeCode(response.body) }));
    return PublicationSubmitReceiptSchema.parse(response.body);
  }
  async function statusInput(id: string, who = original.a): Promise<CreatePublicationStatusInput> {
    const view = await get(id, who);
    if (!view.access.canReadStatus || !view.statusTarget) throw new Error("publication_submit_original_status_unavailable:" + view.statusReason);
    return CreatePublicationStatusInputSchema.parse({ ...view.statusTarget, requestKey: createEntityId(),
      requestChecksum: nodeExecutionSha(publicationStatusRequestText(view.statusTarget)) });
  }
  async function createStatus(id: string, raw: CreatePublicationStatusInput, who = original.a) {
    const response = await http(submissionApi + "/requests/" + id + "/status", raw, who);
    if (response.status !== 201) throw new Error("publication_status_create_failed:" + JSON.stringify({ status: response.status, code: safeCode(response.body) }));
    return PublicationStatusReadViewSchema.parse(response.body);
  }
  async function statusReceipt(raw: Pick<CreatePublicationStatusInput, "requestKey" | "requestChecksum">, who = original.a) {
    const response = await http(submissionApi + "/status-receipt?" + new URLSearchParams({ requestKey: raw.requestKey, requestChecksum: raw.requestChecksum }), undefined, who);
    if (response.status !== 200) throw new Error("publication_status_receipt_failed:" + JSON.stringify({ status: response.status, code: safeCode(response.body) }));
    return PublicationStatusReceiptSchema.parse(response.body);
  }
  async function waitOperation(id: string, child: Awaited<ReturnType<typeof original.workNode>>, who = original.a) {
    const deadline = Date.now() + 60_000;
    let latest: typeof marketplaceStoreNodeExecutions.$inferSelect | undefined;
    while (Date.now() < deadline) {
      [latest] = await withTenant(database.db, who.ceiling, tx => tx.select().from(marketplaceStoreNodeExecutions).where(eq(marketplaceStoreNodeExecutions.id, id)));
      if (latest && submissionTerminal.has(latest.state)) return { id: latest.id, state: latest.state, phase: latest.phase, errorCode: latest.errorCode, completionChecksum: latest.completionChecksum };
      if (child.evidence.exited) break;
      await executionBounded(Promise.race([child.done, new Promise<void>(done => setTimeout(done, 100))]), "publication_submit_wait_tick", 2000);
    }
    throw new Error("publication_submit_operation_not_finished:" + JSON.stringify({ id, state: latest?.state ?? null, phase: latest?.phase ?? null, code: latest?.errorCode ?? null,
      childCode: child.evidence.stderrCode, exitCode: child.evidence.exitCode, states: child.evidence.states.slice(-6) }));
  }
  async function journal(keys: ExecutionNodeKeys) {
    const bytes = await readFile(resolve(keys.directory, "execution.pe"));
    try {
      return z.object({ completed: z.boolean(), lease: StoreNodeExecutionLeaseSchema,
        rows: z.array(z.object({ ordinal: z.int(), requestClass: z.string(), state: z.string(), stepAcknowledged: z.boolean() }).passthrough()),
        completion: z.object({ payloadChecksum: z.string() }).passthrough().nullable() }).passthrough()
        .parse(await openStoreNodeJournal(bytes, keys.passphrase, nodeExecutionSha(createPublicKey(keys.publicKeyPem).export({ type: "spki", format: "der" }))));
    } finally { bytes.fill(0); }
  }
  function noSecrets(value: unknown) {
    const text = JSON.stringify(value);
    if (original.provider.secretValues.some(secret => text.includes(secret))) throw new Error("publication_submit_secret_in_public_result");
  }
  return { original, isolated, io, initialize: original.initialize, close: original.close, http, lose201, scene, workspace, input, create, get,
    receipt, statusInput, createStatus, statusReceipt, waitOperation, journal, noSecrets,
    async readOnlyRows(who: ExecutionActor = original.a) {
      const rows = await original.previewRows(who), extra = await withTenant(database.db, who.ceiling, async tx => ({
        operations: await tx.select().from(marketplacePublicationNodeOperations), results: await tx.select().from(marketplacePublicationNodeResults) }));
      return { ...rows, ...extra };
    } };
}
