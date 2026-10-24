import type { SupplierProfile } from "../../packages/contracts/src/suppliers/supplier-profile.js";
import type { FactoryProfile, FactoryCapabilityProfile } from "../../packages/contracts/src/suppliers/factory-directory.js";

// Synthetic evidence is confined to the disposable acceptance environment.
export const syntheticSupplierProfile: SupplierProfile = { schemaVersion: 1, entityKind: "external_supplier", roles: ["manufacturing"], legalName: "", alias: "", officeAddress: null, contacts: [], paymentTerms: "", invoiceInformation: "", notes: "" };
export function syntheticFactoryProfile(name = "Synthetic pillow site"): FactoryProfile {
  return { name, ownership: "partner", cooperationMode: "direct", status: "active",
    productionAddress: { countryCode: "CN", province: "Synthetic province", city: "Synthetic city", district: "", street: "Synthetic factory address; not a real business", postalCode: "", recipient: "", phone: "" },
    pickupAddress: null, returnAddress: null, contacts: [{ name: "Synthetic operator", role: "production", phone: "synthetic-only", wechat: "", email: "" }],
    timeZone: "Asia/Shanghai", workingHours: "Synthetic test hours", cutoffTime: "", fulfillmentModes: ["dropship"], notes: "Disposable test fixture" };
}
export function syntheticFactoryCapability(productType: FactoryCapabilityProfile["productType"] = "other"): FactoryCapabilityProfile {
  return { name: `Synthetic ${productType} capability`, productType, productPlanId: null, skuId: null,
    fulfillmentScope: "full_product", processCodes: ["PRINT", "CUT", "SEW", "FILL", "PACK"], materials: [], specifications: "Synthetic fixture",
    minimumLongestMm: 1, maximumLongestMm: 5000, sideModes: ["single", "double"], factoryStandardId: productType === "shaped_pillow" ? "ps-pillow-2026-09-17" : "", acceptedTemplateVersionIds: [],
    status: "active", verificationStatus: "confirmed", verificationReference: "Synthetic test evidence; no actual factory approval", sampleStatus: "passed",
    unitCostMinor: null, currency: "CNY", minimumOrderQuantity: 1, leadTimeDays: null, dailyCapacity: null, validFrom: "2020-01-01T00:00:00.000Z", validUntil: null,
    afterSalesTerms: "Synthetic", evidenceReferences: [], notes: "Disposable test fixture" };
}
