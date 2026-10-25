import { BatchDesignWorkbench } from "../../../features/pod/batch-design-workbench";
import type { BatchCapabilities, CreativeBatch, DesignOptions } from "../../../features/pod/pod-batch-types";
import { apiFetch } from "../../../server-api";
import { readStudioJson } from "../../../creative-studio-personal-server";
import { redirect } from "next/navigation";

export const dynamic = "force-dynamic";

export default async function CreativeDesignPage({ searchParams }: { searchParams: Promise<Record<string, string | string[] | undefined>> }) {
  const params = await searchParams;
  const requestedBatchId = typeof params.batch === "string" ? params.batch : undefined;
  const loaded = await loadConsole(requestedBatchId);
  if (loaded.batch?.executionMode === "infinite_canvas") redirect(`/creative-designs/canvas?brief=${loaded.batch.id}`);
  return (
    <div className="research-shell pod-batch-shell creative-design-shell">
      <main className="research-main pod-batch-main creative-design-main">
        <BatchDesignWorkbench {...loaded} />
      </main>
    </div>
  );
}

async function loadConsole(requestedBatchId?: string): Promise<{
  capabilities?: BatchCapabilities; options?: DesignOptions; batches: CreativeBatch[]; batch?: CreativeBatch;
  assetUrls: Record<string, string>; assetErrors?: Record<string, string>; assetReadVersion?: string; error?: string;
}> {
  const apiBase = process.env.API_BASE_URL;
  if (!apiBase) return { batches: [], assetUrls: {}, error: "API_BASE_URL 未配置。" };
  const base = apiBase.replace(/\/$/, "");
  try {
    const [capabilityResponse, optionsResponse, batchesResponse] = await Promise.all([
      apiFetch(`${base}/v1/pod/batch-capabilities`, { cache: "no-store" }),
      apiFetch(`${base}/v1/pod/design-batches/options`, { cache: "no-store" }),
      apiFetch(`${base}/v1/pod/design-batches`, { cache: "no-store" }),
    ]);
    if (!capabilityResponse.ok || !optionsResponse.ok || !batchesResponse.ok) {
      return { batches: [], assetUrls: {}, error: `画图设计控制台读取失败 (${[capabilityResponse, optionsResponse, batchesResponse].find((response) => !response.ok)?.status})。` };
    }
    const capabilities = await capabilityResponse.json() as BatchCapabilities;
    const options = await optionsResponse.json() as DesignOptions;
    const batches = (await batchesResponse.json() as CreativeBatch[]).filter((batch) => batch.executionMode !== "infinite_canvas");
    const batchId = requestedBatchId ?? batches[0]?.id;
    if (!batchId) return { capabilities, options, batches, assetUrls: {} };
    const detailResponse = await apiFetch(`${base}/v1/pod/design-batches/${batchId}`, { cache: "no-store" });
    if (!detailResponse.ok) return { capabilities, options, batches, assetUrls: {}, error: `设计批次详情读取失败 (${detailResponse.status})。` };
    const batch = await detailResponse.json() as CreativeBatch;
    const assetIds = [...new Set(batch.items?.flatMap((item) => [
      ...item.candidates.flatMap((candidate) => candidate.assetId ? [candidate.assetId] : []),
      ...item.creativeVersions.flatMap((version) => version.assets.map((asset) => asset.assetId)),
    ]) ?? [])];
    return { capabilities, options, batches, batch, ...await signAssets(base, assetIds) };
  } catch (error) {
    return { batches: [], assetUrls: {}, error: error instanceof Error ? error.message : "画图设计控制台读取失败。" };
  }
}

async function signAssets(base: string, assetIds: string[]) {
  const entries = await Promise.all(assetIds.map(async (assetId): Promise<{ assetId: string; url?: string; error?: string }> => {
    try {
      const response = await apiFetch(`${base}/v1/assets/${encodeURIComponent(assetId)}/read-url`, {
        method: "POST", cache: "no-store", headers: { "content-type": "application/json" }, body: JSON.stringify({ requiredDomain: "authorized" }),
      });
      if (!response.ok) {
        await response.body?.cancel().catch(() => undefined);
        return { assetId, error: assetReadFailure(response.status) };
      }
      const payload = await readStudioJson(response, 20 * 1024);
      const url = payload && typeof payload === "object" && "url" in payload ? payload.url : undefined;
      if (typeof url !== "string" || !url || url.length > 16384) return { assetId, error: "原图预览地址尚未核对 请重新读取" };
      const parsed = new URL(url);
      if (!["http:", "https:"].includes(parsed.protocol) || parsed.username || parsed.password)
        return { assetId, error: "原图预览地址尚未核对 请重新读取" };
      return { assetId, url };
    } catch {
      return { assetId, error: assetReadFailure() };
    }
  }));
  return {
    assetUrls: Object.fromEntries(entries.flatMap(entry => entry.url ? [[entry.assetId, entry.url] as const] : [])),
    assetErrors: Object.fromEntries(entries.flatMap(entry => entry.error ? [[entry.assetId, entry.error] as const] : [])),
    assetReadVersion: crypto.randomUUID(),
  };
}

function assetReadFailure(status?: number) {
  if (status === 401) return "登录已失效 请重新登录后读取原图";
  if (status === 403) return "当前账户无权读取这份原图 请核对素材权限后重新读取";
  if (status === 404) return "原图不存在或当前不可读取 请核对原资产后重新读取";
  if (status === 409) return "原图或读取权限已变化 请重新读取";
  if (status === 410) return "原图读取已失效 请核对原资产后重新读取";
  return "原图预览暂时无法核对 请重新读取";
}
