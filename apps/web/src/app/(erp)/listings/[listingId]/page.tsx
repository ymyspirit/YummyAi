import { Archive, Boxes, FileText, Palette, ScanSearch } from "lucide-react";

import { ListingEditor, type ListingEditorView } from "../../../../features/listings/listing-editor";

export const dynamic = "force-dynamic";

export default async function ListingPage({ params }: { params: Promise<{ listingId: string }> }) {
  const { listingId } = await params;
  const result = await loadListing(listingId);
  return <div className="research-shell listing-shell"><aside className="side-rail"><div className="rail-brand"><span className="rail-mark"><ScanSearch size={20} /></span><div><strong>YummyAI</strong><span>LISTING OPS</span></div></div><nav className="rail-nav analysis-nav" aria-label="主导航"><a href="/research"><Archive size={16} />研究资料库</a><a href="/products"><Boxes size={16} />产品开发</a><a href="/design"><Palette size={16} />设计校样</a><a className="active" href={`/listings/${listingId}`}><FileText size={16} />刊登控制台</a></nav><p className="rail-note">字段来源、平台规则、变体映射和历史版本一起锁定，审批不会被 AI 建议覆盖。</p></aside><main className="research-main listing-main">{result.listing ? <ListingEditor listing={result.listing} /> : <section className="analysis-error" role="alert"><FileText size={28} /><h1>未找到刊登</h1><p>{result.error ?? "请先为 SPU 创建平台刊登。"}</p><a href="/products">返回产品开发</a></section>}</main></div>;
}

async function loadListing(id: string): Promise<{ listing?: ListingEditorView; error?: string }> {
  if (process.env.LISTING_DEMO_MODE === "1") return { listing: demoListing(id) };
  const apiBase = process.env.API_BASE_URL;
  if (!apiBase) return { error: "尚未配置刊登 API。请设置 API_BASE_URL 后重试。" };
  const headers: Record<string, string> = process.env.API_ACCESS_TOKEN ? { authorization: `Bearer ${process.env.API_ACCESS_TOKEN}` } : {};
  try {
    const response = await fetch(`${apiBase.replace(/\/$/, "")}/v1/listings/${id}`, { cache: "no-store", headers });
    if (!response.ok) throw new Error(`刊登读取失败 (${response.status})`);
    const payload = await response.json() as { listing: { id: string; platform: "amazon" | "etsy"; locale: string; status: ListingEditorView["status"]; spuId: string }; version: { versionNumber: number; ruleVersion: string; source: "human" | "ai"; content: ListingEditorView["content"]; validation: ListingEditorView["validation"]; createdAt: string }; history: ListingEditorView["history"] };
    return { listing: { ...payload.listing, spuCode: payload.listing.spuId.slice(0, 12), versionNumber: payload.version.versionNumber, ruleVersion: payload.version.ruleVersion, source: payload.version.source, updatedAt: payload.version.createdAt, content: payload.version.content, validation: payload.version.validation, history: payload.history } };
  } catch (error) {
    return { error: error instanceof Error ? error.message : "刊登读取失败" };
  }
}

function demoListing(id: string): ListingEditorView {
  const content = { platform: "amazon" as const, locale: "en-US", title: "Personalized Travel Mug with Gift Box — 16 oz Insulated Cup", description: "A gift-ready insulated travel mug with optional laser engraving and two presentation box choices.", bullets: ["Add a name or short message with precision laser engraving", "Double-wall insulated body for everyday hot and cold drinks", "Choose standard or premium gift-ready packaging", "Production artwork is rights-approved and supplier-ready"], tags: [], mainImageId: "asset-main-0198", mediaAssetIds: ["asset-main-0198", "asset-lifestyle-0199", "asset-giftbox-0200"], variants: [{ skuId: "sku-navy", skuCode: "TMG-NVY-16", optionValues: { Color: "Navy", Size: "16 oz" } }, { skuId: "sku-sand", skuCode: "TMG-SND-16", optionValues: { Color: "Sand", Size: "16 oz" } }], attributes: { material: "Stainless Steel", capacity: "16 oz", brand: "" }, compliance: { countryOfOrigin: "CN", foodContactSafe: true } };
  return { id, platform: "amazon", locale: "en-US", status: "draft", spuCode: "TRAVEL-MUG-GIFT", versionNumber: 4, ruleVersion: "amazon-2026.07", source: "human", updatedAt: "2026-07-18T03:12:00.000Z", content, validation: { completeness: 83, blockers: [{ severity: "blocker", code: "common.required", path: "attributes.brand", message: "Brand is required before review", ruleVersion: "amazon-2026.07" }], warnings: [{ severity: "warning", code: "amazon.aplus.missing", path: "aPlusModules", message: "No A+ content plan is attached", ruleVersion: "amazon-2026.07" }] }, history: [{ id: "v4", versionNumber: 4, status: "draft", source: "human", createdAt: "2026-07-18T03:12:00.000Z" }, { id: "v3", versionNumber: 3, status: "draft", source: "ai", createdAt: "2026-07-18T02:40:00.000Z" }, { id: "v2", versionNumber: 2, status: "approved", source: "human", createdAt: "2026-07-17T08:20:00.000Z" }, { id: "v1", versionNumber: 1, status: "superseded", source: "human", createdAt: "2026-07-16T05:10:00.000Z" }] };
}
