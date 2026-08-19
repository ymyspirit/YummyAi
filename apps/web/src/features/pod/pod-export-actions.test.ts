import { createEntityId } from "@yummyai/contracts";
import { beforeEach, describe, expect, it, vi } from "vitest";

const { apiFetchMock, revalidatePathMock } = vi.hoisted(() => ({
  apiFetchMock: vi.fn<typeof fetch>(),
  revalidatePathMock: vi.fn(),
}));
vi.mock("../../server-api", () => ({ apiFetch: apiFetchMock }));
vi.mock("next/cache", () => ({ revalidatePath: revalidatePathMock }));

import { requestPodExport, requestPodExportDownload } from "./pod-export-actions";

const idle = { message: "", status: "idle" as const };

beforeEach(() => {
  apiFetchMock.mockReset();
  revalidatePathMock.mockReset();
  process.env.API_BASE_URL = "http://api.test";
});

describe("POD export actions", () => {
  it("requests an identifier-only immutable export for an approved task", async () => {
    const taskId = createEntityId();
    const exportId = createEntityId();
    apiFetchMock.mockResolvedValueOnce(json({
      id: exportId,
      taskId,
      designVersionId: createEntityId(),
      status: "queued",
      createdAt: "2026-08-03T08:00:00.000Z",
    }, 201));
    const form = new FormData();
    form.set("taskId", taskId);

    const result = await requestPodExport(idle, form);

    expect(result).toMatchObject({ status: "success", exportId });
    expect(apiFetchMock).toHaveBeenCalledWith(
      `http://api.test/v1/pod/tasks/${taskId}/exports`,
      expect.objectContaining({ method: "POST" }),
    );
    const requestBody = JSON.parse(String(apiFetchMock.mock.calls[0]?.[1]?.body)) as Record<string, unknown>;
    expect(Object.keys(requestBody)).toEqual(["idempotencyKey"]);
    expect(revalidatePathMock).toHaveBeenCalledWith("/pod-workbench");
  });

  it("requests a short-lived URL only for a completed export identifier", async () => {
    const exportId = createEntityId();
    apiFetchMock.mockResolvedValueOnce(json({ url: "https://storage.test/export.zip", expiresInSeconds: 600 }));
    const form = new FormData();
    form.set("exportId", exportId);

    const result = await requestPodExportDownload(idle, form);

    expect(result).toMatchObject({ status: "success", exportId, downloadUrl: "https://storage.test/export.zip" });
    expect(apiFetchMock).toHaveBeenCalledWith(
      `http://api.test/v1/pod/exports/${exportId}/read-url`,
      expect.objectContaining({ method: "POST" }),
    );
  });
});

function json(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), { headers: { "content-type": "application/json" }, status });
}
