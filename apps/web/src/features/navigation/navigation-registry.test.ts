import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

import { PodModuleKeySchema } from "@yummyai/contracts/pod";
import { StudioToolSchema } from "@yummyai/contracts/pod/creative-studio";
import { describe, expect, it } from "vitest";

import { DIRECTORY_DESTINATION, FUNCTION_DESTINATIONS, PRIMARY_DESTINATIONS, resolveNavigationLocation, searchDestinations } from "./navigation-registry";

describe("navigation destinations", () => {
  it("covers every static ERP page and only links to existing pages", () => {
    const root = fileURLToPath(new URL("../../app/(erp)", import.meta.url));
    const destinations = [...FUNCTION_DESTINATIONS, DIRECTORY_DESTINATION];
    const paths = new Set(destinations.map((item) => new URL(item.href, "https://erp.local").pathname));
    for (const path of paths) {
      const studio = /^\/creative-designs\/studio\/([^/]+)$/.exec(path);
      if (studio) { expect(StudioToolSchema.safeParse(studio[1]).success).toBe(true); expect(existsSync(join(root, "creative-designs/studio/[tool]/page.tsx"))).toBe(true); }
      else expect(existsSync(join(root, path, "page.tsx")), path).toBe(true);
    }
    const redirects = ["/amazon-custom-sop", "/pod-workbench/batch-designs", "/orders/import"];
    for (const file of readdirSync(root, { recursive: true, encoding: "utf8" })) {
      const normalized = file.replaceAll("\\", "/");
      if (!normalized.endsWith("page.tsx") || normalized.includes("[")) continue;
      const path = `/${normalized.replace(/\/?page\.tsx$/, "")}`;
      if (redirects.includes(path)) {
        expect(readFileSync(join(root, file), "utf8")).toContain("redirect(");
      } else expect(paths.has(path), `Missing page: ${path}`).toBe(true);
    }
    expect(new Set(destinations.map((item) => item.id)).size).toBe(destinations.length);
    expect(new Set(destinations.map((item) => item.href)).size).toBe(destinations.length);
    const modules = destinations.flatMap((item) => new URL(item.href, "https://erp.local").searchParams.get("module") ?? []);
    expect(modules).toEqual(PodModuleKeySchema.options);
  });

  it.each([
    ["ZIP", "order-import"], ["订单 导入", "order-import"], ["猫咪", "pillow-artwork"],
    ["轮胎罩", "tire-artwork"], ["备胎罩", "tire-artwork"], ["待发货", "orders-shipment"],
    ["ｚｉｐ", "order-import"], ["生产图", "production-editor"], ["SOP", "workflows"],
    ["画布", "creative-canvas"], ["infinite canvas", "creative-canvas"],
  ])("finds %s using the vocabulary of the task", (query, id) => {
    expect(searchDestinations(query).some((item) => item.id === id)).toBe(true);
  });

  it("ranks exact names first and has a genuine empty state", () => {
    expect(searchDestinations("生产作图")[0]?.id).toBe("production-editor");
    expect(searchDestinations("没有这个功能xyz")).toEqual([]);
    expect(searchDestinations("   ")).toHaveLength(FUNCTION_DESTINATIONS.length);
  });

  it.each(PRIMARY_DESTINATIONS)("selects exactly the primary destination for $href", (item) => {
    const location = resolveNavigationLocation(item.href);
    expect(location.primaryId).toBe(item.id);
    expect(location.breadcrumbs).toEqual(item.href === "/" ? [{ label: "运营总览" }] : [
      { label: "运营总览", href: "/" },
      ...(item.groupId === "overview" ? [] : [{ label: item.groupLabel, href: `/navigation?group=${item.groupId}` }]),
      { label: item.label },
    ]);
  });

  it.each([
    ["/product-specifications", "spu", "商品库", "SPU 详情"],
    ["/product-development", "sku", "销售 SKU 组合", "销售 SKU 详情"],
    ["/sales-plans", "plan", "上架工作台", "销售方案详情"],
  ])("includes query-selected details on %s and preserves the list state", (path, parameter, label, detailLabel) => {
    const location = resolveNavigationLocation(path, `q=blanket&page=2&status=draft&${parameter}=private-record&queue=private-queue&form=1&editSpu=1&compose=1&specificationVersionId=private-spec&artworkVersionId=private-art`);
    expect(location.detailKey).toBe(`${path}:private-record`);
    expect(location.breadcrumbs).toEqual([
      { label: "运营总览", href: "/" },
      { label: "商品与上架", href: "/navigation?group=catalog" },
      { label, href: `${path}?q=blanket&page=2&status=draft` },
      { label: detailLabel },
    ]);
    expect(JSON.stringify(location.breadcrumbs)).not.toContain("private-record");
    expect(resolveNavigationLocation(path, "page=2&q=blanket&status=draft").breadcrumbs).toHaveLength(3);
    expect(resolveNavigationLocation(path, `${parameter}=`).detailKey).toBeUndefined();
  });

  it("matches query values and detail boundaries without leaking record identifiers", () => {
    const review = resolveNavigationLocation("/finance/order-review", "from=2026-10-01T00:00:00Z&sku=private-sku");
    expect(review.primaryId).toBe("finance");
    expect(review.breadcrumbs).toEqual([
      { label: "运营总览", href: "/" }, { label: "研究与经营", href: "/navigation?group=insights" },
      { label: "财务利润", href: "/finance" }, { label: "定制订单履约与利润复盘" },
    ]);
    const pillow = resolveNavigationLocation("/pod-workbench/production-editor", "kind=shaped_pillow&projectId=private-record");
    expect(pillow.primaryId).toBe("production-editor");
    expect(pillow.breadcrumbs).toEqual([
      { label: "运营总览", href: "/" },
      { label: "创作工具", href: "/navigation?group=creative" },
      { label: "生产文件与底稿", href: "/pod-workbench/production-editor" }, { label: "异形抱枕生产图" },
    ]);
    expect(resolveNavigationLocation("/shipments", "orderStatus=produced").current.label).toBe("待发货订单");
    const logistics = resolveNavigationLocation("/shipments", "view=logistics&supplierId=private-supplier");
    expect(logistics.primaryId).toBe("shipments");
    expect(logistics.breadcrumbs).toEqual([
      { label: "运营总览", href: "/" }, { label: "订单与履约", href: "/navigation?group=commerce" },
      { label: "发货中心", href: "/shipments" }, { label: "物流订单同步" },
    ]);
    expect(searchDestinations("ShipOS").some(item => item.id === "logistics-sync" && item.groupId === "commerce")).toBe(true);
    expect(resolveNavigationLocation("/pod-workbench", "module=not-a-module").current.id).toBe("pod-workbench");
    expect(resolveNavigationLocation("/listings/private-id").breadcrumbs).toEqual([
      { label: "运营总览", href: "/" },
      { label: "商品与上架", href: "/navigation?group=catalog" },
      { label: "刊登管理", href: "/listings" },
      { label: "刊登编辑" },
    ]);
    expect(JSON.stringify(resolveNavigationLocation("/analysis/private-id").breadcrumbs)).not.toContain("private-id");
    expect(resolveNavigationLocation("/orders-unknown").primaryId).toBeUndefined();
    expect(resolveNavigationLocation("/workflows/runs/private-id").primaryId).toBe("workflows");
    expect(resolveNavigationLocation("/workflows/templates/private-id/edit").current.label).toBe("编辑流程模板");
    expect(resolveNavigationLocation("/suppliers/private-supplier/factories/private-site").current.label).toBe("工厂详情");
    expect(resolveNavigationLocation("/suppliers/private-supplier/factories/private-site").primaryId).toBe("suppliers");
  });
});
