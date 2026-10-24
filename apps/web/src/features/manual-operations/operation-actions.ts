"use server";

import { ProductPlanInputSchema } from "@yummyai/contracts/catalog/product";
import { CreateProductSupplyInputSchema, ReviseProductSupplyInputSchema, CreateSupplyPurchaseInputSchema } from "@yummyai/contracts/catalog/product-supply";

import {
  CreateFulfillmentSupplierInputSchema, UpdateFulfillmentSupplierInputSchema, FulfillmentSupplierViewSchema,
} from "@yummyai/contracts/order/routing";
import { EntityIdSchema } from "@yummyai/contracts/common/ids";
import { SupplierProfileSchema } from "@yummyai/contracts/suppliers/supplier-profile";
import { CreateFactorySchema, ReviseFactorySchema, CreateFactoryCapabilitySchema, ReviseFactoryCapabilitySchema, FactoryViewSchema, FactoryCapabilityViewSchema, FactoryDirectorySchema, FactoryHistorySchema } from "@yummyai/contracts/suppliers/factory-directory";
import {
  CreateWarehouseInputSchema, UpdateWarehouseInputSchema, CreateInventoryLocationInputSchema,
  UpdateInventoryLocationInputSchema, CreateStockItemInputSchema, UpdateStockItemInputSchema,
  RecordInventoryMovementInputSchema,
  InventoryWarehouseViewSchema,
  InventoryStockItemViewSchema, ClassifyInventoryStockItemInputSchema,
  InventoryStockClassificationResultSchema, InventoryStockClassificationHistorySchema,
} from "@yummyai/contracts/inventory";
import { CreateMarketplaceAccountInputSchema, UpdateMarketplaceAccountInputSchema } from "@yummyai/contracts/marketplace/store";
import {
  CreateInventoryPurchaseOrderInputSchema, ReviseInventoryPurchaseOrderInputSchema,
  ReviewInventoryPurchaseOrderInputSchema, RecordProcurementReceiptInputSchema,
} from "@yummyai/contracts/procurement";

import { apiFetch } from "../../server-api";
import type { Operation, OperationResult } from "./operation-types";

const definitions = {
  "factory.create": { schema: CreateFactorySchema, path: "/v1/sourcing/factories", method: "POST" },
  "factory.revise": { schema: ReviseFactorySchema, path: "/v1/sourcing/factories/:id/revisions", method: "POST" },
  "factoryCapability.create": { schema: CreateFactoryCapabilitySchema, path: "/v1/sourcing/factories/:id/capabilities", method: "POST" },
  "factoryCapability.revise": { schema: ReviseFactoryCapabilitySchema, path: "/v1/sourcing/factory-capabilities/:id/revisions", method: "POST" },
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
  "stock.classify": { schema: ClassifyInventoryStockItemInputSchema, path: "/v1/inventory/stock-items/:id/classifications", method: "POST" },
  "movement.create": { schema: RecordInventoryMovementInputSchema, path: "/v1/inventory/movements", method: "POST" },
  "purchase.create": { schema: CreateInventoryPurchaseOrderInputSchema, path: "/v1/procurement/purchase-orders", method: "POST" },
  "purchase.revise": { schema: ReviseInventoryPurchaseOrderInputSchema, path: "/v1/procurement/purchase-orders/:id/revisions", method: "POST" },
  "purchase.review": { schema: ReviewInventoryPurchaseOrderInputSchema, path: "/v1/procurement/purchase-orders/:id/reviews", method: "POST" },
  "purchase.receive": { schema: RecordProcurementReceiptInputSchema, path: "/v1/procurement/purchase-orders/:id/receipts", method: "POST" },
} as const;

const fieldNames: Record<string, string> = {
  profile: "档案资料", productionAddress: "生产地址", city: "城市", street: "详细地址", contacts: "联系人", ownership: "工厂性质", verificationReference: "核验依据", processCodes: "承接工序",
  name: "名称", displayName: "店铺名称", code: "编码", platform: "平台", region: "区域", marketplaceIds: "站点",
  countryCode: "国家", timeZone: "时区", warehouseId: "仓库", stockItemId: "物料", locationId: "库位",
  destinationLocationId: "收货库位", supplierId: "供应商", quantityDelta: "变动数量", quantity: "数量",
  unitCostMinor: "单价", settlementCurrency: "结算币种", regionCode: "所在地区", lines: "明细",
  lotCode: "批次编码", receivedQuantity: "实收数量", rejectedQuantity: "拒收数量", expectedAt: "预计到货时间",
  materialKind: "物料分类", kind: "分类", reason: "说明", expectedVersion: "版本",
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
      fieldErrors[path] = operation.startsWith("factory") && issue.code === "custom" ? issue.message : `${field}缺失或格式不正确，请检查。`;
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
    if (!response.ok) {
      const classificationDenied = operation === "stock.classify" && ([401, 403, 404].includes(response.status) || (response.status === 409 && payload?.code === "authority_changed"));
      const factoryDenied = operation.startsWith("factory") && ([401, 403, 404].includes(response.status) || (response.status === 409 && payload?.code === "authority_changed"));
      return { ok: false, ...(classificationDenied || factoryDenied ? { denied: true } : {}), message: factoryDenied ? "工厂访问权限或资料已变化，请重新读取后操作" : classificationDenied ? "当前分类访问权限或会话已变化，请重新读取后核对历史" : operation === "purchase.receive" && payload?.code === "receipt_input_unavailable" ? "旧收货缺少原提交依据，请先核对收货历史，不要直接重新登记" : operation === "purchase.receive" && payload?.code === "receipt_request_mismatch" ? "本次填写与原收货请求不一致，请核对原采购单和填写" : operationError(response.status, payload) };
    }
    if (operation === "stock.classify") {
      const result = InventoryStockClassificationResultSchema.parse(payload);
      const original = ClassifyInventoryStockItemInputSchema.parse(parsed.data);
      if (result.stockItem.id !== id || result.classification.kind !== original.kind || result.classification.versionNumber !== original.expectedVersion + 1)
        return { ok: false, message: "分类回执与本次填写不匹配，请读取历史核对" };
      return { ok: true, message: "分类已保存", record: result.stockItem };
    }
    // Only allow public business fields back into client state; some older APIs return raw rows.
    const publicKeys = ["id", "name", "code", "displayName", "platform", "region", "marketplaceIds", "warehouseId", "countryCode", "timeZone", "type", "skuId", "baseUnit", "status", "kind", "regionCode", "settlementCurrency", "currentVersion"];
    const publicRecord = Object.fromEntries(publicKeys.filter((key) => payload && key in payload).map((key) => [key, payload![key]]));
    const record = operation.startsWith("stock.") ? InventoryStockItemViewSchema.parse(payload) : operation.startsWith("factoryCapability.") ? FactoryCapabilityViewSchema.parse(payload) : operation.startsWith("factory.") ? FactoryViewSchema.parse(payload) : operation.startsWith("supplier.") ? { ...publicRecord, profile: SupplierProfileSchema.parse(payload?.profile ?? {}) } : publicRecord;
    if (operation.startsWith("factory")) {
      let matches = false;
      if (operation === "factory.create") {
        const original = CreateFactorySchema.parse(parsed.data), saved = FactoryViewSchema.parse(record);
        matches = saved.supplierId === original.supplierId && saved.code === original.code && saved.versionNumber === 1 && JSON.stringify(saved.profile) === JSON.stringify(original.profile);
      } else if (operation === "factory.revise") {
        const original = ReviseFactorySchema.parse(parsed.data), saved = FactoryViewSchema.parse(record);
        matches = saved.id === id && saved.versionNumber === original.expectedVersion + 1 && JSON.stringify(saved.profile) === JSON.stringify(original.profile);
      } else if (operation === "factoryCapability.create") {
        const original = CreateFactoryCapabilitySchema.parse(parsed.data), saved = FactoryCapabilityViewSchema.parse(record);
        matches = saved.factoryId === id && saved.versionNumber === 1 && JSON.stringify(saved.profile) === JSON.stringify(original.profile);
      } else if (operation === "factoryCapability.revise") {
        const original = ReviseFactoryCapabilitySchema.parse(parsed.data), saved = FactoryCapabilityViewSchema.parse(record);
        matches = saved.id === id && saved.versionNumber === original.expectedVersion + 1 && JSON.stringify(saved.profile) === JSON.stringify(original.profile);
      }
      if (!matches) return { ok: false, message: "工厂保存回执与本次对象或原填写不一致，请保留原填写并核对版本历史" };
    }
    // These workspaces read with no-store. The owning client refreshes after
    // closing its form, keeping nested create flows mounted until they finish.
    return { ok: true, message: operation === "purchase.receive" ? "收货已登记，库存已同步入账。" : "已保存。", record };
  } catch {
    if (operation === "stock.classify") return { ok: false, message: "未能确认分类是否已保存，请保留原填写重试或读取历史核对" };
    return { ok: false, message: "未能确认保存结果。请检查连接；采购和库存流水可使用原表单重试，或先刷新确认记录。" };
  }
}

export async function loadStockClassificationHistory(stockItemId: string, beforeVersion?: number) {
  const base = process.env.API_BASE_URL;
  if (!base || !EntityIdSchema.safeParse(stockItemId).success || (beforeVersion !== undefined && (!Number.isSafeInteger(beforeVersion) || beforeVersion < 1)))
    return { data: null, error: "物料分类暂时不可用", denied: false };
  try {
    const response = await apiFetch(`${base.replace(/\/$/, "")}/v1/inventory/stock-items/${stockItemId}/classifications${beforeVersion === undefined ? "" : `?beforeVersion=${beforeVersion}`}`, { cache: "no-store" });
    if (!response.ok) {
      const failure = await response.json().catch(() => null);
      return { data: null, error: operationError(response.status, null), denied: [401, 403, 404].includes(response.status) || failure?.code === "authority_changed" };
    }
    const data = InventoryStockClassificationHistorySchema.parse(await response.json());
    if (data.stockItem.id !== stockItemId) return { data: null, error: "分类记录与当前物料不匹配", denied: true };
    return { data, error: null, denied: false };
  } catch { return { data: null, error: "分类记录暂时无法读取，填写会保留，请重新读取后再保存", denied: false }; }
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
export async function loadFactoryDirectory(supplierId?: string) {
  const base = process.env.API_BASE_URL;
  if (!base) return { error: "工厂服务尚未配置。", data: null };
  if (supplierId && !EntityIdSchema.safeParse(supplierId).success) return { error: "供应商标识无效。", data: null };
  try {
    const response = await apiFetch(`${base.replace(/\/$/, "")}/v1/sourcing/factories${supplierId ? `?supplier=${supplierId}` : ""}`, { cache: "no-store" });
    if (!response.ok) {
      const failure = await response.json().catch(() => null) as { code?: unknown } | null;
      return { error: operationError(response.status, null), statusCode: response.status, denied: [401, 403, 404].includes(response.status) || (response.status === 409 && failure?.code === "authority_changed"), data: null };
    }
    return { data: FactoryDirectorySchema.parse(await response.json()) };
  } catch { return { error: "工厂资料暂时无法读取，请刷新后重试。", data: null }; }
}
export async function loadFactoryHistory(factoryId: string) {
  const base = process.env.API_BASE_URL;
  if (!base || !EntityIdSchema.safeParse(factoryId).success) return { error: "工厂资料不可用。", data: null };
  try {
    const response = await apiFetch(`${base.replace(/\/$/, "")}/v1/sourcing/factories/${factoryId}/history`, { cache: "no-store" });
    if (!response.ok) {
      const failure = await response.json().catch(() => null) as { code?: unknown } | null;
      return { error: operationError(response.status, null), statusCode: response.status, denied: [401, 403, 404].includes(response.status) || (response.status === 409 && failure?.code === "authority_changed"), data: null };
    }
    const data = FactoryHistorySchema.parse(await response.json());
    if (data.factoryId !== factoryId) return { error: "版本历史归属不一致，请刷新后重试。", statusCode: 502, data: null };
    return { data };
  } catch { return { error: "版本历史暂时无法读取。", data: null }; }
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
