export type ListingPlatform = "amazon" | "etsy";

export interface ListingVariant {
  skuId: string;
  skuCode: string;
  optionValues: Record<string, string>;
}

export interface ListingDraft {
  platform: ListingPlatform;
  locale: string;
  title: string;
  description: string;
  bullets: string[];
  tags: string[];
  mainImageId?: string;
  mediaAssetIds: string[];
  variants: ListingVariant[];
  attributes: Record<string, string | number | boolean>;
  compliance: Record<string, string | boolean>;
  aPlusModules?: Array<{ type: string; assetIds: string[]; headline?: string }>;
  personalization?: { enabled: boolean; instructions?: string; required?: boolean };
}

export interface ValidationIssue {
  severity: "blocker" | "warning";
  code: string;
  path: string;
  message: string;
  ruleVersion: string;
}

export interface ListingValidation {
  completeness: number;
  blockers: ValidationIssue[];
  warnings: ValidationIssue[];
}

export interface PlatformRules {
  platform: ListingPlatform;
  version: string;
  effectiveAt: string;
  requiredPaths: string[];
  limits: {
    title: number;
    description: number;
    bullets?: number;
    bulletLength?: number;
    tags?: number;
    tagLength?: number;
    media?: number;
  };
  validate: (draft: ListingDraft) => Array<Omit<ValidationIssue, "ruleVersion">>;
}
