import { ErpSidebar } from "../../../../features/navigation/erp-sidebar";
import { MockupBatchWorkbench } from "../../../../features/pod/mockup-batch-workbench";
import type { BatchCapabilities, MockupBatch, MockupOptions } from "../../../../features/pod/pod-batch-types";
import { apiFetch } from "../../../../server-api";

export const dynamic = "force-dynamic";

export default async function MockupBatchesPage({ searchParams }: { searchParams: Promise<Record<string, string | string[] | undefined>> }) {
  const params = await searchParams;
  const requestedBatchId = typeof params.batch === "string" ? params.batch : undefined;
  const loaded = await loadConsole(requestedBatchId);
  return (
    <div className="research-shell pod-batch-shell">
      <ErpSidebar active="mockup-batches" contextLabel="MOCKUP OPS" note="只消费已批准正式设计与模板包；输出审核后显式绑定 Listing，不自动发布。" />
      <main className="research-main pod-batch-main">
        <MockupBatchWorkbench {...loaded} />
      </main>
    </div>
  );
}

async function loadConsole(requestedBatchId?: string): Promise<{
  capabilities?: BatchCapabilities; options?: MockupOptions;
  allPacks: Array<{ id: string; name: string; versionNumber: number; status: string; platform: string; locale: string }>;
  batches: MockupBatch[]; batch?: MockupBatch; assetUrls: Record<string, string>; error?: string;
}> {
  const apiBase = process.env.API_BASE_URL;
  if (!apiBase) return { allPacks: [], batches: [], assetUrls: {}, error: "API_BASE_URL 未配置。" };
  const base = apiBase.replace(/\/$/, "");
  try {
    const [capabilityResponse, optionsResponse, packsResponse, batchesResponse] = await Promise.all([
      apiFetch(`${base}/v1/pod/batch-capabilities`, { cache: "no-store" }),
      apiFetch(`${base}/v1/pod/mockup-batches/options`, { cache: "no-store" }),
      apiFetch(`${base}/v1/pod/mockup-template-packs`, { cache: "no-store" }),
      apiFetch(`${base}/v1/pod/mockup-batches`, { cache: "no-store" }),
    ]);
    if ([capabilityResponse, optionsResponse, packsResponse, batchesResponse].some((response) => !response.ok)) {
      return { allPacks: [], batches: [], assetUrls: {}, error: `批量套图控制台读取失败 (${[capabilityResponse, optionsResponse, packsResponse, batchesResponse].find((response) => !response.ok)?.status})。` };
    }
    const capabilities = await capabilityResponse.json() as BatchCapabilities;
    const options = await optionsResponse.json() as MockupOptions;
    const allPacks = (await packsResponse.json() as { items: Array<{ id: string; name: string; versionNumber: number; status: string; platform: string; locale: string }> }).items;
    const batches = await batchesResponse.json() as MockupBatch[];
    const batchId = requestedBatchId ?? batches[0]?.id;
    if (!batchId) return { capabilities, options, allPacks, batches, assetUrls: {} };
    const detailResponse = await apiFetch(`${base}/v1/pod/mockup-batches/${batchId}`, { cache: "no-store" });
    if (!detailResponse.ok) return { capabilities, options, allPacks, batches, assetUrls: {}, error: `套图批次详情读取失败 (${detailResponse.status})。` };
    const batch = await detailResponse.json() as MockupBatch;
    const assetIds = [...new Set(batch.items?.flatMap((item) => item.outputs.flatMap((output) => output.assetId ? [output.assetId] : [])) ?? [])];
    return { capabilities, options, allPacks, batches, batch, assetUrls: await signAssets(base, assetIds) };
  } catch (error) {
    return { allPacks: [], batches: [], assetUrls: {}, error: error instanceof Error ? error.message : "批量套图控制台读取失败。" };
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
