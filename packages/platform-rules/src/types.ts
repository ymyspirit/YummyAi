export type ListingPlatform = "amazon" | "etsy";

export interface ListingVariant {
  skuId: string;
  skuCode: string;
  optionValues: Record<string, string>;
}

export interface AmazonListingPublication {
  platform: "amazon";
  productType: string;
  attributes: Record<string, unknown>;
}

export interface EtsyListingPublication {
  platform: "etsy";
  price: { amount: number; currency: string };
  quantity: number;
  whoMade: "i_did" | "collective" | "someone_else";
  whenMade: string;
  taxonomyId: number;
  shippingProfileId: number;
  readinessStateId: number;
  shopSectionId?: number;
  isSupply?: boolean;
  inventory?: {
    products: Array<{
      sku: string;
      propertyValues: Array<{
        propertyId: number;
        propertyName: string;
        scaleId?: number;
        valueIds: number[];
        values: string[];
      }>;
      offerings: Array<{
        price: { amount: number; currency: string };
        quantity: number;
        isEnabled: boolean;
        readinessStateId?: number;
      }>;
    }>;
    priceOnProperty: number[];
    quantityOnProperty: number[];
    skuOnProperty: number[];
    readinessStateOnProperty: number[];
  };
}

export type ListingPublication = AmazonListingPublication | EtsyListingPublication;

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
  publication?: ListingPublication;
  aPlusModules?: Array<{ type: string; assetIds: string[]; headline?: string }>;
  personalization?: { enabled: boolean; instructions?: string; required?: boolean; maxAllowedCharacters?: number };
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
