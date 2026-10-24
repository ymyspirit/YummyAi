import { describe, expect, it } from "vitest";
import { createEntityId } from "../common/ids.js";
import { FactoryProfileSchema, FactoryCapabilityProfileSchema, CreateFactorySchema, ReviseFactorySchema } from "./factory-directory.js";
import { SupplierProfileSchema } from "./supplier-profile.js";
import { CreateFulfillmentSupplierInputSchema } from "../order/routing.js";
import { syntheticFactoryProfile, syntheticFactoryCapability } from "../../../../tools/testing/factory-fixtures.js";

describe("supplier and factory business boundaries", () => {
  it("keeps legacy supplier ownership and business roles unconfirmed", () => {
    expect(SupplierProfileSchema.parse({})).toMatchObject({ entityKind: "unconfirmed", roles: [], officeAddress: null, contacts: [] });
    expect(SupplierProfileSchema.safeParse({ tenantId: createEntityId() }).success).toBe(false);
  });
  it("requires actual production address and reachable production contact before activation", () => {
    const profile = syntheticFactoryProfile();
    expect(FactoryProfileSchema.safeParse({ ...profile, productionAddress: null }).success).toBe(false);
    expect(FactoryProfileSchema.safeParse({ ...profile, contacts: [{ ...profile.contacts[0], role: "business" }] }).success).toBe(false);
    expect(FactoryProfileSchema.safeParse({ ...profile, contacts: [{ ...profile.contacts[0], phone: "" }] }).success).toBe(false);
    expect(FactoryProfileSchema.safeParse({ ...profile, contacts: [{ ...profile.contacts[0], name: "" }] }).success).toBe(false);
    for (const field of ["countryCode", "city", "street"]) expect(FactoryProfileSchema.safeParse({ ...profile, productionAddress: { ...profile.productionAddress, [field]: "" } }).success).toBe(false);
    expect(FactoryProfileSchema.safeParse({ ...profile, status: "draft", productionAddress: null, contacts: [] }).success).toBe(true);
  });
  it("saves unnamed address parts and partial contacts without inventing missing information", () => {
    const supplier = CreateFulfillmentSupplierInputSchema.parse({ name: "Synthetic partial supplier", kind: "manual", settlementCurrency: "CNY", profile: { officeAddress: { province: "Synthetic province" }, contacts: [{ role: "business", name: "Synthetic contact" }, { role: "quality", phone: "synthetic-contact-only" }] } });
    expect(supplier.regionCode).toBe("");
    expect(supplier.profile.officeAddress).toMatchObject({ province: "Synthetic province", countryCode: "", city: "", street: "" });
    expect(supplier.profile.contacts).toMatchObject([{ name: "Synthetic contact", phone: "" }, { name: "", phone: "synthetic-contact-only" }]);
    expect(SupplierProfileSchema.parse({ officeAddress: { countryCode: "US" } }).officeAddress).toMatchObject({ countryCode: "US", city: "", street: "" });
    expect(SupplierProfileSchema.safeParse({ officeAddress: { countryCode: "USA" } }).success).toBe(false);
    expect(SupplierProfileSchema.safeParse({ contacts: [{ role: "business", email: "invalid-email" }] }).success).toBe(false);
    expect(CreateFulfillmentSupplierInputSchema.safeParse({ name: " ", kind: "manual", settlementCurrency: "CNY" }).success).toBe(false);
  });
  it("stores incomplete factory and process data in draft without allowing activation", () => {
    const profile = { ...syntheticFactoryProfile(), status: "draft", productionAddress: { province: "Synthetic province" }, contacts: [{ role: "production", name: "Synthetic contact" }] };
    expect(FactoryProfileSchema.parse(profile).productionAddress).toMatchObject({ countryCode: "", city: "", street: "", province: "Synthetic province" });
    expect(FactoryProfileSchema.safeParse({ ...profile, status: "active" }).success).toBe(false);
    const capability = { ...syntheticFactoryCapability("engraving"), status: "draft", processCodes: [], verificationStatus: "pending", verificationReference: "" };
    expect(FactoryCapabilityProfileSchema.safeParse(capability).success).toBe(true);
    expect(FactoryCapabilityProfileSchema.safeParse({ ...capability, status: "active", verificationStatus: "confirmed", verificationReference: "Synthetic verified test only" }).success).toBe(false);
  });
  it("keeps unknown timezone and MOQ null in drafts and never substitutes local defaults", () => {
    const factory = { ...syntheticFactoryProfile(), status: "draft", timeZone: null };
    expect(FactoryProfileSchema.parse(factory).timeZone).toBeNull();
    expect(FactoryProfileSchema.safeParse({ ...factory, status: "active" }).success).toBe(false);
    expect(FactoryProfileSchema.safeParse({ ...factory, timeZone: "invalid/timezone" }).success).toBe(false);
    const capability = { ...syntheticFactoryCapability(), status: "draft", minimumOrderQuantity: null };
    expect(FactoryCapabilityProfileSchema.parse(capability).minimumOrderQuantity).toBeNull();
    expect(FactoryCapabilityProfileSchema.safeParse({ ...capability, status: "active" }).success).toBe(false);
    expect(FactoryCapabilityProfileSchema.parse({ ...capability, status: "active", minimumOrderQuantity: 1 }).minimumOrderQuantity).toBe(1);
  });
  it("requires verified complete manufacturing capability and blocks failed samples", () => {
    const profile = syntheticFactoryCapability("shaped_pillow");
    for (const patch of [{ verificationStatus: "pending" }, { verificationReference: "" }, { sampleStatus: "failed" }, { processCodes: ["PRINT", "CUT"] }, { sideModes: [] }, { factoryStandardId: "" }]) {
      expect(FactoryCapabilityProfileSchema.safeParse({ ...profile, ...patch }).success).toBe(false);
    }
    expect(FactoryCapabilityProfileSchema.safeParse({ ...profile, fulfillmentScope: "process_only", processCodes: ["CUT"], factoryStandardId: "", sideModes: [] }).success).toBe(true);
  });
  it("preserves unknown quote and capacity and rejects invalid sizes, dates, tenant injection and supplier reassignment", () => {
    const capability = syntheticFactoryCapability();
    expect(capability).toMatchObject({ unitCostMinor: null, dailyCapacity: null });
    for (const patch of [{ minimumLongestMm: 400, maximumLongestMm: 200 }, { validUntil: capability.validFrom }, { skuId: createEntityId(), productPlanId: null }, { unitCostMinor: 0.2 }, { tenantId: createEntityId() }]) expect(FactoryCapabilityProfileSchema.safeParse({ ...capability, ...patch }).success).toBe(false);
    const profile = syntheticFactoryProfile(), idempotencyKey = crypto.randomUUID();
    expect(CreateFactorySchema.safeParse({ profile, code: "SITE-1", supplierId: createEntityId(), idempotencyKey }).success).toBe(true);
    expect(ReviseFactorySchema.safeParse({ profile, expectedVersion: 1, idempotencyKey, supplierId: createEntityId() }).success).toBe(false);
  });
});
