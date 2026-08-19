import { ErpSidebar } from "../../../features/navigation/erp-sidebar";
import { BatchDesignWorkbench } from "../../../features/pod/batch-design-workbench";
import type { BatchCapabilities, CreativeBatch, DesignOptions } from "../../../features/pod/pod-batch-types";
import { apiFetch } from "../../../server-api";

export const dynamic = "force-dynamic";

export default async function CreativeDesignPage({ searchParams }: { searchParams: Promise<Record<string, string | string[] | undefined>> }) {
  const params = await searchParams;
  const requestedBatchId = typeof params.batch === "string" ? params.batch : undefined;
  const loaded = await loadConsole(requestedBatchId);
  return (
    <div className="research-shell pod-batch-shell creative-design-shell">
      <ErpSidebar active="creative-designs" contextLabel="DESIGN STUDIO" note="创意可先于商品和 SKU 建立；审核通过后再交接到正式设计与套图生产。" />
      <main className="research-main pod-batch-main creative-design-main">
        <BatchDesignWorkbench {...loaded} />
      </main>
    </div>
  );
}

async function loadConsole(requestedBatchId?: string): Promise<{
  capabilities?: BatchCapabilities; options?: DesignOptions; batches: CreativeBatch[]; batch?: CreativeBatch;
  assetUrls: Record<string, string>; error?: string;
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
    const batches = await batchesResponse.json() as CreativeBatch[];
    const batchId = requestedBatchId ?? batches[0]?.id;
    if (!batchId) return { capabilities, options, batches, assetUrls: {} };
    const detailResponse = await apiFetch(`${base}/v1/pod/design-batches/${batchId}`, { cache: "no-store" });
    if (!detailResponse.ok) return { capabilities, options, batches, assetUrls: {}, error: `设计批次详情读取失败 (${detailResponse.status})。` };
    const batch = await detailResponse.json() as CreativeBatch;
    const assetIds = [...new Set(batch.items?.flatMap((item) => [
      ...item.candidates.flatMap((candidate) => candidate.assetId ? [candidate.assetId] : []),
      ...item.creativeVersions.flatMap((version) => version.assets.map((asset) => asset.assetId)),
    ]) ?? [])];
    return { capabilities, options, batches, batch, assetUrls: await signAssets(base, assetIds) };
  } catch (error) {
    return { batches: [], assetUrls: {}, error: error instanceof Error ? error.message : "画图设计控制台读取失败。" };
  }
}

async function signAssets(base: string, assetIds: string[]) {
  const entries = await Promise.all(assetIds.map(async (assetId) => {
    const response = await apiFetch(`${base}/assets/${assetId}/read-url`, {
      method: "POST", cache: "no-store", headers: { "content-type": "application/json" }, body: JSON.stringify({ requiredDomain: "authorized" }),
    });
    if (!response.ok) return undefined;
    const payload = await response.json() as { url?: unknown };
    return typeof payload.url === "string" ? [assetId, payload.url] as const : undefined;
  }));
  return Object.fromEntries(entries.filter((entry): entry is readonly [string, string] => Boolean(entry)));
}
