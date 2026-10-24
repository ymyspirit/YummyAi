import { z } from "zod";
const Id = z.uuidv7(), Key = z.uuid(), Note = z.string().trim().min(5).max(2000);
export const LogisticsProviderSchema = z.enum(["shipos", "yunexpress"]);
export const LogisticsAddressSchema = z.object({ name: z.string().trim().min(1).max(200), company: z.string().trim().max(200).default(""),
  address1: z.string().trim().min(1).max(300), address2: z.string().trim().max(300).default(""), city: z.string().trim().min(1).max(100),
  region: z.string().trim().min(1).max(100), postalCode: z.string().trim().min(1).max(40), countryCode: z.string().regex(/^[A-Z]{2}$/),
  phone: z.string().trim().min(1).max(60), email: z.email().max(320).nullable().default(null) }).strict();
export const LogisticsPackageSchema = z.object({ weightGrams: z.number().positive().max(1_000_000), dimensionsMm: z.object({ length: z.number().positive().max(5000), width: z.number().positive().max(5000), height: z.number().positive().max(5000) }).strict(),
  evidence: Note, containsBattery: z.boolean(),
  declarations: z.array(z.object({ sku: z.string().trim().min(1).max(200), nameEn: z.string().trim().min(1).max(200), nameCn: z.string().trim().min(1).max(200),
    quantity: z.int().positive().max(100000), unitPriceMinor: z.int().positive().safe(), currency: z.string().regex(/^[A-Z]{3}$/), minorUnitDigits:z.int().min(0).max(3).default(2), unitWeightGrams: z.number().positive().max(1_000_000), hsCode: z.string().regex(/^\d{6,12}$/), originCountryCode: z.string().regex(/^[A-Z]{2}$/) }).strict()).min(1).max(100) }).strict();
export const LogisticsChannelProfileSchema = z.object({ code: z.string().trim().min(1).max(100), name: z.string().trim().min(1).max(200),
  countryCodes: z.array(z.string().regex(/^[A-Z]{2}$/)).min(1).max(250), transitDaysMin: z.int().nonnegative().max(365), transitDaysMax: z.int().positive().max(365),
  transitSource: Note, conditionsVerified: z.boolean(), conditionsEvidence: Note,
  acceptsBattery: z.boolean().default(false), maxWeightGrams: z.number().positive().max(1_000_000),
  maxDimensionMm: z.number().positive().max(5000) }).strict().refine(v => v.transitDaysMin <= v.transitDaysMax, "渠道时效上限须不小于下限");
export const LogisticsConnectionProfileSchema = z.object({ name: z.string().trim().min(1).max(160), provider: LogisticsProviderSchema,
  factoryId: Id, originCountryCode: z.string().regex(/^[A-Z]{2}$/), sender: LogisticsAddressSchema,
  baseUrl: z.url(), module: z.literal(2).default(2), billingDepot: z.string().trim().max(100).default(""),
  currency: z.string().regex(/^[A-Z]{3}$/), currencySource: Note, minorUnitDigits: z.int().min(0).max(3).default(2),
  labelHosts: z.array(z.string().regex(/^[a-z0-9][a-z0-9.-]+$/)).min(1).max(10),
  channels: z.array(LogisticsChannelProfileSchema).max(200), apiCompatibilityEvidence: Note, purchasePermissionEvidence: Note,
  labelMode: z.enum(["factory_pull", "include"]).default("include") }).strict().superRefine((v, ctx) => {
    if (v.sender.countryCode !== v.originCountryCode) ctx.addIssue({ code: "custom", path: ["sender"], message: "发货地址国家须与实际发货路线一致" });
    if (v.originCountryCode === "CN" && v.provider !== "yunexpress") ctx.addIssue({ code: "custom", path: ["provider"], message: "中国实际发货路线使用云途" });
    if (v.provider === "yunexpress" && v.originCountryCode !== "CN") ctx.addIssue({ code: "custom", path: ["originCountryCode"], message: "云途路线须以工厂实际中国发货地为依据" });
    if (v.provider === "yunexpress" && v.labelMode !== "include") ctx.addIssue({ code: "custom", path: ["labelMode"], message: "云途面单随工厂交付包提供" });
    if (new Set(v.channels.map(c => c.code)).size !== v.channels.length) ctx.addIssue({ code: "custom", path: ["channels"], message: "渠道编号不可重复" });
  });
export const LogisticsCredentialsSchema = z.discriminatedUnion("provider", [
  z.object({ provider: z.literal("shipos"), appKey: z.string().trim().min(1).max(300), appSecret: z.string().trim().min(1).max(1000) }).strict(),
  z.object({ provider: z.literal("yunexpress"), customerCode: z.string().trim().min(1).max(200), apiSecret: z.string().trim().min(1).max(1000) }).strict(),
]);
export const SaveLogisticsConnectionSchema = z.object({ connectionId: Id.optional(), expectedVersion: z.int().nonnegative(), profile: LogisticsConnectionProfileSchema,
  credentials: LogisticsCredentialsSchema.optional(), idempotencyKey: Key }).strict();
export const LogisticsRuleSchema = z.object({ name: z.string().trim().min(1).max(160), autoPurchase: z.boolean().default(false), currency: z.string().regex(/^[A-Z]{3}$/),
  maxTicketMinor: z.int().positive().safe(), maxDailyMinor: z.int().positive().safe(), quoteMaxAgeSeconds: z.int().min(30).max(900).default(120),
  allowedChannelCodes: z.array(z.string().trim().min(1).max(100)).min(1).max(200), evidence: Note }).strict().refine(v => v.maxTicketMinor <= v.maxDailyMinor, "单票上限不可超过每日上限");
export const SaveLogisticsRuleSchema = z.object({ connectionId: Id, expectedVersion: z.int().nonnegative(), rule: LogisticsRuleSchema, idempotencyKey: Key }).strict();
const CreateLogisticsTaskBaseSchema = z.object({ orderId: Id, productionOrderIds: z.array(Id).min(1).max(50),
  connectionId: Id, packages: z.array(LogisticsPackageSchema).min(1).max(20),
  readyAt: z.iso.datetime(), latestShipAt: z.iso.datetime(), deliverBy: z.iso.datetime(), deadlineSource: Note,
  expectedOrderSequence: z.int().positive(), idempotencyKey: Key }).strict();
function refineTask(v:Pick<z.infer<typeof CreateLogisticsTaskBaseSchema>,"productionOrderIds"|"readyAt"|"latestShipAt"|"deliverBy">,ctx:z.RefinementCtx) {
    if (new Set(v.productionOrderIds).size !== v.productionOrderIds.length) ctx.addIssue({ code: "custom", path: ["productionOrderIds"], message: "生产任务不可重复" });
    if (Date.parse(v.readyAt) > Date.parse(v.latestShipAt) || Date.parse(v.latestShipAt) >= Date.parse(v.deliverBy)) ctx.addIssue({ code: "custom", path: ["latestShipAt"], message: "预计完工、最晚发货和送达时间不一致" });
}
export const CreateLogisticsTaskSchema=CreateLogisticsTaskBaseSchema.superRefine(refineTask);
export const LogisticsTaskSnapshotSchema = CreateLogisticsTaskBaseSchema.omit({ idempotencyKey: true }).extend({ factoryId: Id, factoryVersionId: Id, connectionVersionId: Id, ruleVersionId: Id,
  recipient: LogisticsAddressSchema, productionPins: z.array(z.object({ productionOrderId: Id, versionId: Id, lineId: Id, quantity: z.int().positive() }).strict()).min(1),
  addressEnvelopeVersion: z.int().positive(), retentionExpiresAt: z.iso.datetime() }).strict().superRefine(refineTask);
export const LogisticsQuoteSchema = z.object({ channelCode: z.string().min(1).max(100), channelName: z.string().max(200), totalMinor: z.int().nonnegative().safe(),
  currency: z.string().regex(/^[A-Z]{3}$/).nullable(), currencySource: z.string().max(2000).nullable(),
  transitDaysMin: z.number().nonnegative().nullable(), transitDaysMax: z.number().positive().nullable(), transitSource: z.string().max(2000).nullable(),
  conditionsVerified: z.boolean(), priceSource: z.string().min(1).max(2000), quotedAt: z.iso.datetime(),
  diagnostic: z.string().max(500).nullable().default(null) }).strict();
export const LogisticsTaskStateSchema = z.enum(["pending", "quoted", "purchasing", "created", "label_requesting", "completed", "attention", "reconciliation_required", "cancelled"]);
export type LogisticsConnectionProfile = z.infer<typeof LogisticsConnectionProfileSchema>;
export type LogisticsCredentials = z.infer<typeof LogisticsCredentialsSchema>;
export type LogisticsRule = z.infer<typeof LogisticsRuleSchema>;
export type LogisticsTaskSnapshot = z.infer<typeof LogisticsTaskSnapshotSchema>;
export type LogisticsQuote = z.infer<typeof LogisticsQuoteSchema>;
export type LogisticsAddress = z.infer<typeof LogisticsAddressSchema>;
export type LogisticsPackage = z.infer<typeof LogisticsPackageSchema>;
export type LogisticsTaskState = z.infer<typeof LogisticsTaskStateSchema>;
export type LogisticsConnectionView = { id: string; version: number; versionId: string; profile: LogisticsConnectionProfile; verifiedAt: string | null; rule: LogisticsRule | null; ruleVersion: number; ruleVersionId: string | null };
export type LogisticsTaskView = { id: string; orderId: string; factoryId: string; externalReference: string; status: LogisticsTaskState; diagnostic: string | null; createdAt: string; quotedCostMinor: number | null; actualCostMinor: number | null; currency: string | null; quotedCurrency: string | null; actualCurrency: string | null; minorUnitDigits: number; trackingNumbers: string[]; labelMode: "factory_pull" | "include"; labelCount: number; quotes: LogisticsQuote[]; latestShipAt: string; deliverBy: string; connectionName: string; factoryName: string; orderNumber: string; labels: Array<{id: string; fileName: string; checksum: string}> };
export const LogisticsOptionsSchema = z.object({
  canConfigure: z.boolean(), canCreate: z.boolean(), truncated: z.boolean(),
  factories: z.array(z.object({id:Id,name:z.string(),origin: z.object({countryCode:z.string(),province:z.string(),city:z.string(),street:z.string(),postalCode:z.string()}).nullable()})),
  candidates: z.array(z.object({productionOrderId:Id,versionId:Id,orderId:Id,orderNumber:z.string(),orderSequence:z.int(),factoryId:Id,factoryName:z.string(),sku:z.string().nullable(),quantity:z.int().positive(),expectedCompletionAt:z.iso.datetime(),status:z.string(),taskId:Id.nullable(),blockers:z.array(z.string())})),
});
export type LogisticsOptions = z.infer<typeof LogisticsOptionsSchema>;
