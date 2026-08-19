export interface BatchCapabilities {
  batchDesign: { enabled: boolean; blockers: string[] };
  mockupBatches: { enabled: boolean; blockers: string[] };
}

export interface PrintSpecOption {
  id: string; name: string; versionNumber: number; aspectWidth: number; aspectHeight: number; status: string;
  targetDpi?: number; bleedMm?: string; safeZoneMm?: string; wrapMode?: string; rejectionReason?: string;
}

export interface DesignOptions {
  printSpecs: PrintSpecOption[];
  printSpecVersions: PrintSpecOption[];
  referenceAssets: Array<{ id: string; fileName: string; mediaType: string; version: number; checksumSha256: string }>;
  skus: Array<{ id: string; code: string; attributes: Record<string, string>; status: string }>;
}

export interface CreativeAsset {
  id: string; assetId: string; role: "master" | "aspect_variant"; printSpecVersionId?: string;
  adaptationMode: "original" | "crop" | "ai_outpaint"; generatedRegions: unknown[];
}

export interface CreativeVersion {
  id: string; name: string; status: string; rejectionReason?: string; assets: CreativeAsset[];
}

export interface CreativeCandidate {
  id: string; ordinal: number; status: string; assetId?: string; modelKey?: string; modelVersion?: string;
  seed?: string; costUsd?: string; errorMessage?: string;
}

export interface CreativeBatch {
  id: string; name: string; status: string; itemCount: number; generatedCount: number; approvedCount: number; failedCount: number;
  createdAt: string;
  items?: Array<{
    id: string; rowKey: string; name: string; prompt: string; candidateCount: number; printSpecVersionIds: string[];
    status: string; errorMessage?: string; candidates: CreativeCandidate[]; creativeVersions: CreativeVersion[];
  }>;
}

export interface MockupOptions {
  templatePacks: Array<{ id: string; name: string; platform: "amazon" | "etsy"; locale: string; versionNumber: number; status: string; slots: Array<{ id: string; slotKey: string; label: string; required: boolean; ordinal: number; acceptedPrintSpecVersionIds: string[] }> }>;
  formalDesigns: Array<{ designVersionId: string; designTaskId: string; title: string; skuId: string; skuCode: string; spuId: string; printSpecVersionId: string; creativeDesignVersionId: string }>;
  listingVersions: Array<{ listingVersionId: string; versionNumber: number; status: string; listingId: string; platform: string; locale: string; spuId: string }>;
  templateSourceAssets: Array<{ id: string; fileName: string; mediaType: string; version: number; checksumSha256: string; byteSize: number }>;
  inspections: Array<{ id: string; sourceAssetId: string; sourceAssetVersion: number; checksumSha256: string; slotKey: string; status: string; compilation?: { ssimPermille: number }; confirmedAt?: string }>;
  printSpecs: PrintSpecOption[];
}

export interface MockupBatch {
  id: string; name: string; status: string; platform: string; locale: string; templatePackVersionId: string;
  itemCount: number; completedCount: number; failedCount: number; createdAt: string;
  items?: Array<{ id: string; designVersionId: string; skuId: string; status: string; rejectionReason?: string; outputs: Array<{
    id: string; slotKey: string; attempt: number; status: string; assetId?: string; errorMessage?: string;
  }> }>;
}
