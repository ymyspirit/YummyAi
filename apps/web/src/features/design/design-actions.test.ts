import { createEntityId } from "@yummyai/contracts";
import { beforeEach, describe, expect, it, vi } from "vitest";

const { apiFetchMock, revalidatePathMock } = vi.hoisted(() => ({ apiFetchMock: vi.fn<typeof fetch>(), revalidatePathMock: vi.fn() }));
vi.mock("../../server-api", () => ({ apiFetch: apiFetchMock }));
vi.mock("next/cache", () => ({ revalidatePath: revalidatePathMock }));

import { createDesignTask, uploadDesignVersion } from "./design-actions";

const idle = { message: "", status: "idle" as const };

beforeEach(() => { apiFetchMock.mockReset(); revalidatePathMock.mockReset(); process.env.API_BASE_URL = "http://api.test"; });

describe("design actions", () => {
  it("creates a design task for a real SKU", async () => {
    const skuId = createEntityId(); const taskId = createEntityId();
    apiFetchMock.mockResolvedValueOnce(json({ id: taskId }, 201));
    const form = new FormData(); form.set("skuId", skuId); form.set("title", "Custom pillow artwork"); form.set("brief", "Create original production-ready artwork");
    const result = await createDesignTask(idle, form);
    expect(result).toMatchObject({ status: "success", taskId });
    expect(apiFetchMock).toHaveBeenCalledWith("http://api.test/v1/design/tasks", expect.objectContaining({ method: "POST" }));
  });

  it("uploads, rights-approves, and attaches an authorized file in order", async () => {
    const taskId = createEntityId(); const assetId = createEntityId();
    apiFetchMock.mockResolvedValueOnce(json({ id: assetId }, 201)).mockResolvedValueOnce(json({ id: assetId })).mockResolvedValueOnce(json({ id: createEntityId() }, 201));
    const form = new FormData(); form.set("file", new File(["proof"], "proof.png", { type: "image/png" })); form.set("role", "effect"); form.set("rightsKind", "owned"); form.set("rightsReference", "INTERNAL-PILLOW-001"); form.set("changeNote", "First original proof");
    const result = await uploadDesignVersion(taskId, idle, form);
    expect(result.status).toBe("success");
    expect(apiFetchMock.mock.calls.map((call) => String(call[0]))).toEqual([
      "http://api.test/assets",
      `http://api.test/v1/design/assets/${assetId}/rights`,
      `http://api.test/v1/design/tasks/${taskId}/versions`,
    ]);
  });
});

function json(body: unknown, status = 200) { return new Response(JSON.stringify(body), { headers: { "content-type": "application/json" }, status }); }
