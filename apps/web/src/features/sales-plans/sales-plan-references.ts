import {
  SalesPlanReferenceSelectionSchema,
  type SalesPlanFields,
  type SalesPlanOptions,
} from "@yummyai/contracts/catalog/sales-plan";

export function salesPlanReferenceSelection(fields: SalesPlanFields) {
  const sorted = (ids: string[]) => [...new Set(ids)].sort();
  return SalesPlanReferenceSelectionSchema.parse({
    specificationIds: sorted(fields.specificationIds),
    skuIds: sorted(fields.skuIds),
    artworkVersionIds: sorted(fields.artworkVersionIds),
    researchItemIds: sorted(fields.researchItemIds),
    assetIds: sorted([
      ...fields.mediaAssetIds,
      ...fields.customMaterials.map((m) => m.assetId),
      ...(fields.mainImageId ? [fields.mainImageId] : []),
    ]),
    creativeProjectId: fields.creativeProjectId,
    accountId: fields.accountId,
  });
}
export type SalesPlanReferenceIssue = {
  kind: "specification" | "sku" | "artwork" | "research" | "asset" | "project" | "account";
  id: string;
  label: string;
  usages?: string[];
};
export function salesPlanReferenceIssues(
  fields: SalesPlanFields,
  options: SalesPlanOptions,
  spuId: string,
) {
  const issues: SalesPlanReferenceIssue[] = [];
  const missing = (
    kind: SalesPlanReferenceIssue["kind"],
    label: string,
    ids: string[],
    available: string[],
  ) => {
    const current = new Set(available);
    for (const id of ids) if (!current.has(id)) issues.push({ kind, id, label });
  };
  missing(
    "specification",
    "销售规格",
    fields.specificationIds,
    options.specifications.filter((s) => s.spuId === spuId).map((s) => s.id),
  );
  missing(
    "sku",
    "销售 SKU",
    fields.skuIds,
    options.skus.filter((s) => s.spuId === spuId).map((s) => s.id),
  );
  missing(
    "artwork",
    "印花版本",
    fields.artworkVersionIds,
    options.artworks
      .filter((a) => fields.mode !== "standard" || a.mode === "fixed")
      .map((a) => a.versionId),
  );
  missing(
    "research",
    "研究商品",
    fields.researchItemIds,
    options.researchItems.map((r) => r.id),
  );
  missing(
    "project",
    "图文项目",
    fields.creativeProjectId ? [fields.creativeProjectId] : [],
    options.projects.map((p) => p.id),
  );
  missing(
    "account",
    "目标店铺",
    fields.accountId ? [fields.accountId] : [],
    options.accounts.map((a) => a.id),
  );
  const assets = new Set(options.assets.map((a) => a.id));
  for (const id of salesPlanReferenceSelection(fields).assetIds)
    if (!assets.has(id)) {
      const usages = [
        ...(fields.mediaAssetIds.includes(id) ? ["刊登图片"] : []),
        ...(fields.mainImageId === id ? ["主图"] : []),
        ...fields.customMaterials.filter((m) => m.assetId === id).map((m) => `选项图片 ${m.label}`),
      ];
      issues.push({ kind: "asset", id, label: "授权素材", usages });
    }
  return issues;
}
/** Selecting a visible choice must not silently discard a reference omitted by the current list. */
export function retainUnlistedReferences(previous: string[], selected: string[], listed: string[]) {
  const visible = new Set(listed);
  return [...new Set([...previous.filter((id) => !visible.has(id)), ...selected])];
}
export function removeSalesPlanReference(
  fields: SalesPlanFields,
  issue: SalesPlanReferenceIssue,
): SalesPlanFields {
  const omit = (ids: string[]) => ids.filter((id) => id !== issue.id);
  switch (issue.kind) {
    case "specification":
      return { ...fields, specificationIds: omit(fields.specificationIds) };
    case "sku":
      return { ...fields, skuIds: omit(fields.skuIds), patternChoices: undefined };
    case "artwork":
      return { ...fields, artworkVersionIds: omit(fields.artworkVersionIds) };
    case "research":
      return { ...fields, researchItemIds: omit(fields.researchItemIds) };
    case "project":
      return { ...fields, creativeProjectId: null };
    case "account":
      return { ...fields, accountId: null };
    case "asset":
      return {
        ...fields,
        mediaAssetIds: omit(fields.mediaAssetIds),
        mainImageId: fields.mainImageId === issue.id ? null : fields.mainImageId,
        customMaterials: fields.customMaterials.filter((m) => m.assetId !== issue.id),
      };
  }
}
