import type { ContentProject, ContentStage } from "@yummyai/contracts/catalog/content-project";

type Input = Pick<
  ContentProject,
  | "access"
  | "researchSources"
  | "legacy"
  | "results"
  | "skus"
  | "mockups"
  | "listings"
  | "packages"
  | "diagnostics"
> & { finalDesignStep: boolean };
export function contentProjectStages(project: Input): ContentStage[] {
  const { access, researchSources, results, skus, mockups, listings, packages } = project;
  const usableSkus = skus.filter(
    (s) => s.belongsToProject && !s.needsUpdate && s.factsConfirmed && s.status === "approved",
  );
  const designComplete =
    project.finalDesignStep &&
    results.length > 0 &&
    results.some((r) => r.status === "approved") &&
    results.every((r) => ["approved", "rejected"].includes(r.status));
  const skuComplete = skus.length > 0 && usableSkus.length === skus.length;
  const mockupComplete =
    skuComplete &&
    usableSkus.every((s) =>
      mockups.some(
        (m) =>
          m.skuId === s.id &&
          m.current &&
          m.requiredCount > 0 &&
          m.approvedCount === m.requiredCount,
      ),
    );
  const listingComplete =
    listings.length > 0 && listings.every((l) => l.status === "approved" && !l.blockers.length);
  const deliveryComplete =
    skuComplete &&
    listingComplete &&
    usableSkus.every((s) => {
      const targets = listings.filter((l) => l.skuIds.includes(s.id));
      return (
        targets.length > 0 &&
        targets.every((l) =>
          packages.some(
            (p) =>
              p.current &&
              p.skuId === s.id &&
              p.listingId === l.id &&
              p.listingVersionId === l.versionId,
          ),
        )
      );
    });
  const stages: ContentStage[] = [
    {
      key: "research",
      label: "研究与需求",
      status: !access.research ? "unauthorized" : researchSources.length ? "complete" : "optional",
      detail: !access.research
        ? "没有研究资料读取权限"
        : researchSources.length
          ? `已固定 ${researchSources.length} 份研究来源`
          : project.legacy
            ? "历史项目没有研究版本快照"
            : "可直接原创，也可从研究库建立新需求",
    },
    {
      key: "design",
      label: "原创设计",
      status: designComplete ? "complete" : results.length ? "in_progress" : "not_started",
      detail: designComplete
        ? "最后一步已完成选款与审核"
        : results.length
          ? "继续修订或审核当前候选"
          : "打开画布创作并回传方案",
    },
    {
      key: "sku",
      label: "商品与 SKU",
      status: !access.catalog
        ? "unauthorized"
        : skuComplete
          ? "complete"
          : skus.some((s) => s.needsUpdate || !s.belongsToProject || !s.factsConfirmed)
            ? "blocked"
            : skus.length
              ? "in_progress"
              : "not_started",
      detail: !access.catalog
        ? "没有商品资料读取权限"
        : skuComplete
          ? `${usableSkus.length} 个销售 SKU 的制作版本与事实已确认`
          : skus.some((s) => s.needsUpdate || !s.belongsToProject)
            ? "来源已有新版本，需在产品开发中核对"
            : skus.some((s) => !s.factsConfirmed)
              ? "商品事实尚未确认"
              : skus.length
                ? "完成规格适配并审核制作版本"
                : "登记批准印花，再组合真实商品规格",
    },
    {
      key: "mockup",
      label: "商品套图",
      status: !access.catalog
        ? "unauthorized"
        : mockupComplete
          ? "complete"
          : mockups.some((m) => m.current && m.failedCount && m.approvedCount < m.requiredCount)
            ? "blocked"
            : mockups.length
              ? "in_progress"
              : "not_started",
      detail: !access.catalog
        ? "需要商品资料读取权限"
        : mockupComplete
          ? "当前制作版本的必需图片槽位已审核"
          : mockups.length
            ? "核对制作版本、失败槽位与图片审核"
            : "用批准的正式设计选择商品场景模板",
    },
    {
      key: "listing",
      label: "Listing",
      status:
        !access.catalog || !access.listing
          ? "unauthorized"
          : listingComplete
            ? "complete"
            : listings.some((l) => l.blockers.length)
              ? "blocked"
              : listings.length
                ? "in_progress"
                : "not_started",
      detail:
        !access.catalog || !access.listing
          ? "需要商品与刊登读取权限"
          : listingComplete
            ? "当前 Listing 版本已审核"
            : listings.some((l) => l.blockers.length)
              ? "先处理字段、商品事实或版本缺项"
              : listings.length
                ? "使用 SKU 资料包助手起草并送审"
                : "从批准的销售 SKU 创建刊登草稿",
    },
    {
      key: "delivery",
      label: "审核与导出",
      status:
        !access.catalog || !access.listing
          ? "unauthorized"
          : deliveryComplete
            ? "complete"
            : packages.length
              ? "blocked"
              : "not_started",
      detail:
        !access.catalog || !access.listing
          ? "需要商品与刊登读取权限"
          : deliveryComplete
            ? "各销售 SKU 的当前刊登版本均已有封存资料包"
            : packages.length
              ? "历史包已保留；当前版本仍需核对和封存"
              : "在产品开发中核对图片证据并封存资料包",
    },
  ];
  if (project.diagnostics.some((d) => d.startsWith("关联记录超过"))) {
    for (const stage of stages.slice(2))
      if (stage.status === "complete") {
        stage.status = "blocked";
        stage.detail = "关联记录超过展示上限，请到原工作台核对完整数据";
      }
  }
  return stages;
}
