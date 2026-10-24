import { createEntityId } from "@yummyai/contracts/common/ids";
import { beforeEach, describe, expect, it, vi } from "vitest";
const { api } = vi.hoisted(() => ({ api: vi.fn<typeof fetch>() }));
vi.mock("../../server-api", () => ({ apiFetch: api }));
vi.mock("next/cache", () => ({ revalidatePath: vi.fn() }));
import { commandWorkflowNode, repairWorkflowNode } from "./workflow-actions";
import { operatorRun } from "./workflow-operator.test-fixture";

beforeEach(() => {
  api.mockReset();
  process.env.API_BASE_URL = "http://api.test";
});
describe("workflow structured repair action", () => {
  it("does not display a raw upstream server diagnostic", async () => {
    api.mockResolvedValueOnce(
      Response.json({ message: "secret-prompt-and-provider-path" }, { status: 503 }),
    );
    const result = await commandWorkflowNode(createEntityId(), "work", {
      type: "retry",
      expectedRevision: 8,
    });
    expect(result).toMatchObject({ status: "error", httpStatus: 503 });
    expect(result.message).not.toContain("secret");
  });
  it("re-reads the pinned node and sends a strict retry without trusting a posted tool", async () => {
    const run = operatorRun(),
      source = createEntityId(),
      form = new FormData();
    form.set("researchSnapshotId", source);
    form.set("targetMarketplace", "amazon.com");
    form.set("toolKey", "forged");
    api
      .mockResolvedValueOnce(Response.json(run))
      .mockResolvedValueOnce(Response.json({ ...run, revision: 9 }));
    expect(await repairWorkflowNode(run.id, "work", 8, form)).toMatchObject({
      status: "success",
      data: { revision: 9 },
    });
    expect(api.mock.calls[0]?.[0]).toBe(`http://api.test/v1/workflow-runs/${run.id}`);
    expect(JSON.parse(String(api.mock.calls[1]?.[1]?.body))).toEqual({
      type: "retry",
      expectedRevision: 8,
      parameters: { researchSnapshotId: source, targetMarketplace: "amazon.com" },
    });
  });
  it("keeps a stale form from creating a new attempt", async () => {
    const run = operatorRun();
    api.mockResolvedValueOnce(Response.json({ ...run, revision: 9 }));
    expect(await repairWorkflowNode(run.id, "work", 8, new FormData())).toMatchObject({
      status: "error",
      httpStatus: 409,
    });
    expect(api).toHaveBeenCalledTimes(1);
  });
  it("rejects missing source and invalid export mode before a command is sent", async () => {
    const run = operatorRun();
    api.mockResolvedValueOnce(Response.json(run));
    expect(await repairWorkflowNode(run.id, "work", 8, new FormData())).toMatchObject({
      status: "error",
    });
    const exportRun = operatorRun("yummyai.custom_product.export_package"),
      form = new FormData();
    form.set("mode", "bypass");
    api.mockResolvedValueOnce(Response.json(exportRun));
    expect(await repairWorkflowNode(exportRun.id, "work", 8, form)).toMatchObject({
      status: "error",
    });
    const longSite = new FormData();
    longSite.set("researchSnapshotId", createEntityId());
    longSite.set("targetMarketplace", "a".repeat(121));
    api.mockResolvedValueOnce(Response.json(run));
    expect(await repairWorkflowNode(run.id, "work", 8, longSite)).toMatchObject({
      status: "error",
    });
    expect(api.mock.calls.every((call) => !call[1]?.method)).toBe(true);
  });
  it("reuses the POD parser and keeps mandatory corrections fixed", async () => {
    const run = operatorRun("pod.pattern_crop"),
      form = new FormData();
    form.set("skuId", createEntityId());
    form.set("title", "Corrected crop");
    form.set("inputAssetIds", createEntityId());
    form.set("mode", "general");
    form.set("maximumCropsPerInput", "1");
    form.set("cropPaddingPercent", "0");
    form.set("outputFormat", "png");
    form.set("background", "preserved");
    form.set("perspectiveCorrection", "false");
    api
      .mockResolvedValueOnce(Response.json(run))
      .mockResolvedValueOnce(Response.json({ ...run, revision: 9 }));
    expect(await repairWorkflowNode(run.id, "work", 8, form)).toMatchObject({ status: "success" });
    const body = JSON.parse(String(api.mock.calls[1]?.[1]?.body));
    expect(body.parameters.parameterSnapshot).toMatchObject({
      maximumCropsPerInput: 1,
      cropPaddingPercent: 0,
      perspectiveCorrection: true,
      multiCrop: false,
    });
    expect(body.parameters).not.toHaveProperty("idempotencyKey");
  });
});
