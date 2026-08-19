"use server";

import {
  CustomProductAssetAssignmentSchema,
  CustomProductProfileV1Schema,
  type AmazonCustomSurface,
  type CustomProductAssetAssignment,
  type CustomProductProfileV1,
  type SourcedTextFact,
} from "@yummyai/contracts/catalog/custom-product-package";
import { revalidatePath } from "next/cache";

import { apiFetch } from "../../server-api";

export interface CustomProductPackageActionState {
  message: string;
  status: "idle" | "success" | "error";
}

export async function generateProvisionalCustomProductProfile(
  planId: string,
  _previous: CustomProductPackageActionState,
  formData: FormData,
): Promise<CustomProductPackageActionState> {
  void _previous;
  const researchItemId = value(formData, "researchItemId");
  const targetMarketplace = value(formData, "targetMarketplace") || "amazon.com";
  if (!UUID_V7_PATTERN.test(researchItemId)) {
    return failure("请输入有效的研究资料 UUIDv7。");
  }
  return customPackageRequest(
    planId,
    `/v1/products/plans/${planId}/custom-package/provisional`,
    {
      body: JSON.stringify({ researchItemId, targetMarketplace }),
      headers: { "content-type": "application/json" },
      method: "POST",
    },
    "已从竞品研究生成临时产品事实。所有内容仍可编辑，且尚未被视为自有产品事实。",
  );
}

export async function saveCustomProductProfile(
  planId: string,
  _previous: CustomProductPackageActionState,
  formData: FormData,
): Promise<CustomProductPackageActionState> {
  void _previous;
  let current: CustomProductProfileV1;
  try {
    current = CustomProductProfileV1Schema.parse(JSON.parse(value(formData, "currentProfile")));
  } catch {
    return failure("当前产品事实数据无效，请刷新页面后重试。");
  }

  const confirmFacts = formData.get("confirmFacts") === "on";
  const packageQuantityInput = value(formData, "packageQuantity");
  const packageQuantity = packageQuantityInput ? Number(packageQuantityInput) : undefined;
  if (
    packageQuantity !== undefined &&
    (!Number.isInteger(packageQuantity) || packageQuantity < 1 || packageQuantity > 100_000)
  ) {
    return failure("包装数量必须是 1 到 100000 之间的整数。");
  }

  let assetAssignments: CustomProductAssetAssignment[];
  try {
    assetAssignments = parseAssetAssignments(value(formData, "assetAssignments"));
  } catch (error) {
    return failure(error instanceof Error ? error.message : "素材关联格式无效。");
  }

  const firstSurface = current.surfaces[0];
  const areaWidth = numberValue(formData, "areaWidthMm");
  const areaHeight = numberValue(formData, "areaHeightMm");
  if ((areaWidth === undefined) !== (areaHeight === undefined)) {
    return failure("定制区域宽度和高度必须同时填写。");
  }
  if (
    (areaWidth !== undefined && (areaWidth <= 0 || areaWidth > 10_000)) ||
    (areaHeight !== undefined && (areaHeight <= 0 || areaHeight > 10_000))
  ) {
    return failure("定制区域尺寸必须大于 0 且不超过 10000 mm。");
  }

  const surfaceLabel = value(formData, "surfaceLabel");
  const surfaceProcess = value(formData, "surfaceProcess");
  const fieldKeys = parseJsonStringArray(value(formData, "surfaceFieldKeys"));
  const surfaces: AmazonCustomSurface[] = surfaceLabel
    ? [
        {
          key: firstSurface?.key ?? "front",
          label: surfaceLabel,
          fieldKeys,
          ...(areaWidth !== undefined && areaHeight !== undefined
            ? { areaMm: { width: areaWidth, height: areaHeight } }
            : {}),
          ...(surfaceProcess ? { process: surfaceProcess } : {}),
          ...provenance(
            firstSurface,
            confirmFacts,
            surfaceChanged(firstSurface, surfaceLabel, surfaceProcess, areaWidth, areaHeight),
          ),
        },
        ...current.surfaces.slice(1),
      ]
    : [];

  const profileCandidate: CustomProductProfileV1 = {
    ...current,
    sku: textFact(current.sku, value(formData, "sku"), confirmFacts),
    targetMarketplace: textFact(
      current.targetMarketplace,
      value(formData, "targetMarketplace"),
      confirmFacts,
    ),
    productType: textFact(current.productType, value(formData, "productType"), confirmFacts),
    brand: textFact(current.brand, value(formData, "brand"), confirmFacts),
    materials: textFacts(current.materials, lines(value(formData, "materials")), confirmFacts),
    colors: textFacts(current.colors, lines(value(formData, "colors")), confirmFacts),
    sizeOptions: textFacts(
      current.sizeOptions,
      lines(value(formData, "sizeOptions")),
      confirmFacts,
    ),
    packageQuantity:
      packageQuantity === undefined
        ? undefined
        : {
            value: packageQuantity,
            ...provenance(
              current.packageQuantity,
              confirmFacts,
              current.packageQuantity?.value !== packageQuantity,
            ),
          },
    packageContents: textFacts(
      current.packageContents,
      lines(value(formData, "packageContents")),
      confirmFacts,
    ),
    manufacturingProcess: textFact(
      current.manufacturingProcess,
      value(formData, "manufacturingProcess"),
      confirmFacts,
    ),
    targetAudiences: textFacts(
      current.targetAudiences,
      lines(value(formData, "targetAudiences")),
      confirmFacts,
    ),
    sellingPoints: textFacts(
      current.sellingPoints,
      lines(value(formData, "sellingPoints")),
      confirmFacts,
    ),
    surfaces,
    assetAssignments,
    updatedAt: new Date().toISOString(),
  };

  let profile: CustomProductProfileV1;
  try {
    profile = CustomProductProfileV1Schema.parse(profileCandidate);
  } catch {
    return failure("产品事实未通过格式校验，请检查字段长度、定制区域和素材 ID。");
  }
  return customPackageRequest(
    planId,
    `/v1/products/plans/${planId}/custom-package/profile`,
    {
      body: JSON.stringify({ profile }),
      headers: { "content-type": "application/json" },
      method: "PATCH",
    },
    confirmFacts
      ? "产品事实已保存并标记为卖家确认。正式包仍会校验授权素材和必填项。"
      : "产品事实草稿已保存，修改内容仍保持未确认状态。",
  );
}

async function customPackageRequest(
  planId: string,
  path: string,
  init: RequestInit,
  successMessage: string,
): Promise<CustomProductPackageActionState> {
  const apiBase = process.env.API_BASE_URL;
  if (!apiBase) return failure("API_BASE_URL 未配置，操作无法完成。");
  try {
    const response = await apiFetch(`${apiBase.replace(/\/$/, "")}${path}`, {
      ...init,
      cache: "no-store",
    });
    const payload = (await response.json().catch(() => undefined)) as
      { detail?: unknown; message?: unknown; title?: unknown } | undefined;
    if (!response.ok) {
      return failure(messageFrom(payload) ?? `操作失败 (${response.status})`);
    }
    revalidatePath("/products");
    revalidatePath(`/products?plan=${planId}`);
    return { message: successMessage, status: "success" };
  } catch (error) {
    return failure(error instanceof Error ? error.message : "Amazon Custom 产品包操作失败。");
  }
}

function textFact(
  current: SourcedTextFact | undefined,
  nextValue: string,
  confirmed: boolean,
): SourcedTextFact | undefined {
  if (!nextValue) return undefined;
  return {
    value: nextValue,
    ...provenance(current, confirmed, current?.value !== nextValue),
  };
}

function textFacts(
  current: SourcedTextFact[],
  nextValues: string[],
  confirmed: boolean,
): SourcedTextFact[] {
  return nextValues.map((nextValue, index) => {
    const previous =
      current.find((fact) => fact.value.toLocaleLowerCase() === nextValue.toLocaleLowerCase()) ??
      current[index];
    return {
      value: nextValue,
      ...provenance(previous, confirmed, previous?.value !== nextValue),
    };
  });
}

function provenance(
  current:
    | {
        source: CustomProductProfileV1["materials"][number]["source"];
        verificationStatus: CustomProductProfileV1["materials"][number]["verificationStatus"];
        sourceUrl?: string;
        evidencePath?: string;
        notes?: string;
      }
    | undefined,
  confirmed: boolean,
  changed: boolean,
) {
  if (confirmed) {
    return {
      source: "seller_provided" as const,
      verificationStatus: "confirmed" as const,
      notes: "Confirmed by the seller in YummyAI.",
    };
  }
  if (current && !changed) return current;
  return {
    source: "seller_provided" as const,
    verificationStatus: "unverified" as const,
    notes: "Edited by the seller but not yet confirmed.",
  };
}

function surfaceChanged(
  current: AmazonCustomSurface | undefined,
  label: string,
  process: string,
  width: number | undefined,
  height: number | undefined,
) {
  return (
    current?.label !== label ||
    (current?.process ?? "") !== process ||
    current?.areaMm?.width !== width ||
    current?.areaMm?.height !== height
  );
}

function parseAssetAssignments(input: string): CustomProductAssetAssignment[] {
  if (!input) return [];
  return input
    .split(/\r?\n/)
    .map((entry) => entry.trim())
    .filter(Boolean)
    .map((entry) => {
      const [assetId, role, extra] = entry.split(",").map((part) => part.trim());
      if (!assetId || !role || extra) {
        throw new Error("素材关联请每行填写“素材 UUID,角色”。");
      }
      return CustomProductAssetAssignmentSchema.parse({ assetId, role });
    });
}

function parseJsonStringArray(input: string): string[] {
  try {
    const parsed = JSON.parse(input) as unknown;
    return Array.isArray(parsed) && parsed.every((item) => typeof item === "string") ? parsed : [];
  } catch {
    return [];
  }
}

function lines(input: string): string[] {
  return input
    .split(/\r?\n/)
    .map((entry) => entry.trim())
    .filter(Boolean);
}

function value(formData: FormData, name: string): string {
  const entry = formData.get(name);
  return typeof entry === "string" ? entry.trim() : "";
}

function numberValue(formData: FormData, name: string): number | undefined {
  const input = value(formData, name);
  if (!input) return undefined;
  const parsed = Number(input);
  return Number.isFinite(parsed) ? parsed : undefined;
}

function messageFrom(
  payload: { detail?: unknown; message?: unknown; title?: unknown } | undefined,
) {
  for (const key of ["detail", "message", "title"] as const) {
    const candidate = payload?.[key];
    if (typeof candidate === "string") return candidate;
  }
  return undefined;
}

function failure(message: string): CustomProductPackageActionState {
  return { message, status: "error" };
}

const UUID_V7_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
