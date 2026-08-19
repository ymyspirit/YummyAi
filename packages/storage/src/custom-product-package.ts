import { createHash } from "node:crypto";

import {
  CustomProductPackageAssetSchema,
  CustomProductPackageBrandStyleSchema,
  CustomProductPackageClaimsSchema,
  CustomProductPackageCompletenessSchema,
  CustomProductPackageCompetitorSchema,
  CustomProductPackageCustomizationSchema,
  CustomProductPackageManifestV1Schema,
  CustomProductPackageProductSchema,
  CustomProductPackageReviewInsightsSchema,
  CustomProductPackageV1Schema,
  type CustomProductPackageAsset,
  type CustomProductPackageBrandStyle,
  type CustomProductPackageClaims,
  type CustomProductPackageCompleteness,
  type CustomProductPackageCompetitor,
  type CustomProductPackageCustomization,
  type CustomProductPackageExportMode,
  type CustomProductPackageFile,
  type CustomProductPackageManifestV1,
  type CustomProductPackageProduct,
  type CustomProductPackageReviewInsights,
  type CustomProductPackageV1,
} from "@yummyai/contracts/catalog/custom-product-package";
import JSZip from "jszip";

const MAX_ARCHIVE_BYTES = 25_000_000;
const MAX_EXPANDED_BYTES = 100_000_000;
const MAX_FILES = 500;
const REQUIRED_JSON_PATHS = [
  "product.json",
  "customization.json",
  "research/competitors.json",
  "research/review-insights.json",
  "brand/style.json",
  "compliance/claims.json",
  "compliance/completeness-report.json",
  "assets/asset-inventory.json",
] as const;
const FORBIDDEN_KEY_PATTERN =
  /(api.?key|access.?token|refresh.?token|authorization|cookie|client.?secret|credential|password)/i;

export interface CustomProductPackageAssetFile {
  path: string;
  mediaType: string;
  bytes: Uint8Array;
}

export interface BuildCustomProductPackageInput {
  mode: CustomProductPackageExportMode;
  planId: string;
  tenantId: string;
  targetMarketplace: string;
  policyVersion: string;
  createdBy: string;
  createdAt: string;
  product: CustomProductPackageProduct;
  customization: CustomProductPackageCustomization;
  competitors: CustomProductPackageCompetitor[];
  reviewInsights: CustomProductPackageReviewInsights;
  brandStyle: CustomProductPackageBrandStyle;
  claims: CustomProductPackageClaims;
  completeness: CustomProductPackageCompleteness;
  assets: CustomProductPackageAsset[];
  assetFiles?: CustomProductPackageAssetFile[];
}

export interface BuiltCustomProductPackage {
  bytes: Uint8Array;
  sha256: string;
  manifest: CustomProductPackageManifestV1;
}

export async function buildCustomProductPackage(
  input: BuildCustomProductPackageInput,
): Promise<BuiltCustomProductPackage> {
  const fixedDate = new Date(input.createdAt);
  if (Number.isNaN(fixedDate.getTime())) throw new Error("createdAt must be a valid ISO timestamp");

  const documents = [
    jsonDocument("product.json", "product", CustomProductPackageProductSchema.parse(input.product)),
    jsonDocument(
      "customization.json",
      "customization",
      CustomProductPackageCustomizationSchema.parse(input.customization),
    ),
    jsonDocument(
      "research/competitors.json",
      "competitors",
      CustomProductPackageCompetitorSchema.array().parse(input.competitors),
    ),
    jsonDocument(
      "research/review-insights.json",
      "review_insights",
      CustomProductPackageReviewInsightsSchema.parse(input.reviewInsights),
    ),
    jsonDocument(
      "brand/style.json",
      "brand_style",
      CustomProductPackageBrandStyleSchema.parse(input.brandStyle),
    ),
    jsonDocument(
      "compliance/claims.json",
      "claims",
      CustomProductPackageClaimsSchema.parse(input.claims),
    ),
    jsonDocument(
      "compliance/completeness-report.json",
      "completeness",
      CustomProductPackageCompletenessSchema.parse(input.completeness),
    ),
    jsonDocument(
      "assets/asset-inventory.json",
      "asset_inventory",
      CustomProductPackageAssetSchema.array().parse(input.assets),
    ),
  ] satisfies PackageDocument[];
  assertNoSecrets(documents.map((document) => document.value));

  const assetDocuments = (input.assetFiles ?? []).map((asset) => {
    assertSafePackagePath(asset.path);
    if (!asset.path.startsWith("assets/"))
      throw new Error(`Asset path must remain under assets/: ${asset.path}`);
    assertAllowedAssetPath(asset.path);
    return {
      path: asset.path,
      role: "asset" as const,
      mediaType: asset.mediaType,
      bytes: asset.bytes,
    };
  });

  const files: CustomProductPackageFile[] = [...documents, ...assetDocuments].map((document) => ({
    path: document.path,
    role: document.role,
    mediaType: document.mediaType,
    byteSize: document.bytes.byteLength,
    sha256: checksum(document.bytes),
  }));
  const manifest = CustomProductPackageManifestV1Schema.parse({
    packageKind: "amazon-custom-product",
    packageVersion: "1.0",
    mode: input.mode,
    planId: input.planId,
    tenantId: input.tenantId,
    targetMarketplace: input.targetMarketplace,
    files,
    completeness: input.completeness,
    policyVersion: input.policyVersion,
    createdBy: input.createdBy,
    createdAt: input.createdAt,
  });

  const zip = new JSZip();
  for (const document of [...documents, ...assetDocuments]) {
    zip.file(document.path, document.bytes, {
      binary: true,
      createFolders: false,
      date: fixedDate,
    });
  }
  zip.file("manifest.json", encodeJson(manifest), {
    binary: true,
    createFolders: false,
    date: fixedDate,
  });
  const bytes = await zip.generateAsync({
    type: "uint8array",
    compression: "DEFLATE",
    compressionOptions: { level: 9 },
    platform: "UNIX",
  });
  if (bytes.byteLength > MAX_ARCHIVE_BYTES)
    throw new Error("Custom product package exceeds the 25 MB archive limit");
  return { bytes, sha256: checksum(bytes), manifest };
}

export async function inspectCustomProductPackage(
  rawBytes: Uint8Array,
): Promise<CustomProductPackageV1> {
  if (rawBytes.byteLength > MAX_ARCHIVE_BYTES)
    throw new Error("Custom product package exceeds the 25 MB archive limit");
  const zip = await JSZip.loadAsync(rawBytes, { checkCRC32: true, createFolders: true });
  const entries = Object.values(zip.files).filter((entry) => !entry.dir);
  if (entries.length > MAX_FILES) throw new Error("Custom product package contains too many files");
  for (const entry of entries) {
    const unsafeOriginalName = (entry as typeof entry & { unsafeOriginalName?: string })
      .unsafeOriginalName;
    if (unsafeOriginalName && unsafeOriginalName !== entry.name) {
      throw new Error(`Unsafe package path: ${unsafeOriginalName}`);
    }
    assertSafePackagePath(entry.name);
    if (entry.name !== "manifest.json" && !entry.name.endsWith(".json"))
      assertAllowedAssetPath(entry.name);
  }

  const manifest = CustomProductPackageManifestV1Schema.parse(await readJson(zip, "manifest.json"));
  const actualPaths = new Set(entries.map((entry) => entry.name));
  for (const requiredPath of REQUIRED_JSON_PATHS) {
    if (!actualPaths.has(requiredPath))
      throw new Error(`Custom product package is missing ${requiredPath}`);
  }
  if (manifest.files.length !== entries.length - 1)
    throw new Error("Manifest file count does not match the archive");

  let expandedBytes = 0;
  for (const file of manifest.files) {
    assertSafePackagePath(file.path);
    const entry = zip.file(file.path);
    if (!entry) throw new Error(`Manifest references a missing file: ${file.path}`);
    const bytes = await entry.async("uint8array");
    expandedBytes += bytes.byteLength;
    if (expandedBytes > MAX_EXPANDED_BYTES)
      throw new Error("Custom product package exceeds the 100 MB expanded limit");
    if (bytes.byteLength !== file.byteSize || checksum(bytes) !== file.sha256) {
      throw new Error(`File integrity check failed: ${file.path}`);
    }
  }

  const product = CustomProductPackageProductSchema.parse(await readJson(zip, "product.json"));
  const customization = CustomProductPackageCustomizationSchema.parse(
    await readJson(zip, "customization.json"),
  );
  const competitors = CustomProductPackageCompetitorSchema.array().parse(
    await readJson(zip, "research/competitors.json"),
  );
  const reviewInsights = CustomProductPackageReviewInsightsSchema.parse(
    await readJson(zip, "research/review-insights.json"),
  );
  const brandStyle = CustomProductPackageBrandStyleSchema.parse(
    await readJson(zip, "brand/style.json"),
  );
  const claims = CustomProductPackageClaimsSchema.parse(
    await readJson(zip, "compliance/claims.json"),
  );
  const completeness = CustomProductPackageCompletenessSchema.parse(
    await readJson(zip, "compliance/completeness-report.json"),
  );
  const assets = CustomProductPackageAssetSchema.array().parse(
    await readJson(zip, "assets/asset-inventory.json"),
  );
  assertNoSecrets([
    manifest,
    product,
    customization,
    competitors,
    reviewInsights,
    brandStyle,
    claims,
    completeness,
    assets,
  ]);
  return CustomProductPackageV1Schema.parse({
    manifest,
    product,
    customization,
    competitors,
    reviewInsights,
    brandStyle,
    claims,
    completeness,
    assets,
  });
}

interface PackageDocument {
  path: string;
  role: CustomProductPackageFile["role"];
  mediaType: string;
  value: unknown;
  bytes: Uint8Array;
}

function jsonDocument(
  path: string,
  role: CustomProductPackageFile["role"],
  value: unknown,
): PackageDocument {
  assertSafePackagePath(path);
  return { path, role, mediaType: "application/json", value, bytes: encodeJson(value) };
}

function encodeJson(value: unknown): Uint8Array {
  return new TextEncoder().encode(`${JSON.stringify(value, null, 2)}\n`);
}

async function readJson(zip: JSZip, path: string): Promise<unknown> {
  const entry = zip.file(path);
  if (!entry) throw new Error(`Custom product package is missing ${path}`);
  return JSON.parse(await entry.async("string")) as unknown;
}

function assertSafePackagePath(path: string) {
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

function assertAllowedAssetPath(path: string) {
  if (!/\.(?:json|png|jpe?g|webp|pdf|svg|ai|psd)$/i.test(path)) {
    throw new Error(`Unsupported package file type: ${path}`);
  }
}

function assertNoSecrets(values: unknown[]) {
  const visit = (value: unknown, path: string) => {
    if (Array.isArray(value)) {
      value.forEach((entry, index) => visit(entry, `${path}[${index}]`));
      return;
    }
    if (!value || typeof value !== "object") return;
    for (const [key, child] of Object.entries(value)) {
      if (FORBIDDEN_KEY_PATTERN.test(key))
        throw new Error(`Credential-like field is not allowed in product packages: ${path}.${key}`);
      visit(child, `${path}.${key}`);
    }
  };
  values.forEach((value, index) => visit(value, `$[${index}]`));
}

function checksum(bytes: Uint8Array): string {
  return createHash("sha256").update(bytes).digest("hex");
}
