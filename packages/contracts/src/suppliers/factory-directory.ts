import { z } from "zod";
import { EntityIdSchema as Id } from "@yummyai/contracts/common/ids";
import { BusinessAddressSchema, BusinessContactSchema } from "@yummyai/contracts/suppliers/supplier-profile";
import { ErpContextAuthoritySchema } from "@yummyai/contracts/auth/session";

export const FactoryProfileSchema = z.object({
  name: z.string().trim().min(1).max(200), ownership: z.enum(["owned", "partner"]), cooperationMode: z.enum(["direct", "subcontract"]).default("direct"),
  status: z.enum(["draft", "active", "suspended", "archived"]), productionAddress: BusinessAddressSchema.nullable(), pickupAddress: BusinessAddressSchema.nullable(), returnAddress: BusinessAddressSchema.nullable(),
  contacts: z.array(BusinessContactSchema).max(12), timeZone: z.string().min(1).max(80).refine(value => { try { new Intl.DateTimeFormat("en", { timeZone: value }); return true; } catch { return false; } }).nullable(),
  workingHours: z.string().trim().max(300), cutoffTime: z.union([z.literal(""), z.string().regex(/^([01]\d|2[0-3]):[0-5]\d$/)]),
  fulfillmentModes: z.array(z.enum(["self_ship", "dropship", "bulk_to_warehouse"])).max(3), notes: z.string().trim().max(4000),
}).strict().superRefine((value, context) => {
  if (value.status !== "active") return;
  if (value.timeZone === null) context.addIssue({ code: "custom", path: ["timeZone"], message: "启用工厂须确认实际时区；未知时可留空保存草稿" });
  if (!value.productionAddress?.countryCode || !value.productionAddress.city || !value.productionAddress.street) context.addIssue({ code: "custom", path: ["productionAddress"], message: "启用工厂须补齐生产地址的国家、城市和详细地址；资料不完整时可保存为草稿" });
  if (!value.contacts.some(contact => contact.role === "production" && contact.name && (contact.phone || contact.wechat || contact.email))) context.addIssue({ code: "custom", path: ["contacts"], message: "启用工厂须填写生产联系人姓名及至少一种联系方式；资料不完整时可保存为草稿" });
});
export const FactoryCapabilityProfileSchema = z.object({
  name: z.string().trim().min(1).max(200), productType: z.enum(["shaped_pillow", "tire_cover", "rectangular_print", "engraving", "other"]), productPlanId: Id.nullable(), skuId: Id.nullable(), fulfillmentScope: z.enum(["full_product", "process_only"]),
  processCodes: z.array(z.enum(["PRINT", "CUT", "SEW", "FILL", "PACK", "ENGRAVE", "EMBROIDER", "OTHER"])).max(8),
  materials: z.array(z.string().trim().min(1).max(200)).max(30), specifications: z.string().trim().max(4000),
  minimumLongestMm: z.number().positive().max(5000).nullable(), maximumLongestMm: z.number().positive().max(5000).nullable(), sideModes: z.array(z.enum(["single", "double"])).max(2),
  factoryStandardId: z.string().trim().max(160), acceptedTemplateVersionIds: z.array(Id).max(100), status: z.enum(["draft", "active", "paused", "archived"]),
  verificationStatus: z.enum(["pending", "confirmed", "failed"]), verificationReference: z.string().trim().max(1000), sampleStatus: z.enum(["untested", "passed", "failed"]),
  unitCostMinor: z.int().nonnegative().max(Number.MAX_SAFE_INTEGER).nullable(), currency: z.string().regex(/^[A-Z]{3}$/), minimumOrderQuantity: z.int().positive().max(100000).nullable(),
  leadTimeDays: z.int().nonnegative().max(3650).nullable(), dailyCapacity: z.int().nonnegative().max(1000000).nullable(), validFrom: z.iso.datetime(), validUntil: z.iso.datetime().nullable(),
  afterSalesTerms: z.string().trim().max(2000), evidenceReferences: z.array(z.string().trim().min(1).max(1000)).max(20), notes: z.string().trim().max(4000),
}).strict().superRefine((value, context) => {
  if (value.status === "active" && value.minimumOrderQuantity === null) context.addIssue({ code: "custom", path: ["minimumOrderQuantity"], message: "启用能力须确认最低接单量；未知时可留空保存草稿" });
  if (value.status === "active" && !value.processCodes.length) context.addIssue({ code: "custom", path: ["processCodes"], message: "启用能力须确认至少一种承接工序；资料不完整时可保存为草稿" });
  if (value.skuId && !value.productPlanId) context.addIssue({ code: "custom", path: ["productPlanId"], message: "SKU 必须归属指定产品" });
  if (value.minimumLongestMm && value.maximumLongestMm && value.minimumLongestMm > value.maximumLongestMm) context.addIssue({ code: "custom", path: ["maximumLongestMm"], message: "尺寸上限须不小于下限" });
  if (value.validUntil && new Date(value.validUntil) <= new Date(value.validFrom)) context.addIssue({ code: "custom", path: ["validUntil"], message: "有效期结束须晚于开始" });
  if (value.status === "active" && (value.verificationStatus !== "confirmed" || value.verificationReference.length < 5 || value.sampleStatus === "failed")) context.addIssue({ code: "custom", path: ["verificationReference"], message: "启用能力须记录实际核验依据，失败样品不能启用" });
  if (value.status === "active" && value.productType === "shaped_pillow" && value.fulfillmentScope === "full_product" && (!value.factoryStandardId || !value.sideModes.length || !["PRINT", "CUT", "SEW", "FILL"].every(code => value.processCodes.some(item => item === code)))) context.addIssue({ code: "custom", path: ["processCodes"], message: "抱枕整件制作须确认印刷、裁切、缝制、填充、印刷面数和工艺标准" });
});
export const CreateFactorySchema = z.object({ supplierId: Id, code: z.string().regex(/^[A-Za-z0-9][A-Za-z0-9_.-]{0,63}$/), profile: FactoryProfileSchema, idempotencyKey: z.uuid() }).strict();
export const ReviseFactorySchema = z.object({ expectedVersion: z.int().positive(), profile: FactoryProfileSchema, idempotencyKey: z.uuid() }).strict();
export const CreateFactoryCapabilitySchema = z.object({ profile: FactoryCapabilityProfileSchema, idempotencyKey: z.uuid() }).strict();
export const ReviseFactoryCapabilitySchema = CreateFactoryCapabilitySchema.extend({ expectedVersion: z.int().positive() }).strict();
export const FactoryViewSchema = z.object({ id: Id, supplierId: Id, supplierName: z.string(), supplierStatus: z.string(), supplierBlockers: z.array(z.string()).default([]), code: z.string(), versionId: Id, versionNumber: z.int().positive(), profile: FactoryProfileSchema, updatedAt: z.iso.datetime() }).strict();
export const FactoryCapabilityViewSchema = z.object({ id: Id, factoryId: Id, versionId: Id, versionNumber: z.int().positive(), profile: FactoryCapabilityProfileSchema, updatedAt: z.iso.datetime() }).strict();
const FactoryAccessSchema = z.object({ canRead: z.boolean(), canWrite: z.boolean() }).strict();
const factoryAuthority = { contextAuthority: ErpContextAuthoritySchema, access: FactoryAccessSchema };
function validateFactoryAuthority(value: { contextAuthority: string; access: z.infer<typeof FactoryAccessSchema> }, context: z.RefinementCtx) {
  const result = ErpContextAuthoritySchema.safeParse(value.contextAuthority);
  if (!result.success) return;
  const ceiling = JSON.parse(result.data) as { permissions: string[]; dataScope: string; permissionScopes?: Record<string, string> };
  const allowed = (permission: string) => ceiling.permissions.includes(permission) && (ceiling.permissionScopes ? ceiling.permissionScopes[permission] : ceiling.dataScope) === "tenant";
  if (!value.access.canRead || value.access.canRead !== allowed("order:read") || value.access.canWrite !== allowed("order:write")) {
    context.addIssue({ code: "custom", path: ["access"], message: "Factory access must match the current operation scopes" });
  }
}
export const FactoryDirectorySchema = z.object({ ...factoryAuthority, factories: z.array(FactoryViewSchema), capabilities: z.array(FactoryCapabilityViewSchema), products: z.array(z.object({ id: Id, name: z.string(), skus: z.array(z.object({ id: Id, code: z.string() })) }).strict()), templates: z.array(z.object({ id: Id, name: z.string(), versionNumber: z.int().positive() }).strict()) }).strict().superRefine(validateFactoryAuthority);
export const FactoryHistorySchema = z.object({ ...factoryAuthority, factoryId: Id, factories: z.array(FactoryViewSchema), capabilities: z.array(FactoryCapabilityViewSchema) }).strict().superRefine((value, context) => {
  validateFactoryAuthority(value, context);
  if (value.factories.some(factory => factory.id !== value.factoryId) || value.capabilities.some(capability => capability.factoryId !== value.factoryId)) {
    context.addIssue({ code: "custom", path: ["factoryId"], message: "Factory history must belong to the requested factory" });
  }
  for (const key of ["factories", "capabilities"] as const) {
    const ids = value[key].map(version => version.versionId);
    if (new Set(ids).size !== ids.length) context.addIssue({ code: "custom", path: [key], message: "Duplicate immutable version" });
    const versions = value[key].map(version => `${version.id}:${version.versionNumber}`);
    if (new Set(versions).size !== versions.length) context.addIssue({ code: "custom", path: [key], message: "Conflicting immutable version number" });
  }
});
export const FactoryProductionPinSchema = z.object({ supplierId: Id, supplierName: z.string(), factoryId: Id, factoryCode: z.string(), factoryVersionId: Id, factoryVersionNumber: z.int().positive(), factoryProfile: FactoryProfileSchema, capabilityId: Id, capabilityVersionId: Id, capabilityVersionNumber: z.int().positive(), capabilityProfile: FactoryCapabilityProfileSchema }).strict();
export const ProductionFactoryChoiceSchema = z.object({ pin: FactoryProductionPinSchema, blockers: z.array(z.string()) }).strict();
export const FactoryDestinationSchema = FactoryProductionPinSchema.pick({ supplierId: true, supplierName: true, factoryId: true, factoryCode: true, factoryVersionId: true, factoryVersionNumber: true, factoryProfile: true });
export type FactoryProfile = z.infer<typeof FactoryProfileSchema>;
export type FactoryCapabilityProfile = z.infer<typeof FactoryCapabilityProfileSchema>;
export type FactoryView = z.infer<typeof FactoryViewSchema>;
export type FactoryCapabilityView = z.infer<typeof FactoryCapabilityViewSchema>;
export type FactoryDirectory = z.infer<typeof FactoryDirectorySchema>;
export type FactoryHistory = z.infer<typeof FactoryHistorySchema>;
export type FactoryProductionPin = z.infer<typeof FactoryProductionPinSchema>;
export type ProductionFactoryChoice = z.infer<typeof ProductionFactoryChoiceSchema>;
