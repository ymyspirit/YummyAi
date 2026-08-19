import { createHash } from "node:crypto";

import {
  AmazonCustomListingCopySchema,
  AmazonCustomListingMaterialsManifestV1Schema,
  AmazonCustomListingMaterialsReadinessSchema,
  AmazonCustomListingMaterialsV1Schema,
  AmazonCustomVariantSchema,
  CustomProductPackageClaimsSchema,
  CustomProductPackageCustomizationSchema,
  type AmazonCustomListingCopy,
  type AmazonCustomListingMaterialsManifestV1,
  type AmazonCustomListingMaterialsReadiness,
  type AmazonCustomMediaInventoryItem,
  type AmazonCustomVariant,
  type CustomProductPackageClaims,
  type CustomProductPackageCustomization,
} from "@yummyai/contracts";
import JSZip from "jszip";

const MAX_ARCHIVE_BYTES = 250_000_000;
const FORBIDDEN_KEY_PATTERN =
  /(api.?key|access.?token|refresh.?token|authorization|cookie|client.?secret|credential|password)/i;

export interface AmazonCustomListingMaterialFile {
  assetId: string;
  path: string;
  role: AmazonCustomMediaInventoryItem["role"];
  sourceFileName: string;
  mediaType: string;
  bytes: Uint8Array;
  sha256: string;
}

export interface BuildAmazonCustomListingMaterialsPackageInput {
  planId: string;
  listingId: string;
  listingVersionId: string;
  tenantId: string;
  targetMarketplace: string;
  policyVersion: string;
  createdBy: string;
  createdAt: string;
  listingCopy: AmazonCustomListingCopy;
  variants: AmazonCustomVariant[];
  customization: CustomProductPackageCustomization;
  claims: CustomProductPackageClaims;
  readiness: AmazonCustomListingMaterialsReadiness;
  files: AmazonCustomListingMaterialFile[];
}

export interface BuiltAmazonCustomListingMaterialsPackage {
  bytes: Uint8Array;
  sha256: string;
  manifest: AmazonCustomListingMaterialsManifestV1;
}

export async function buildAmazonCustomListingMaterialsPackage(
  input: BuildAmazonCustomListingMaterialsPackageInput,
): Promise<BuiltAmazonCustomListingMaterialsPackage> {
  const createdAt = new Date(input.createdAt);
  if (Number.isNaN(createdAt.getTime())) throw new Error("createdAt must be a valid ISO timestamp");
  const listingCopy = AmazonCustomListingCopySchema.parse(input.listingCopy);
  const variants = AmazonCustomVariantSchema.array().min(1).parse(input.variants);
  const customization = CustomProductPackageCustomizationSchema.parse(input.customization);
  const claims = CustomProductPackageClaimsSchema.parse(input.claims);
  const readiness = AmazonCustomListingMaterialsReadinessSchema.parse(input.readiness);
  if (readiness.status !== "ready") {
    throw new Error("Listing materials package cannot be built until readiness is ready");
  }
  assertNoSecrets([listingCopy, variants, customization, claims, readiness]);

  const media = input.files.map((file): AmazonCustomMediaInventoryItem => {
    assertSafePath(file.path);
    if (checksum(file.bytes) !== file.sha256) {
      throw new Error(`Material file checksum mismatch: ${file.path}`);
    }
    return {
      assetId: file.assetId,
      packagePath: file.path,
      role: file.role,
      sourceFileName: file.sourceFileName,
      mediaType: file.mediaType,
      byteSize: file.bytes.byteLength,
      sha256: file.sha256,
    };
  });
  const manifest = AmazonCustomListingMaterialsManifestV1Schema.parse({
    packageKind: "amazon-custom-listing-materials",
    packageVersion: "1.0",
    planId: input.planId,
    listingId: input.listingId,
    listingVersionId: input.listingVersionId,
    tenantId: input.tenantId,
    skuCodes: variants.map((variant) => variant.skuCode),
    targetMarketplace: input.targetMarketplace,
    policyVersion: input.policyVersion,
    createdBy: input.createdBy,
    createdAt: input.createdAt,
    readiness,
    media,
  });
  AmazonCustomListingMaterialsV1Schema.parse({
    manifest,
    listingCopy,
    variants,
    customization,
    claims,
    readiness,
    media,
  });

  const sku = safeName(variants[0]!.skuCode);
  const documents = new Map<string, Uint8Array>([
    ["00-先看这里-README.txt", encodeText(readme(input.targetMarketplace, sku))],
    ["listing/listing-copy.json", encodeJson(listingCopy)],
    ["listing/listing-copy.txt", encodeText(listingCopyText(listingCopy))],
    ["listing/category-attributes.json", encodeJson(listingCopy.attributes)],
    ["listing/offer-and-fulfillment.json", encodeJson(listingCopy.offerAndFulfillment)],
    ["listing/variants.csv", encodeText(variantCsv(variants))],
    ["customizer/customizer-config.json", encodeJson(customization)],
    ["customizer/customizer-config.csv", encodeText(customizerCsv(customization))],
    ["compliance/claims.json", encodeJson(claims)],
    ["compliance/readiness-report.json", encodeJson(readiness)],
    ["compliance/readiness-report.html", encodeText(readinessHtml(readiness))],
    ["upload/upload-checklist.csv", encodeText(uploadChecklist(input.files))],
    ["assets/media-inventory.json", encodeJson(media)],
    ["manifest.json", encodeJson(manifest)],
  ]);
  const zip = new JSZip();
  for (const [path, bytes] of documents) {
    assertSafePath(path);
    zip.file(path, bytes, { binary: true, createFolders: false, date: createdAt });
  }
  for (const file of input.files) {
    zip.file(file.path, file.bytes, { binary: true, createFolders: false, date: createdAt });
  }
  const bytes = await zip.generateAsync({
    type: "uint8array",
    compression: "DEFLATE",
    compressionOptions: { level: 9 },
    platform: "UNIX",
  });
  if (bytes.byteLength > MAX_ARCHIVE_BYTES) {
    throw new Error("Amazon Custom listing materials package exceeds the 250 MB archive limit");
  }
  return { bytes, sha256: checksum(bytes), manifest };
}

function readme(marketplace: string, sku: string) {
  return [
    "Amazon Custom 上架资料包 V1",
    "",
    `目标站点：${marketplace}`,
    `主 SKU：${sku}`,
    "",
    "建议上传顺序：",
    "1. 按 listing/listing-copy.txt 录入标题、五点和描述。",
    "2. 按 listing/category-attributes.json 录入类目属性与合规字段。",
    "3. 按 listing/offer-and-fulfillment.json 录入价格、库存、商品状况和卖家配送模板。",
    "4. 按 listing/variants.csv 建立 SKU 与变体映射。",
    "5. 按 listing-images/ 文件名顺序上传 MAIN 与 PT01–PT08。",
    "6. 按 customizer/customizer-config.csv 配置定制面、字段和选项。",
    "7. 按 a-plus-images/ 与 Listing 文案配置 A+。",
    "8. 使用 production-files/ 核对定制区域和生产文件，不上传到公开商品页。",
    "9. 完成后逐项勾选 upload/upload-checklist.csv。",
    "",
    "注意：竞品原图、竞品文案和 reference_only 素材不会进入本资料包。",
  ].join("\r\n");
}

function listingCopyText(copy: AmazonCustomListingCopy) {
  return [
    "[TITLE]",
    copy.title,
    "",
    "[BULLET POINTS]",
    ...copy.bulletPoints.map((bullet, index) => `${index + 1}. ${bullet}`),
    "",
    "[DESCRIPTION]",
    copy.description,
    "",
    "[SEARCH TERMS]",
    copy.searchTerms.join(" "),
  ].join("\r\n");
}

function variantCsv(variants: AmazonCustomVariant[]) {
  const optionKeys = [...new Set(variants.flatMap((variant) => Object.keys(variant.optionValues)))];
  return csv([
    ["sku", ...optionKeys],
    ...variants.map((variant) => [
      variant.skuCode,
      ...optionKeys.map((key) => variant.optionValues[key] ?? ""),
    ]),
  ]);
}

function customizerCsv(customization: CustomProductPackageCustomization) {
  const surfaceByField = new Map<string, (typeof customization.surfaces)[number]>();
  customization.surfaces.forEach((surface) =>
    surface.fieldKeys.forEach((key) => surfaceByField.set(key, surface)),
  );
  return csv([
    [
      "surface_key",
      "surface_label",
      "area_width_mm",
      "area_height_mm",
      "process",
      "field_key",
      "field_label",
      "field_type",
      "required",
      "limit_or_options",
      "visible_when",
    ],
    ...customization.definition.fields.map((field) => {
      const surface = surfaceByField.get(field.key);
      const limit =
        "validation" in field && field.validation && "maxLength" in field.validation
          ? String(field.validation.maxLength ?? "")
          : "options" in field
            ? field.options.map((option) => `${option.value}:${option.label}`).join(" | ")
            : "palette" in field
              ? field.palette.join(" | ")
              : "";
      return [
        surface?.key ?? "",
        surface?.label ?? "",
        surface?.areaMm?.width ?? "",
        surface?.areaMm?.height ?? "",
        surface?.process ?? "",
        field.key,
        field.label,
        field.type,
        field.required ? "yes" : "no",
        limit,
        field.visibleWhen ? JSON.stringify(field.visibleWhen) : "",
      ];
    }),
  ]);
}

function uploadChecklist(files: AmazonCustomListingMaterialFile[]) {
  const rows: Array<Array<string | number>> = [
    ["order", "section", "item", "package_path", "required", "completed", "notes"],
    [1, "Listing", "标题、五点、描述、搜索词", "listing/listing-copy.txt", "yes", "", ""],
    [2, "Listing", "类目属性与合规字段", "listing/category-attributes.json", "yes", "", ""],
    [
      3,
      "Listing",
      "价格、库存、状况与卖家配送",
      "listing/offer-and-fulfillment.json",
      "yes",
      "",
      "",
    ],
    [4, "Listing", "SKU 与变体", "listing/variants.csv", "yes", "", ""],
    [5, "Amazon Custom", "定制面、字段与选项", "customizer/customizer-config.csv", "yes", "", ""],
  ];
  files.forEach((file, index) =>
    rows.push([
      index + 6,
      file.role === "a_plus" ? "A+" : file.role === "production" ? "Production" : "Listing image",
      file.role,
      file.path,
      "yes",
      "",
      "",
    ]),
  );
  rows.push([
    rows.length + 1,
    "QA",
    "桌面端、移动端和全部定制组合复核",
    "compliance/readiness-report.html",
    "yes",
    "",
    "",
  ]);
  return csv(rows);
}

function readinessHtml(readiness: AmazonCustomListingMaterialsReadiness) {
  const groupRows = readiness.groups
    .map(
      (group) =>
        `<tr><td>${escapeHtml(group.label)}</td><td>${group.status}</td><td>${group.completed}/${group.required}</td></tr>`,
    )
    .join("");
  const issueRows = readiness.issues.length
    ? readiness.issues
        .map(
          (issue) =>
            `<li><strong>${escapeHtml(issue.group)}</strong> · ${escapeHtml(issue.message)}</li>`,
        )
        .join("")
    : "<li>未发现阻断项。</li>";
  return `<!doctype html><html lang="zh-CN"><meta charset="utf-8"><title>Amazon Custom 资料齐套报告</title><style>body{max-width:920px;margin:40px auto;padding:0 24px;font:14px/1.6 Arial;color:#1f2d2d}h1{font-size:26px}table{width:100%;border-collapse:collapse}th,td{padding:10px;border:1px solid #ccd5d3;text-align:left}th{background:#eef2f1}.ready{color:#23704e}</style><body><h1>Amazon Custom 资料齐套报告</h1><p class="ready">状态：${readiness.status.toUpperCase()} · 得分 ${readiness.score}</p><table><thead><tr><th>资料组</th><th>状态</th><th>完成</th></tr></thead><tbody>${groupRows}</tbody></table><h2>校验结果</h2><ul>${issueRows}</ul><p>生成时间：${escapeHtml(readiness.evaluatedAt)}</p></body></html>`;
}

function csv(rows: Array<Array<string | number>>) {
  return `\uFEFF${rows.map((row) => row.map((cell) => csvCell(String(cell))).join(",")).join("\r\n")}\r\n`;
}

function csvCell(value: string) {
  return /[",\r\n]/.test(value) ? `"${value.replaceAll('"', '""')}"` : value;
}

function encodeJson(value: unknown) {
  return encodeText(`${JSON.stringify(value, null, 2)}\n`);
}

function encodeText(value: string) {
  return new TextEncoder().encode(value);
}

function checksum(bytes: Uint8Array) {
  return createHash("sha256").update(bytes).digest("hex");
}

function safeName(value: string) {
  return (
    value
      .normalize("NFKC")
      .replace(/[^a-zA-Z0-9._-]+/g, "-")
      .replace(/^-+|-+$/g, "")
      .slice(0, 160) || "SKU"
  );
}

function assertSafePath(path: string) {
  if (
    !path ||
    path.startsWith("/") ||
    path.startsWith("\\") ||
    path.includes("..") ||
    path.includes("\\") ||
    /^[a-z]:/i.test(path)
  ) {
    throw new Error(`Unsafe package path: ${path}`);
  }
  if (FORBIDDEN_KEY_PATTERN.test(path))
    throw new Error(`Credential-like file names are not allowed: ${path}`);
}

function assertNoSecrets(values: unknown[]) {
  const visit = (value: unknown, path: string) => {
    if (Array.isArray(value))
      return value.forEach((entry, index) => visit(entry, `${path}[${index}]`));
    if (!value || typeof value !== "object") return;
    for (const [key, child] of Object.entries(value)) {
      if (FORBIDDEN_KEY_PATTERN.test(key))
        throw new Error(`Credential-like field is not allowed in listing packages: ${path}.${key}`);
      visit(child, `${path}.${key}`);
    }
  };
  values.forEach((value, index) => visit(value, `$[${index}]`));
}

function escapeHtml(value: string) {
  return value.replace(
    /[&<>"']/g,
    (character) =>
      ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[character]!,
  );
}
