import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

import { PodModuleKeySchema } from "@yummyai/contracts/pod";
import { describe, expect, it } from "vitest";

import { DIRECTORY_DESTINATION, FUNCTION_DESTINATIONS, PRIMARY_DESTINATIONS, resolveNavigationLocation, searchDestinations } from "./navigation-registry";

describe("navigation destinations", () => {
  it("covers every static ERP page and only links to existing pages", () => {
    const root = fileURLToPath(new URL("../../app/(erp)", import.meta.url));
    const destinations = [...FUNCTION_DESTINATIONS, DIRECTORY_DESTINATION];
    const paths = new Set(destinations.map((item) => new URL(item.href, "https://erp.local").pathname));
    for (const path of paths) expect(existsSync(join(root, path, "page.tsx")), path).toBe(true);
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
    expect(resolveNavigationLocation(item.href).primaryId).toBe(item.id);
  });

  it("matches query values and detail boundaries without leaking record identifiers", () => {
    const pillow = resolveNavigationLocation("/pod-workbench/production-editor", "kind=shaped_pillow&projectId=private-record");
    expect(pillow.primaryId).toBe("production-editor");
    expect(pillow.breadcrumbs).toEqual([
      { label: "运营总览", href: "/" },
      { label: "生产文件与底稿", href: "/pod-workbench/production-editor" }, { label: "异形抱枕生产图" },
    ]);
    expect(resolveNavigationLocation("/orders", "workflowState=awaiting_shipment").current.label).toBe("待发货订单");
    expect(resolveNavigationLocation("/pod-workbench", "module=not-a-module").current.id).toBe("pod-workbench");
    expect(resolveNavigationLocation("/listings/private-id").breadcrumbs).toContainEqual({ label: "刊登控制台", href: "/listings" });
    expect(JSON.stringify(resolveNavigationLocation("/analysis/private-id").breadcrumbs)).not.toContain("private-id");
    expect(resolveNavigationLocation("/orders-unknown").primaryId).toBeUndefined();
    expect(resolveNavigationLocation("/workflows/runs/private-id").primaryId).toBe("workflows");
    expect(resolveNavigationLocation("/workflows/templates/private-id/edit").current.label).toBe("编辑流程模板");
  });
});
