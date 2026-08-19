"use server";

import type { CustomizationDefinition, ProductPlanInput } from "@yummyai/contracts";
import { CustomizationSchema } from "@yummyai/contracts/catalog/product";
import { revalidatePath } from "next/cache";

import { apiFetch } from "../../server-api";

export interface ProductCreateState {
  fieldErrors?: Partial<Record<"description" | "name" | "sourceReportIds" | "targetCost", string>>;
  message: string;
  planId?: string;
  status: "idle" | "success" | "error";
}

export interface ProductDevelopmentState {
  message: string;
  status: "idle" | "success" | "error";
}

export async function createProductPlan(
  _previous: ProductCreateState,
  formData: FormData,
): Promise<ProductCreateState> {
  const name = value(formData, "name");
  const description = value(formData, "description");
  const targetCostAmount = value(formData, "targetCostAmount");
  const sourceReportIds = list(value(formData, "sourceReportIds"));
  const fieldErrors: ProductCreateState["fieldErrors"] = {};
  if (!name || name.length > 200) fieldErrors.name = "产品名称为必填项，最多 200 个字符。";
  if (description.length > 4_000) fieldErrors.description = "产品描述最多 4000 个字符。";
  if (sourceReportIds.length > 50 || sourceReportIds.some((id) => !UUID_V7_PATTERN.test(id))) {
    fieldErrors.sourceReportIds = "研究报告 ID 必须是有效的 UUIDv7；多个 ID 请用换行或逗号分隔。";
  }
  const amount = targetCostAmount ? Number(targetCostAmount) : undefined;
  const currency = value(formData, "targetCostCurrency").toUpperCase();
  if (
    amount !== undefined &&
    (!Number.isFinite(amount) || amount < 0 || !CURRENCY_PATTERN.test(currency))
  ) {
    fieldErrors.targetCost = "目标成本必须为不小于 0 的数字，并使用三位大写币种代码。";
  }
  if (Object.keys(fieldErrors).length) {
    return { fieldErrors, message: "请检查标出的字段后重新创建。", status: "error" };
  }

  const input: ProductPlanInput = {
    name,
    ...(description ? { description } : {}),
    sourceReportIds,
    ...(amount !== undefined
      ? {
          targetCost: {
            amount,
            currency,
          },
        }
      : {}),
    customization: { version: 1, fields: [] },
  };
  const apiBase = process.env.API_BASE_URL;
  if (!apiBase) return failure("API_BASE_URL 未配置，无法创建产品企划。");
  try {
    const response = await apiFetch(`${apiBase.replace(/\/$/, "")}/v1/products/plans`, {
      body: JSON.stringify(input),
      cache: "no-store",
      headers: { "content-type": "application/json" },
      method: "POST",
    });
    const payload = (await response.json().catch(() => undefined)) as
      { id?: unknown; detail?: unknown; message?: unknown; title?: unknown } | undefined;
    if (!response.ok) return failure(messageFrom(payload) ?? `创建失败 (${response.status})`);
    if (typeof payload?.id !== "string")
      return failure("产品已创建，但接口未返回产品 ID。请刷新目录确认记录。");
    revalidatePath("/products");
    return { message: "产品企划已创建，正在打开开发档案。", planId: payload.id, status: "success" };
  } catch (error) {
    return failure(error instanceof Error ? error.message : "产品企划创建失败。");
  }
}

export async function transitionProductPlan(
  planId: string,
  nextStatus: "pending_approval" | "approved",
  _previous: ProductDevelopmentState,
  _formData: FormData,
): Promise<ProductDevelopmentState> {
  void _previous;
  void _formData;
  return productRequest(
    `/v1/products/plans/${planId}/transitions`,
    {
      body: JSON.stringify({ status: nextStatus }),
      headers: { "content-type": "application/json" },
      method: "POST",
    },
    nextStatus === "pending_approval"
      ? "产品企划已提交立项审核。"
      : "产品企划已批准，可以创建 SPU。",
    planId,
  );
}

export async function saveProductPlanCustomization(
  planId: string,
  _previous: ProductDevelopmentState,
  formData: FormData,
): Promise<ProductDevelopmentState> {
  void _previous;
  const rawCustomization = value(formData, "customization");
  let customization: CustomizationDefinition;
  try {
    customization = CustomizationSchema.parse(JSON.parse(rawCustomization));
  } catch {
    return failure("定制 Schema 无效，请修正字段后再保存。");
  }
  return productRequest(
    `/v1/products/plans/${planId}/customization`,
    {
      body: JSON.stringify({ customization }),
      headers: { "content-type": "application/json" },
      method: "PATCH",
    },
    "定制 Schema 已保存。",
    planId,
  );
}

export async function createProductSpu(
  planId: string,
  _previous: ProductDevelopmentState,
  formData: FormData,
): Promise<ProductDevelopmentState> {
  const code = value(formData, "code").toUpperCase();
  const name = value(formData, "name");
  if (!code || code.length > 80 || !name || name.length > 200)
    return failure("请填写有效的 SPU 编码和名称。");
  return productRequest(
    `/v1/products/plans/${planId}/spu`,
    {
      body: JSON.stringify({ code, name }),
      headers: { "content-type": "application/json" },
      method: "POST",
    },
    "SPU 已创建，产品进入开发中。",
    planId,
  );
}

export async function createProductSku(
  planId: string,
  spuId: string,
  _previous: ProductDevelopmentState,
  formData: FormData,
): Promise<ProductDevelopmentState> {
  const code = value(formData, "code").toUpperCase();
  const amountValue = value(formData, "unitCostAmount");
  const amount = amountValue ? Number(amountValue) : undefined;
  const currency = value(formData, "unitCostCurrency").toUpperCase();
  if (!code || code.length > 100) return failure("请填写有效的 SKU 编码。");
  if (
    amount !== undefined &&
    (!Number.isFinite(amount) || amount < 0 || !CURRENCY_PATTERN.test(currency))
  ) {
    return failure("SKU 单位成本必须为不小于 0 的数字，并使用三位币种代码。");
  }
  let attributes: Record<string, string> = {};
  try {
    attributes = parseAttributes(value(formData, "attributes"));
  } catch (error) {
    return failure(error instanceof Error ? error.message : "SKU 属性格式无效。");
  }
  return productRequest(
    "/v1/products/skus",
    {
      body: JSON.stringify({
        spuId,
        code,
        attributes,
        ...(amount !== undefined ? { unitCost: { amount, currency } } : {}),
      }),
      headers: { "content-type": "application/json" },
      method: "POST",
    },
    "SKU 已创建，现在可以建立设计任务。",
    planId,
  );
}

async function productRequest(
  path: string,
  init: RequestInit,
  successMessage: string,
  planId: string,
): Promise<ProductDevelopmentState> {
  const apiBase = process.env.API_BASE_URL;
  if (!apiBase) return failure("API_BASE_URL 未配置，操作无法完成。");
  try {
    const response = await apiFetch(`${apiBase.replace(/\/$/, "")}${path}`, {
      ...init,
      cache: "no-store",
    });
    const payload = (await response.json().catch(() => undefined)) as
      { detail?: unknown; message?: unknown; title?: unknown } | undefined;
    if (!response.ok) return failure(messageFrom(payload) ?? `操作失败 (${response.status})`);
    revalidatePath("/products");
    revalidatePath(`/products?plan=${planId}`);
    revalidatePath("/design");
    return { message: successMessage, status: "success" };
  } catch (error) {
    return failure(error instanceof Error ? error.message : "产品开发操作失败。");
  }
}

function value(formData: FormData, name: string): string {
  const entry = formData.get(name);
  return typeof entry === "string" ? entry.trim() : "";
}

function list(input: string): string[] {
  return input
    .split(/[,\n]/)
    .map((entry) => entry.trim())
    .filter(Boolean);
}

function messageFrom(
  payload: { detail?: unknown; message?: unknown; title?: unknown } | undefined,
) {
  for (const key of ["detail", "message", "title"] as const) {
    const candidate = payload?.[key];
    if (typeof candidate === "string") return candidate;
    if (Array.isArray(candidate) && candidate.every((entry) => typeof entry === "string"))
      return candidate.join("；");
  }
  return undefined;
}

function failure(message: string): ProductCreateState & ProductDevelopmentState {
  return { message, status: "error" };
}

function parseAttributes(input: string): Record<string, string> {
  if (!input) return {};
  const attributes: Record<string, string> = {};
  for (const pair of input
    .split(/[\n,]/)
    .map((entry) => entry.trim())
    .filter(Boolean)) {
    const separator = pair.indexOf(":");
    if (separator < 1 || !pair.slice(separator + 1).trim())
      throw new Error("SKU 属性请使用“属性: 值”，多个属性用换行或逗号分隔。");
    attributes[pair.slice(0, separator).trim()] = pair.slice(separator + 1).trim();
  }
  return attributes;
}

const UUID_V7_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const CURRENCY_PATTERN = /^[A-Z]{3}$/;
