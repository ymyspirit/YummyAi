import { expect, test, type Page } from "@playwright/test";
import { AssistViewSchema, type AssistKind, type CreateAssist } from "@yummyai/contracts/ai/assist";
import { createEntityId, type TenantContext } from "@yummyai/contracts";
import {
  assetFiles,
  connectDatabase,
  personalizationTemplateSourceInspections,
  withTenant,
} from "@yummyai/database";
import { eq } from "drizzle-orm";
import { CheckOrderIntakeInputSchema, OrderIntakeCheckViewSchema, OrderWorkDetailViewSchema } from "@yummyai/contracts/order/workspace";
import { checkOrderIntakeFields } from "../../api/src/orders/order-intake-check.js";
import { ProductionEditorDetailViewSchema } from "@yummyai/contracts/pod/production-editor-api";
import { createProductionDocument } from "../src/features/production-editor/production-editor-model";
import { syntheticProductionPng } from "./production-editor-fixture";
import { createHash } from "node:crypto";
import { AssistBusinessSelectionSchema } from "@yummyai/contracts/ai/assist";

// Synthetic AI transport never calls a paid provider. The PSD case additionally owns one
// inspection and source asset; it soft-deletes that source in teardown, preserving inspection history.
// Real tenant services and worker transport are covered by assist.integration.test.ts.
const id = (n: number) => `019f0000-0000-7000-8000-${n.toString().padStart(12, "0")}`;
const now = "2026-09-13T00:00:00.000Z";
const model = {
  id: id(1),
  model: "synthetic-vision",
  label: "合成图文模型",
  providerLabel: "合成测试渠道",
  inputUsdPerMillion: 1,
  outputUsdPerMillion: 2,
  maxTaskCostUsd: 1,
};
const source = {
  domain: "research",
  researchItemId: id(2),
  snapshotId: id(3),
  studyRevisionId: null,
  studyVersion: 0,
  title: "合成竞品研究",
  sourceUrl: "https://www.etsy.com/listing/100/synthetic",
  platform: "etsy",
  capturedAt: now,
  thumbnailUrl: null,
  mediaCount: 0,
  content: null,
};
const direction = {
  title: "原创几何纪念图案",
  rationale: "根据赠礼场景保留定制区域",
  prompt: "原创几何与可替换姓名",
  negativePrompt: "不要使用竞品标识",
  requirements: {
    mode: "personalized_text",
    audience: "AI 建议人群",
    occasion: "纪念礼物",
    style: "AI 建议蓝色线描",
    fixedElements: "原创几何",
    imageInstructions: "保留可编辑层",
    acceptance: "核对买家原文",
  },
  fields: [
    {
      key: "name",
      label: "名字",
      type: "short_text",
      required: true,
      maxLength: 20,
      helpText: "保留买家原文",
    },
  ],
  evidence: [{ sourceId: id(3), detail: "研究中的赠礼场景" }],
};
function detail(artwork = false) {
  return OrderWorkDetailViewSchema.parse({
    line: {
      id: id(10),
      orderId: id(11),
      externalOrderId: "合成订单-AI-001",
      externalLineId: "1",
      accountId: id(12),
      storeName: "合成店铺",
      platform: "amazon",
      skuCode: "SYNTHETIC-SKU",
      title: "合成定制礼物",
      quantity: 1,
      providerStatus: "Unshipped",
      sideState: null,
      placedAt: now,
      reportLineId: null,
      preparation: artwork ? "pushed" : "pending_review",
      artwork: artwork ? "in_progress" : "not_pushed",
      proof: "not_required",
      production: "not_released",
      readyQuantity: 0,
      shippedQuantity: 0,
      afterSalesCount: 0,
      printSku: null,
      revision: 1,
      projectionVersion: 1,
      held: false,
      sourceChanged: false,
      dueAt: null,
      updatedAt: now,
      editorProjectId: artwork ? id(20) : null,
    },
    draft: {
      printProfileVersionId: null,
      artworkVersionId: null,
      specificationVersionId: null,
      fields: [{ key: "name", label: "名字", kind: "text", value: "Alice / 2026-09-13" }],
      images: [],
      instructions: "保留买家原文",
      customerApprovalRequired: false,
      dueAt: null,
    },
    report: null,
    profile: null,
    assets: [],
    events: [],
    versions: [],
    catalog: {
      status: "unmatched",
      packageId: null,
      recipes: [],
      artworks: [
        {
          id: id(13),
          code: "PRINT-001",
          name: "合成花卉印花",
          version: 1,
          mode: "personalized_text",
          materials: [],
          customization: {
            version: 1,
            fields: [{ key: "name", label: "名字", type: "short_text", required: true }],
          },
          layout: [],
          instructions: "保留买家原文",
        },
      ],
      specifications: [
        {
          id: id(14),
          spuId: id(15),
          spuCode: "SPU-001",
          spuName: "合成胎罩",
          name: "圆形 50cm",
          version: 1,
          processProfileVersionId: id(16),
          processName: "合成工艺",
          dimensions: "50cm",
        },
      ],
    },
  });
}
async function transport(page: Page, kind: AssistKind, configured = true, priced = true) {
  let task: ReturnType<typeof AssistViewSchema.parse> | null = null,
    stale = false;
  const calls: string[] = [];
  await page.route("**/api/ai-assists/**", async (route) => {
    const url = new URL(route.request().url()),
      path = url.pathname,
      method = route.request().method();
    if (path.endsWith("/models")) return route.fulfill({ json: configured ? [{ ...model, ...(priced ? {} : { inputUsdPerMillion: null, outputUsdPerMillion: null, maxTaskCostUsd: null }) }] : [] });
    if (path.includes("/images/"))
      return route.fulfill({ contentType: "image/png", body: syntheticProductionPng(64) });
    if (method === "POST") {
      calls.push(path);
      const request = route.request().postDataJSON() as CreateAssist;
      task = AssistViewSchema.parse({
        id: id(30),
        kind,
        scope:
          kind === "creative" && request.kind === "creative"
            ? `creative:${request.scopeId}`
            : request.kind === "template_config"
              ? `template:${request.inspectionId}`
              : request.kind === "sku_package"
                ? `listing:${request.listingId}`
                : `order:${id(10)}`,
        status: "completed",
        createdAt: now,
        completedAt: now,
        modelLabel: model.label,
        model: model.model,
        maxTaskCostUsd: priced ? 1 : null,
        request,
        promptVersion: "synthetic-fixture",
        inputFingerprint: "synthetic",
        stale: false,
        inputTokens: 200,
        outputTokens: 300,
        costUsd: priced ? 0.001 : null,
        error: null,
        diagnostics: [],
        sources: [
          { id: id(3), label: source.title, href: null },
          { id: id(13), label: "PRINT-001 合成花卉印花", href: null },
          { id: id(14), label: "SPU-001 圆形 50cm", href: null },
        ],
        checks:
          kind === "artwork_preflight"
            ? [
                {
                  code: "text_review",
                  severity: "manual",
                  message: "核对买家名字的排版",
                  location: "名字图层",
                },
              ]
            : [],
        images:
          kind === "artwork_preflight"
            ? [
                {
                  sourceId: "production-preview",
                  label: "本次生产稿预览",
                  path: `/api/ai-assists/runs/${id(30)}/images/0`,
                },
              ]
            : [],
        result: {
          summary: "合成分析结果，请运营核对",
          findings: [],
          directions:
            kind === "creative"
              ? [
                  direction,
                  { ...direction, title: "原创方向二" },
                  { ...direction, title: "原创方向三" },
                ]
              : [],
          matches:
            kind === "order_review"
              ? [
                  {
                    artworkVersionId: id(13),
                    specificationVersionId: id(14),
                    reason: "订单名称和已登记规格一致",
                    evidence: [],
                  },
                ]
              : [],
          missingInformation: [],
          templateSlots:
            kind === "template_config"
              ? [
                  {
                    stableKey: "caption",
                    name: "顾客姓名",
                    kind: "text",
                    fillMode: "none",
                    replaceable: true,
                    fieldKey: "customer_name",
                    reuseLabel: null,
                    reason: "解析到可编辑的文字层",
                    evidence: [{ sourceId: id(3), detail: "合成图层路径" }],
                  },
                ]
              : [],
          listingCopy:
            kind === "sku_package"
              ? {
                  title: "Suggested pet gift",
                  description: "Suggested description for the verified product.",
                  bullets: ["Personalized artwork"],
                  tags: [],
                  personalizationInstructions: "Enter a name.",
                  imageDescriptions: [],
                  evidence: [{ sourceId: id(3), detail: "合成规格事实" }],
                }
              : null,
        },
      });
      return route.fulfill({ json: task });
    }
    if (path.endsWith("/runs"))
      return route.fulfill({
        json: task
          ? [
              {
                id: task.id,
                status: task.status,
                modelLabel: task.modelLabel,
                createdAt: task.createdAt,
              },
            ]
          : [],
      });
    return route.fulfill({
      json: task ? { ...task, stale, ...(stale ? { result: null, images: [] } : {}) } : null,
    });
  });
  return {
    calls,
    makeStale: () => {
      stale = true;
    },
  };
}
async function orderRoutes(page: Page, artwork = false) {
  const value = detail(artwork),
    writes: string[] = [];
  await page.route("**/api/order-centers/**", (route) => {
    const path = new URL(route.request().url()).pathname;
    // The list uses POST for a bounded, read-only summary query.
    if (path === "/api/order-centers/summaries" && route.request().method() === "POST")
      return route.fulfill({ json: { items: [] } });
    if (path === `/api/order-centers/lines/${value.line.id}/intake-check` && route.request().method() === "POST") {
      const input = CheckOrderIntakeInputSchema.parse(route.request().postDataJSON());
      if (input.expectedRevision !== value.line.revision || input.expectedSourceVersionId !== (value.report?.versionId ?? null))
        return route.fulfill({ status: 409, json: { message: "Synthetic input is stale" } });
      const art = value.catalog?.artworks.find(item => item.id === input.draft.artworkVersionId);
      const checked = checkOrderIntakeFields(art?.customization ?? { version: 1, fields: [] }, input.draft, false);
      const matched = !!art && !!input.draft.printProfileVersionId;
      const issues = [...checked.issues, ...(!matched ? [{ code: "basis_or_image_invalid", fieldKey: null,
        message: "请先匹配本单印花与制作版本", action: "核对制作依据后重新检查" }] : [])];
      return route.fulfill({ json: OrderIntakeCheckViewSchema.parse({
        orderLineId: value.line.id, revision: value.line.revision, sourceVersionId: value.report?.versionId ?? null,
        ready: matched && issues.length === 0, basis: matched ? "manual" : "unmatched", package: null,
        fields: checked.fields, issues, normalizedDraft: checked.normalizedDraft,
        notes: ["Synthetic AI transport checks explicit fields; native order tests verify actual save authority"],
      }) });
    }
    if (route.request().method() !== "GET") {
      writes.push(path);
      return route.fulfill({ status: 409, json: { message: "Fixture refuses business writes" } });
    }
    if (path.endsWith("/options"))
      return route.fulfill({
        json: {
          profiles: [],
          suppliers: [],
          stores: [],
          standards: [],
          preferenceScope: "synthetic-ai",
        },
      });
    if (path.endsWith("/workspace"))
      return route.fulfill({ json: { items: [value.line], total: 1, page: 1, pageSize: 25 } });
    if (path.endsWith("/operations"))
      return route.fulfill({ json: { production: [], shipments: [], cases: [] } });
    if (path.endsWith("/template-plan"))
      return route.fulfill({
        json: {
          orderLineId: value.line.id,
          revision: value.line.revision,
          sourceVersionId: value.report?.versionId ?? null,
          ready: false,
          templateVersionId: null,
          artworkVersionId: null,
          specificationVersionId: null,
          blockers: ["缺少必填定制内容：照片"],
          notes: ["条件检查不会创建生产文件。"],
          mappings: [
            {
              fieldKey: "name",
              label: "姓名",
              type: "short_text",
              value: "Alice / 2026-09-13",
              region: "10%, 10% · 80% × 20%",
            },
          ],
        },
      });
    return route.fulfill({ json: value });
  });
  if (artwork)
    await page.route("**/api/production-editor/projects/**", (route) =>
      route.fulfill({
        json: ProductionEditorDetailViewSchema.parse({
          project: {
            id: id(20),
            name: "合成生产稿",
            productType: "tire_cover",
            currentVersionId: id(21),
            versionNumber: 1,
            source: null,
            workSource: { workItemId: id(10), revisionId: id(22) },
            catalogSource: null,
            expiresAt: null,
            createdAt: now,
            updatedAt: now,
          },
          version: {
            id: id(21),
            versionNumber: 1,
            document: createProductionDocument("tire_cover"),
            createdAt: now,
            reviewed: false,
          },
          versions: [],
          images: [],
          fonts: [],
          renders: [],
        }),
      }),
    );
  return writes;
}

async function businessTransport(
  page: Page,
  kind: "business_review" | "procurement_review" | "after_sales_review",
  configured = true,
) {
  let task: ReturnType<typeof AssistViewSchema.parse> | null = null;
  const calls: string[] = [],
    inputs: unknown[] = [];
  let failPreview = false;
  await page.route("**/api/ai-assists/**", (route) => {
    const path = new URL(route.request().url()).pathname;
    if (path.endsWith("/models")) return route.fulfill({ json: configured ? [model] : [] });
    if (path.endsWith("/basis")) {
      if (failPreview)
        return route.fulfill({ status: 403, json: { message: "当前账号没有这项分析权限" } });
      const selection = AssistBusinessSelectionSchema.parse(route.request().postDataJSON());
      return route.fulfill({
        json: {
          fingerprint: createHash("sha256").update(JSON.stringify(selection)).digest("hex"),
          rows:
            kind === "business_review"
              ? [
                  { label: "贡献利润", value: "待补资料" },
                  { label: "比较口径", value: "当前计算缺成本，不能比较增长率" },
                ]
              : kind === "procurement_review"
                ? [
                    { label: "规则建议补货数量", value: "待补资料" },
                    { label: "有效报价行", value: "0" },
                  ]
                : [
                    { label: "售后状态", value: "awaiting_internal" },
                    { label: "已登记沟通", value: "1" },
                  ],
          sources: [{ id: id(221), label: "合成业务证据", href: "/after-sales" }],
          checks: [
            {
              code: "missing_evidence",
              severity: "manual",
              message:
                kind === "procurement_review"
                  ? "没有有效的供应商报价，请先询价"
                  : "需要核对原始证据",
              location: null,
            },
          ],
          diagnostics: ["合成测试传输，不调用实际渠道"],
        },
      });
    }
    if (route.request().method() === "POST") {
      calls.push(path);
      const request = route.request().postDataJSON() as CreateAssist;
      inputs.push(request);
      task = AssistViewSchema.parse({
        id: id(230),
        kind,
        scope:
          kind === "business_review"
            ? `finance:${id(201)}`
            : kind === "procurement_review"
              ? `procurement:${id(211)}:${id(212)}`
              : `case:${id(221)}`,
        status: "completed",
        createdAt: now,
        completedAt: now,
        modelLabel: model.label,
        model: model.model,
        maxTaskCostUsd: 1,
        request,
        promptVersion: "synthetic-business-fixture",
        inputFingerprint: "a".repeat(64),
        stale: false,
        inputTokens: 120,
        outputTokens: 240,
        costUsd: 0.001,
        error: null,
        diagnostics: [],
        sources: [{ id: id(221), label: "合成业务证据", href: "/after-sales" }],
        checks: [],
        images: [],
        result: {
          summary: "合成业务分析，请核对证据",
          findings: [],
          directions: [],
          matches: [],
          missingInformation: ["尚缺原始证据"],
          actions: [
            {
              title: "补齐核对证据",
              detail: "先核对系统记录与实际情况，再按业务流程处理。",
              priority: "high",
              sourceId: id(221),
              evidence: [{ sourceId: id(221), detail: "本次状态记录" }],
            },
          ],
          replyDraft:
            kind === "after_sales_review"
              ? {
                  locale: "en-US",
                  body: "Could you confirm the size of the item you received?",
                  evidence: [{ sourceId: id(221), detail: "售后状态" }],
                }
              : null,
        },
      });
      return route.fulfill({ json: task });
    }
    return route.fulfill({ json: path.endsWith("/runs") ? (task ? [task] : []) : task });
  });
  return {
    calls,
    inputs,
    failPreview: () => {
      failPreview = true;
    },
  };
}

test("third batch finance previews missing costs before analysis and invalidates changed comparison", async ({
  page,
}, info) => {
  test.skip(
    info.config.metadata.aiBusinessTransport !== true,
    "Requires the isolated business transport fixture",
  );
  const ai = await businessTransport(page, "business_review");
  await page.goto("/finance");
  const panel = page.getByRole("region", { name: "经营 AI 分析", exact: true });
  await expect(panel.getByRole("button", { name: "开始分析", exact: true })).toBeDisabled();
  await page.getByRole("button", { name: "读取分析依据", exact: true }).click();
  await expect(page.getByText("当前计算缺成本，不能比较增长率", { exact: true })).toBeVisible();
  expect(ai.calls).toHaveLength(0);
  await panel.getByRole("button", { name: "开始分析", exact: true }).click();
  await expect(panel.getByText("补齐核对证据", { exact: true })).toBeVisible();
  await page.getByLabel("比较计算（可选）").selectOption(id(202));
  await expect(panel.getByRole("button", { name: "重新分析", exact: true })).toBeDisabled();
  await page.screenshot({ path: info.outputPath("business-desktop.png"), fullPage: true });
  await page.setViewportSize({ width: 390, height: 844 });
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  await page.screenshot({ path: info.outputPath("business-mobile.png"), fullPage: true });
  expect(ai.calls).toHaveLength(1);
});

test("third batch procurement exposes missing quotes and blocks analysis after a denied refresh", async ({
  page,
}, info) => {
  test.skip(
    info.config.metadata.aiBusinessTransport !== true,
    "Requires the isolated business transport fixture",
  );
  const ai = await businessTransport(page, "procurement_review");
  await page.goto("/procurement");
  await page.getByRole("button", { name: "读取分析依据", exact: true }).click();
  await expect(page.getByText("没有有效的供应商报价，请先询价", { exact: true })).toBeVisible();
  const panel = page.getByRole("region", { name: "采购 AI 分析", exact: true });
  await panel.getByRole("button", { name: "开始分析", exact: true }).click();
  await expect(panel.getByText("补齐核对证据", { exact: true })).toBeVisible();
  await page.screenshot({ path: info.outputPath("procurement-desktop.png"), fullPage: true });
  await page.setViewportSize({ width: 390, height: 844 });
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  await page.screenshot({ path: info.outputPath("procurement-mobile.png"), fullPage: true });
  await page.emulateMedia({ colorScheme: "dark" });
  await expect(page.locator("html")).toHaveAttribute("data-theme", "dark");
  await page.screenshot({ path: info.outputPath("procurement-mobile-dark.png"), fullPage: true });
  ai.failPreview();
  await page.getByRole("button", { name: "刷新分析依据", exact: true }).click();
  await expect(
    page.getByRole("region", { name: "采购分析", exact: true }).getByRole("alert"),
  ).toContainText("当前账号没有这项分析权限");
  await expect(panel.getByRole("button", { name: "重新分析", exact: true })).toBeDisabled();
  expect(ai.calls).toHaveLength(1);
});

test("third batch after-sales keeps raw contacts local and restores editable unsent replies", async ({
  page,
}, info) => {
  test.skip(
    info.config.metadata.aiBusinessTransport !== true,
    "Requires the isolated business transport fixture",
  );
  const writes = await orderRoutes(page),
    ai = await businessTransport(page, "after_sales_review");
  await page.route("**/api/order-centers/lines/*/operations", (route) =>
    route.fulfill({
      json: {
        production: [],
        shipments: [],
        cases: [
          {
            case: {
              id: id(221),
              type: "quality_issue",
              status: "awaiting_internal",
              reasonCode: "SIZE_MISMATCH",
              currentDecisionVersion: 0,
              createdAt: now,
              summary: "合成客户原始摘要 PRIVATE-SUMMARY",
            },
            contacts: [
              {
                id: id(222),
                direction: "inbound",
                occurredAt: now,
                body: "合成客户消息 PRIVATE-CONTACT",
              },
            ],
            decisions: [],
          },
        ],
      },
    }),
  );
  await page.goto(`/after-sales?line=${id(10)}`);
  await page.getByText("售后 AI 分析与回复草稿", { exact: true }).click();
  await page
    .getByLabel("给 AI 的问题说明（可选）")
    .fill("运营核对：客户反馈尺寸有误，尚缺测量证据。");
  await page.getByRole("button", { name: "读取分析依据", exact: true }).click();
  const panel = page.getByRole("region", { name: "售后 AI 分析", exact: true });
  await panel.getByRole("button", { name: "开始分析", exact: true }).click();
  await expect(panel.getByLabel("客服回复草稿")).toHaveValue(
    "Could you confirm the size of the item you received?",
  );
  await panel.getByLabel("客服回复草稿").fill("Could you confirm the measured width?");
  expect(JSON.stringify(ai.inputs)).not.toMatch(/PRIVATE-SUMMARY|PRIVATE-CONTACT/);
  await page.screenshot({ path: info.outputPath("after-sales-desktop.png"), fullPage: true });
  await page.setViewportSize({ width: 390, height: 844 });
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  await page.screenshot({ path: info.outputPath("after-sales-mobile.png"), fullPage: true });
  await page.reload();
  await page.getByText("售后 AI 分析与回复草稿", { exact: true }).click();
  await expect(panel.getByRole("button", { name: "复制回复草稿" })).toBeDisabled();
  await panel.getByRole("button", { name: "载入这次分析的选项" }).click();
  await expect(page.getByLabel("给 AI 的问题说明（可选）")).toHaveValue(
    "运营核对：客户反馈尺寸有误，尚缺测量证据。",
  );
  await page.getByRole("button", { name: "读取分析依据", exact: true }).click();
  await expect(panel.getByRole("button", { name: "复制回复草稿" })).toBeEnabled();
  expect(writes).toHaveLength(0);
  expect(ai.calls).toHaveLength(1);
});

test("third batch missing channel stays explicit without a synthetic result", async ({
  page,
}, info) => {
  test.skip(
    info.config.metadata.aiBusinessTransport !== true,
    "Requires the isolated business transport fixture",
  );
  const ai = await businessTransport(page, "procurement_review", false);
  await page.goto("/procurement");
  const panel = page.getByRole("region", { name: "采购 AI 分析", exact: true });
  await expect(panel.getByText("尚未配置可用的分析模型。", { exact: false })).toBeVisible();
  await expect(panel.getByRole("button", { name: "开始分析", exact: true })).toHaveCount(0);
  expect(ai.calls).toHaveLength(0);
});

test("creative analysis shows 3 directions and only applies selected edited fields", async ({
  page,
}, info) => {
  const errors: string[] = [];
  page.on("pageerror", (e) => errors.push(e.message));
  const ai = await transport(page, "creative");
  await page.route("**/api/canvas-bridge/briefs", (route) => route.fulfill({ json: [] }));
  await page.route("**/api/product-development/options", (route) =>
    route.fulfill({
      json: {
        artworks: [],
        specifications: [],
        spus: [],
        researchItems: [],
        profiles: [],
        materialAssets: [],
      },
    }),
  );
  await page.route("**/api/research/creative-sources", (route) =>
    route.fulfill({ json: [source] }),
  );
  await page.goto(`/creative-designs/canvas?research=${id(2)}`);
  await page.getByLabel("目标人群", { exact: true }).fill("运营确认人群");
  const panel = page.getByRole("region", { name: "创意 AI 分析" });
  await panel.getByRole("button", { name: "开始分析", exact: true }).click();
  await expect(panel.getByRole("button", { name: "选择字段" })).toHaveCount(3);
  await panel.getByRole("button", { name: "选择字段" }).first().click();
  await panel.getByLabel("AI 建议风格与配色").fill("运营修订后的蓝色线描");
  await panel.getByRole("checkbox", { name: "风格与配色", exact: true }).check();
  await panel.getByRole("button", { name: "采用 1 个字段" }).click();
  await expect(page.getByLabel("目标人群", { exact: true })).toHaveValue("运营确认人群");
  await expect(page.getByLabel("风格与配色", { exact: true })).toHaveValue("运营修订后的蓝色线描");
  expect(ai.calls).toHaveLength(1);
  expect(errors).toEqual([]);
  await page.screenshot({ path: info.outputPath("creative-ai-desktop.png"), fullPage: true });
  await page.setViewportSize({ width: 390, height: 844 });
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  await page.screenshot({ path: info.outputPath("creative-ai-mobile.png"), fullPage: true });
});

test("order AI recommendations fill a draft without changing buyer text or pushing the order", async ({
  page,
}, info) => {
  const writes = await orderRoutes(page),
    ai = await transport(page, "order_review");
  await page.goto(`/orders?line=${id(10)}`);
  const panel = page.getByRole("region", { name: "订单 AI 预审" });
  await panel.getByRole("button", { name: "开始分析", exact: true }).click();
  await panel.getByRole("button", { name: "填入匹配草稿" }).click();
  await expect(page.getByLabel("本单印花版本")).toHaveValue(id(13));
  await expect(page.getByLabel("本单产品 SPU")).toHaveValue(id(15));
  await expect(page.locator("textarea").filter({ hasText: "Alice / 2026-09-13" })).toHaveCount(1);
  await expect(panel.getByText("请先保存订单修改，再基于已保存资料分析")).toBeVisible();
  expect(writes).toEqual([]);
  expect(ai.calls).toHaveLength(1);
  await page.screenshot({ path: info.outputPath("order-ai-desktop.png"), fullPage: true });
  await page.setViewportSize({ width: 390, height: 844 });
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
});

test("production preflight shows analyzed pixels and makes outdated reports unusable", async ({
  page,
}, info) => {
  const writes = await orderRoutes(page, true),
    ai = await transport(page, "artwork_preflight");
  await page.goto(`/order-artwork?line=${id(10)}`);
  const panel = page.getByRole("region", { name: "生产稿 AI 预检" });
  await panel.getByRole("button", { name: "开始分析", exact: true }).click();
  await expect(panel.getByText("核对买家名字的排版")).toBeVisible();
  await expect(panel.getByRole("img", { name: "本次生产稿预览" })).toBeVisible();
  await page.screenshot({ path: info.outputPath("artwork-ai-desktop.png"), fullPage: true });
  ai.makeStale();
  await panel.getByRole("button", { name: "刷新", exact: true }).click();
  await expect(panel.getByText(/这份结果不可直接采用/)).toBeVisible();
  expect(writes).toEqual([]);
  await page.setViewportSize({ width: 390, height: 844 });
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
});

test("unconfigured AI shows setup guidance without invoking a provider", async ({ page }) => {
  await orderRoutes(page);
  const ai = await transport(page, "order_review", false);
  await page.goto(`/orders?line=${id(10)}`);
  const panel = page.getByRole("region", { name: "订单 AI 预审" });
  await expect(panel.getByRole("link", { name: "前往 AI 模型配置" })).toHaveAttribute(
    "href",
    /^\/settings\/ai\?returnTo=/,
  );
  await expect(panel.getByRole("button", { name: "开始分析" })).toHaveCount(0);
  expect(ai.calls).toEqual([]);
});

test("shared text models work without duplicate setup and unknown prices never display as a free analysis", async ({ page }) => {
  await orderRoutes(page);
  const ai = await transport(page, "order_review", true, false);
  await page.goto(`/orders?line=${id(10)}`);
  const panel = page.getByRole("region", { name: "订单 AI 预审" });
  await expect(panel.getByText(/共用已保存的文本模型/)).toBeVisible();
  await panel.getByRole("button", { name: "开始分析", exact: true }).click();
  await expect(panel.getByText(/费用待渠道确认/)).toBeVisible();
  await expect(panel.getByText(/200\/300 tokens/)).toBeVisible();
  await expect(panel.getByText(/按配置估算 \$0/)).toHaveCount(0);
  expect(ai.calls).toHaveLength(1);
  await page.setViewportSize({ width: 390, height: 844 });
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
});

test("SKU copy assistant adopts selected edited fields into an unsaved listing and wraps on mobile", async ({
  page,
}, info) => {
  // This case explicitly owns the existing LISTING_DEMO_MODE editor fixture and AI transport.
  await transport(page, "sku_package");
  await page.goto(`/listings/${id(40)}`);
  const panel = page.getByRole("region", { name: "SKU 资料包助手" });
  const title = await page.getByLabel("商品标题").inputValue();
  await panel.getByRole("button", { name: "开始分析", exact: true }).click();
  await panel.getByLabel("AI 建议描述", { exact: true }).fill("Operator-reviewed description");
  await panel.getByRole("checkbox", { name: "描述", exact: true }).check();
  await panel.getByRole("button", { name: "填入所选字段" }).click();
  await expect(page.getByRole("textbox", { name: /^商品描述/ })).toHaveValue(
    "Operator-reviewed description",
  );
  await expect(page.getByLabel("商品标题")).toHaveValue(title);
  await expect(page.getByText("● 未保存")).toBeVisible();
  await expect(panel.getByRole("button", { name: "重新分析", exact: true })).toBeDisabled();
  await page.screenshot({ path: info.outputPath("sku-ai-desktop.png"), fullPage: true });
  await page.setViewportSize({ width: 390, height: 844 });
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  await page.screenshot({ path: info.outputPath("sku-ai-mobile.png"), fullPage: true });
});

test("template preparation explains blockers and preserves exact buyer text without writing", async ({
  page,
}, info) => {
  const writes = await orderRoutes(page);
  await transport(page, "order_review", false);
  await page.goto(`/orders?line=${id(10)}`);
  const panel = page.getByRole("region", { name: "模板制图条件" });
  await panel.getByRole("button", { name: "检查模板制图条件" }).click();
  await expect(panel.getByText("暂不能自动制图", { exact: true })).toBeVisible();
  await expect(panel.getByText("缺少必填定制内容：照片", { exact: true })).toBeVisible();
  await expect(panel.getByText("Alice / 2026-09-13", { exact: true })).toBeVisible();
  expect(writes).toEqual([]);
  await page.setViewportSize({ width: 390, height: 844 });
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  await page.screenshot({ path: info.outputPath("template-plan-mobile.png"), fullPage: true });
});

test("PSD suggestions populate only a chosen detected slot and never acknowledge parser warnings", async ({
  page,
}, info) => {
  test.skip(!process.env.DATABASE_URL, "Database is required for the isolated inspection fixture");
  const database = connectDatabase(),
    assetId = createEntityId(),
    inspectionId = createEntityId();
  const context: TenantContext = {
    tenantId: "019f7600-0000-7000-8000-000000000001",
    userId: "019f7600-0000-7000-8000-000000000002",
    dataScope: "tenant",
    permissions: [],
  };
  // Only these two UUIDs are owned by this fixture; no provider, file upload or template confirmation.
  try {
    await withTenant(database.db, context, async (tx) => {
      await tx.insert(assetFiles).values({
        id: assetId,
        tenantId: context.tenantId,
        assetDomain: "authorized",
        objectKey: `tenants/${context.tenantId}/authorized/e2e/${assetId}.psd`,
        fileName: "Synthetic PSD assistant fixture.psd",
        mediaType: "image/vnd.adobe.photoshop",
        byteSize: 100,
        checksumSha256: "a".repeat(64),
        rightsStatus: "approved",
        rightsMetadata: { source: { kind: "original" } },
      });
      await tx.insert(personalizationTemplateSourceInspections).values({
        id: inspectionId,
        tenantId: context.tenantId,
        sourceAssetId: assetId,
        sourceAssetVersion: 1,
        checksumSha256: "a".repeat(64),
        source: "psd",
        assetDomain: "authorized",
        rightsStatus: "approved",
        idempotencyKey: createEntityId(),
        status: "completed",
        parserKey: "synthetic",
        parserVersion: "1",
        canvas: { width: 300, height: 300, dpi: 300, colorMode: "rgb" },
        slotSnapshot: [
          {
            stableKey: "caption",
            name: "Unclassified caption",
            kind: "decoration",
            fillMode: "contain",
            replaceable: false,
            geometry: { x: 20, y: 40, width: 160, height: 30, rotationDegrees: 0 },
            validationSnapshot: {},
            sourceLayerPath: ["text", "caption"],
            confidencePermille: 800,
          },
        ],
        warningSnapshot: [
          {
            code: "SYNTHETIC_WARNING",
            message: "请核对合成文字图层",
            layerPath: ["text", "caption"],
          },
        ],
        requestedBy: context.userId,
        completedAt: new Date(),
      });
    });
    const ai = await transport(page, "template_config");
    await page.goto("/pod-workbench?module=personalization");
    const panel = page.getByRole("region", { name: "PSD 模板配置助手" }).first();
    await panel.getByRole("button", { name: "开始分析", exact: true }).click();
    await panel.getByRole("button", { name: "填入此槽位配置" }).click();
    const card = page.locator("article").filter({ has: panel });
    await expect(card.locator('input[name="slot.0.name"]')).toHaveValue("顾客姓名");
    await expect(card.locator('select[name="slot.0.kind"]')).toHaveValue("text");
    await expect(card.locator('input[name="slot.0.suggestedFieldKey"]')).toHaveValue(
      "customer_name",
    );
    await expect(card.locator('input[name="acknowledgeWarnings"]')).not.toBeChecked();
    await expect(card.getByText("位置 20, 40 · 160×30", { exact: true })).toBeVisible();
    await expect(page.locator(".pod-governance-layout > .pod-template-ledger")).toHaveCSS(
      "max-height",
      "none",
    );
    expect(ai.calls).toHaveLength(1);
    await page.screenshot({ path: info.outputPath("psd-ai-desktop.png"), fullPage: true });
    await page.setViewportSize({ width: 390, height: 844 });
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(
      true,
    );
    await page.screenshot({ path: info.outputPath("psd-ai-mobile.png"), fullPage: true });
  } finally {
    await withTenant(database.db, context, async (tx) => {
      await tx.update(assetFiles).set({ deletedAt: new Date() }).where(eq(assetFiles.id, assetId));
    });
    await database.client.end();
  }
});
