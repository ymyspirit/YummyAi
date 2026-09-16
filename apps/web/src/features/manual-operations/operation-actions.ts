"use server";

import { ProductPlanInputSchema } from "@yummyai/contracts/catalog/product";
import { CreateProductSupplyInputSchema, ReviseProductSupplyInputSchema, CreateSupplyPurchaseInputSchema } from "@yummyai/contracts/catalog/product-supply";

import {
  CreateFulfillmentSupplierInputSchema, UpdateFulfillmentSupplierInputSchema, FulfillmentSupplierViewSchema,
} from "@yummyai/contracts/order/routing";
import { EntityIdSchema } from "@yummyai/contracts/common/ids";
import {
  CreateWarehouseInputSchema, UpdateWarehouseInputSchema, CreateInventoryLocationInputSchema,
  UpdateInventoryLocationInputSchema, CreateStockItemInputSchema, UpdateStockItemInputSchema,
  RecordInventoryMovementInputSchema,
  InventoryWarehouseViewSchema,
} from "@yummyai/contracts/inventory";
import { CreateMarketplaceAccountInputSchema, UpdateMarketplaceAccountInputSchema } from "@yummyai/contracts/marketplace/store";
import {
  CreateInventoryPurchaseOrderInputSchema, ReviseInventoryPurchaseOrderInputSchema,
  ReviewInventoryPurchaseOrderInputSchema, RecordProcurementReceiptInputSchema,
} from "@yummyai/contracts/procurement";

import { apiFetch } from "../../server-api";
import type { Operation, OperationResult } from "./operation-types";

const definitions = {
  "product.create": { schema: ProductPlanInputSchema, path: "/v1/products/plans", method: "POST" },
  "supply.create": { schema: CreateProductSupplyInputSchema, path: "/v1/product-suppliers", method: "POST" },
  "supply.revise": { schema: ReviseProductSupplyInputSchema, path: "/v1/product-suppliers/:id/revisions", method: "POST" },
  "supply.purchase": { schema: CreateSupplyPurchaseInputSchema, path: "/v1/product-suppliers/:id/purchase-drafts", method: "POST" },
  "store.create": { schema: CreateMarketplaceAccountInputSchema, path: "/v1/marketplace-accounts", method: "POST" },
  "store.update": { schema: UpdateMarketplaceAccountInputSchema, path: "/v1/marketplace-accounts/:id", method: "PATCH" },
  "supplier.create": { schema: CreateFulfillmentSupplierInputSchema, path: "/v1/sourcing/suppliers", method: "POST" },
  "supplier.update": { schema: UpdateFulfillmentSupplierInputSchema, path: "/v1/sourcing/suppliers/:id", method: "PATCH" },
  "warehouse.create": { schema: CreateWarehouseInputSchema, path: "/v1/inventory/warehouses", method: "POST" },
  "warehouse.update": { schema: UpdateWarehouseInputSchema, path: "/v1/inventory/warehouses/:id", method: "PATCH" },
  "location.create": { schema: CreateInventoryLocationInputSchema, path: "/v1/inventory/locations", method: "POST" },
  "location.update": { schema: UpdateInventoryLocationInputSchema, path: "/v1/inventory/locations/:id", method: "PATCH" },
  "stock.create": { schema: CreateStockItemInputSchema, path: "/v1/inventory/stock-items", method: "POST" },
  "stock.update": { schema: UpdateStockItemInputSchema, path: "/v1/inventory/stock-items/:id", method: "PATCH" },
  "movement.create": { schema: RecordInventoryMovementInputSchema, path: "/v1/inventory/movements", method: "POST" },
  "purchase.create": { schema: CreateInventoryPurchaseOrderInputSchema, path: "/v1/procurement/purchase-orders", method: "POST" },
  "purchase.revise": { schema: ReviseInventoryPurchaseOrderInputSchema, path: "/v1/procurement/purchase-orders/:id/revisions", method: "POST" },
  "purchase.review": { schema: ReviewInventoryPurchaseOrderInputSchema, path: "/v1/procurement/purchase-orders/:id/reviews", method: "POST" },
  "purchase.receive": { schema: RecordProcurementReceiptInputSchema, path: "/v1/procurement/purchase-orders/:id/receipts", method: "POST" },
} as const;

const fieldNames: Record<string, string> = {
  name: "名称", displayName: "店铺名称", code: "编码", platform: "平台", region: "区域", marketplaceIds: "站点",
  countryCode: "国家", timeZone: "时区", warehouseId: "仓库", stockItemId: "物料", locationId: "库位",
  destinationLocationId: "收货库位", supplierId: "供应商", quantityDelta: "变动数量", quantity: "数量",
  unitCostMinor: "单价", settlementCurrency: "结算币种", regionCode: "所在地区", lines: "明细",
  lotCode: "批次编码", receivedQuantity: "实收数量", rejectedQuantity: "拒收数量", expectedAt: "预计到货时间",
};

export async function saveOperation(operation: Operation, input: unknown, id?: string): Promise<OperationResult> {
  if (!Object.prototype.hasOwnProperty.call(definitions, operation)) return { ok: false, message: "不支持此操作。" };
  const definition = definitions[operation];
  if (definition.path.includes(":id") && !EntityIdSchema.safeParse(id).success) return { ok: false, message: "记录标识无效，请刷新后重试。" };
  const parsed = definition.schema.safeParse(input);
  if (!parsed.success) {
    const fieldErrors: Record<string, string> = {};
    for (const issue of parsed.error.issues) {
      const path = issue.path.map(String).join(".");
      const field = fieldNames[String(issue.path.at(-1))] ?? fieldNames[String(issue.path[0])] ?? "输入项";
      fieldErrors[path] = `${field}缺失或格式不正确，请检查。`;
    }
    return { ok: false, message: "请检查标出的字段后重新保存。", fieldErrors };
  }
  const base = process.env.API_BASE_URL;
  if (!base) return { ok: false, message: "业务服务尚未配置，请联系管理员。" };
  try {
    const response = await apiFetch(`${base.replace(/\/$/, "")}${definition.path.replace(":id", id ?? "")}`, {
      method: definition.method, cache: "no-store", headers: { "content-type": "application/json" }, body: JSON.stringify(parsed.data),
    });
    const payload = await response.json().catch(() => null) as Record<string, unknown> | null;
    if (!response.ok) return { ok: false, message: operationError(response.status, payload) };
    // Only allow public business fields back into client state; some older APIs return raw rows.
    const publicKeys = ["id", "name", "code", "displayName", "platform", "region", "marketplaceIds", "warehouseId", "countryCode", "timeZone", "type", "skuId", "baseUnit", "status", "kind", "regionCode", "settlementCurrency", "currentVersion"];
    const record = Object.fromEntries(publicKeys.filter((key) => payload && key in payload).map((key) => [key, payload![key]]));
    // These workspaces read with no-store. The owning client refreshes after
    // closing its form, keeping nested create flows mounted until they finish.
    return { ok: true, message: operation === "purchase.receive" ? "收货已登记，库存已同步入账。" : "已保存。", record };
  } catch {
    return { ok: false, message: "未能确认保存结果。请检查连接；采购和库存流水可使用原表单重试，或先刷新确认记录。" };
  }
}

export async function loadSuppliers() {
  const base = process.env.API_BASE_URL;
  if (!base) return { error: "供应商服务尚未配置。", suppliers: [] };
  try {
    const response = await apiFetch(`${base.replace(/\/$/, "")}/v1/sourcing/suppliers`, { cache: "no-store" });
    if (!response.ok) return { error: operationError(response.status, null), suppliers: [] };
    return { suppliers: FulfillmentSupplierViewSchema.array().parse(await response.json()) };
  } catch { return { error: "供应商资料暂时无法读取，请刷新后重试。", suppliers: [] }; }
}

export async function loadWarehouseChoices() {
  const base = process.env.API_BASE_URL;
  if (!base) return { warehouses: [], error: "库存服务尚未配置。" };
  try {
    const response = await apiFetch(`${base.replace(/\/$/, "")}/v1/inventory/warehouses`, { cache: "no-store" });
    if (!response.ok) return { warehouses: [], error: operationError(response.status, null) };
    return { warehouses: InventoryWarehouseViewSchema.array().parse(await response.json()) };
  } catch { return { warehouses: [], error: "无法读取仓库，请关闭后重试。" }; }
}

function operationError(status: number, payload: Record<string, unknown> | null) {
  if (status === 401) return "登录状态已失效，请重新登录后重试。";
  if (status === 403) return "当前成员没有执行此操作的权限，请联系管理员分配对应的业务权限。";
  if (status === 404) return "关联记录不存在或无权访问，请刷新后重新选择。";
  const detail = String(payload?.detail ?? payload?.message ?? "");
  if (/Primary supplier already exists/i.test(detail)) return "此规格已有主供供应商。请先将原主供改为备选，再设置新的主供。";
  if (/Supply relationship already exists/i.test(detail)) return "该供应商与产品规格已经关联，请在已有记录上维护报价。";
  if (/below supplier minimum/i.test(detail)) return "采购数量低于该供应商的起订量，请核对数量。";
  if (/quote is not currently valid/i.test(detail)) return "报价尚未生效或已经到期，请先维护报价。";
  if (/quote or stock item is missing/i.test(detail)) return "请先维护采购单价并关联库存物料，再创建采购草稿。";
  if (/already exists|duplicate key/i.test(detail)) return "名称或编码已存在，请修改后重试。";
  if (/version changed/i.test(detail)) return "这笔单据已被更新，请关闭表单并刷新后重新核对。";
  if (/negative|insufficient|below zero/i.test(detail)) return "调整后库存不足，请核对数量、库位和批次。";
  if (status === 409) return "当前状态不允许此操作，或记录已发生变化。请刷新并核对单据状态、数量及编码。";
  if (status === 400 || status === 422) return "资料未通过校验，请核对必填项、数量、批次及关联记录。";
  return `保存失败（${status}），输入已保留，请稍后重试。`;
}
