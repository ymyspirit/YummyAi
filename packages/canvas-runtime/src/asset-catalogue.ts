import type { Asset } from "@/stores/use-asset-store";
type CatalogueRow = { key: string; namespace: string; assetId: string; fileName: string; mediaType: string };
let projectionDepth = 0;
export function catalogueProjectionActive() { return projectionDepth > 0; }
export function applyCatalogueProjection(apply: () => void) { projectionDepth++; try { apply(); } finally { projectionDepth--; } }
export function catalogueAssetId(asset: Asset) {
  const id = asset.metadata?.erpOriginalAssetId ?? asset.id;
  return typeof id === "string" && /^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(id) ? id : undefined;
}
export function cataloguePreviewIdentity(asset: Asset) { return `${catalogueAssetId(asset) ?? asset.id}:${asset.kind === "text" ? "text" : asset.data.mimeType}`; }
const localAddress = (asset: Asset) => asset.kind === "text" || !asset.data.storageKey ? undefined : `${asset.kind === "image" ? "image_files" : "media_files"}/${asset.data.storageKey}`;

/** The server's bounded catalogue is a projection, not a deletion or access
 * decision. Match namespace/key, repair original IDs, and retain local labels. */
export function mergeStudioCatalogue(current: Asset[], rows: CatalogueRow[], now: string): Asset[] {
  const server = new Map(rows.filter(row => row.namespace === "image_files" && row.mediaType.startsWith("image/") || row.namespace === "media_files" && row.mediaType.startsWith("video/")).map(row => [`${row.namespace}/${row.key}`, row]));
  const matched = new Set<string>(), usedIds = new Set(current.map(asset => asset.id));
  let changed = false;
  const merged = current.map(asset => {
    const at = localAddress(asset), row = at ? server.get(at) : undefined;
    if (!row || asset.kind === "text") return asset;
    matched.add(at!);
    if (catalogueAssetId(asset) === row.assetId && asset.data.mimeType === row.mediaType && asset.metadata?.erpOriginalStatus === "unknown" && !asset.data.width && !asset.data.height && !asset.data.bytes) return asset;
    changed = true;
    const original = asset.kind === "image" ? asset.data.dataUrl : asset.data.url;
    const coverUrl = asset.coverUrl === original || asset.coverUrl.startsWith("blob:") ? "" : asset.coverUrl;
    // Preserve a distinct local UI ID if this original already has another
    // catalogue alias. All factual reads use the explicit current original ID.
    const id = row.assetId === asset.id || !usedIds.has(row.assetId) ? row.assetId : asset.id;
    usedIds.add(id);
    const base = { ...asset, id, coverUrl, metadata: { ...asset.metadata, erpOriginalAssetId: row.assetId, erpOriginalStatus: "unknown" } };
    return asset.kind === "image" ? { ...base, kind: "image" as const, data: { ...asset.data, dataUrl: "", mimeType: row.mediaType, width: 0, height: 0, bytes: 0 } }
      : { ...base, kind: "video" as const, data: { ...asset.data, url: "", mimeType: row.mediaType, width: 0, height: 0, bytes: 0 } };
  });
  const additions: Asset[] = [];
  for (const [at, row] of server) {
    if (matched.has(at) || usedIds.has(row.assetId)) continue;
    changed = true; usedIds.add(row.assetId);
    const base = { id: row.assetId, title: row.fileName, tags: [], source: "ERP 素材", coverUrl: "", createdAt: now, updatedAt: now, metadata: { erpOriginalAssetId: row.assetId, erpOriginalStatus: "unknown" } };
    const data = { storageKey: row.key, width: 0, height: 0, bytes: 0, mimeType: row.mediaType };
    additions.push(row.mediaType.startsWith("image/") ? { ...base, kind: "image", data: { ...data, dataUrl: "" } } : { ...base, kind: "video", data: { ...data, url: "" } });
  }
  return changed ? [...additions, ...merged] : current;
}
