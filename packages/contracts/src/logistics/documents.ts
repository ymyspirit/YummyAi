import { z } from "zod";

const Id = z.uuidv7();
const Text = z.string().trim().min(1).max(160);
const Measure = z.number().positive().max(100000);
export const DocumentAdapterSchema = z.enum(["printeque_shipping", "printeque_factory", "yunexpress"]);
export const ParcelSpecificationSchema = z.object({
  specificationVersionId: Id,
  productKind: z.enum(["shaped_pillow", "custom_hanger", "other"]),
  sizeIn: z.number().positive().max(1000).nullable(),
  supplierSku: z.string().trim().max(160),
  weight: Measure,
  weightUnit: z.enum(["lb", "kg", "g"]),
  length: Measure.nullable(), width: Measure.nullable(), height: Measure.nullable(),
  dimensionUnit: z.enum(["in", "cm", "mm"]),
  declaredUnitValueMinor: z.int().positive().max(100_000_000).nullable(),
  nameEn: Text, nameCn: Text,
  hsCode: z.string().regex(/^(?:\d{6,12})?$/),
}).strict();

/** Supplier packing data is separate from manufacturing dimensions and SKU identity. */
export const FactoryDocumentProfileSchema = z.object({
  name: Text,
  route: z.enum(["printeque", "yunexpress"]),
  productionAdapter: z.enum(["printeque_factory", "yicai_folder", "none"]),
  originCountryCode: z.string().regex(/^[A-Z]{2}$/),
  destinationCountries: z.array(z.string().regex(/^[A-Z]{2}$/)).min(1).max(250),
  originCompany: z.string().trim().max(200),
  factoryCode: z.string().trim().max(100),
  carrierProvider: z.string().trim().max(100),
  carrierService: z.string().trim().max(100),
  useAccountSender: z.boolean(),
  specifications: z.array(ParcelSpecificationSchema).min(1).max(200),
  evidence: z.string().trim().min(5).max(1000),
}).strict().superRefine((value, ctx) => {
  if (new Set(value.specifications.map(item => item.specificationVersionId)).size !== value.specifications.length)
    ctx.addIssue({ code: "custom", path: ["specifications"], message: "同一规格版本只能配置一次" });
  if (value.route === "printeque" && (value.originCountryCode !== "US" || value.destinationCountries.some(code => code !== "US")))
    ctx.addIssue({ code: "custom", path: ["destinationCountries"], message: "Printeque 当前模板用于美国工厂发往美国" });
  if (value.route === "yunexpress" && value.originCountryCode !== "CN")
    ctx.addIssue({ code: "custom", path: ["originCountryCode"], message: "云途使用实际中国发货工厂" });
  if (value.productionAdapter === "printeque_factory" && (value.route !== "printeque" || !value.factoryCode || !value.originCompany || !value.carrierProvider))
    ctx.addIssue({ code: "custom", path: ["productionAdapter"], message: "Printeque 生产导单须填写工厂编号、订单来源与物流渠道提供方" });
  if (value.productionAdapter === "yicai_folder" && value.route !== "yunexpress")
    ctx.addIssue({ code: "custom", path: ["productionAdapter"], message: "义彩交付使用云途面单" });
});
export const SaveFactoryDocumentProfileSchema = z.object({
  factoryId: Id, expectedVersion: z.int().nonnegative(),
  profile: FactoryDocumentProfileSchema, idempotencyKey: z.uuid(),
}).strict();
export const DocumentParcelOverrideSchema = z.object({
  orderId: Id, weightLb: Measure.optional(), lengthIn: Measure.optional(),
  widthIn: Measure.optional(), heightIn: Measure.optional(), goodsSku: Text.optional(),
  declaredUnitValueMinor: z.int().positive().max(100_000_000).optional(),
  channelCode: z.enum(["THPHR", "ZBZXRPH"]).optional(),
  reason: z.string().trim().min(5).max(1000),
}).strict();
export const PreviewOrderDocumentsSchema = z.object({
  profileVersionId: Id, orderIds: z.array(Id).min(1).max(100),
  adapter: DocumentAdapterSchema,
  overrides: z.array(DocumentParcelOverrideSchema).max(100).default([]),
  deliveryPackageIds: z.array(Id).max(100).default([]),
}).strict().superRefine((value, ctx) => {
  for (const [key, values] of [["orderIds", value.orderIds], ["deliveryPackageIds", value.deliveryPackageIds],
    ["overrides", value.overrides.map(item => item.orderId)]] as const) {
    if (new Set(values).size !== values.length) ctx.addIssue({ code: "custom", path: [key], message: "选择不可重复" });
  }
  if (value.overrides.some(item => !value.orderIds.includes(item.orderId)))
    ctx.addIssue({ code: "custom", path: ["overrides"], message: "包裹调整须属于本次选中的订单" });
});
export const GenerateOrderDocumentsSchema = PreviewOrderDocumentsSchema.safeExtend({
  expectedFingerprint: z.string().regex(/^[a-f0-9]{64}$/), idempotencyKey: z.uuid(),
});
export type DocumentAdapter = z.infer<typeof DocumentAdapterSchema>;
export type ParcelSpecification = z.infer<typeof ParcelSpecificationSchema>;
export type FactoryDocumentProfile = z.infer<typeof FactoryDocumentProfileSchema>;
export type DocumentParcelOverride = z.infer<typeof DocumentParcelOverrideSchema>;
export type PreviewOrderDocuments = z.infer<typeof PreviewOrderDocumentsSchema>;
export type DocumentCell = string | number | null;
export type DocumentRow = Record<string, DocumentCell>;
export type DocumentAddress = { recipient: string; countryCode: string; address1: string; address2: string;
  city: string; region: string; postalCode: string; phone: string; email: string };
export type DocumentOrderLine = { id: string; externalLineId: string; quantity: number; skuCode: string | null;
  specificationVersionId: string | null; specificationName: string; productionFileSku?: string };
export type DocumentOrderSource = { id: string; orderNumber: string; address: DocumentAddress; lines: DocumentOrderLine[] };
export type DocumentParcel = { quantity: number; weightLb: number; weightKg: number; lengthIn: number | null;
  widthIn: number | null; heightIn: number | null; goodsSku: string; declaredUnitValueMinor: number | null;
  gofo: boolean; usps: boolean; channelCode: string | null };
export type DocumentOrderPreview = { orderId: string; orderNumber: string; blockers: string[];
  notices: string[]; parcel: DocumentParcel | null; rows: DocumentRow[] };
export type OrderDocumentsPreview = { fingerprint: string; adapter: DocumentAdapter; factoryName: string;
  profileVersionId: string; orders: DocumentOrderPreview[]; ready: boolean; rowCount: number };
export type DocumentProfileView = { id: string; factoryId: string; factoryVersionId: string; version: number; profile: FactoryDocumentProfile };
export type DocumentOptions = {
  canConfigure: boolean; canGenerate: boolean; canReadProduction: boolean; truncated: boolean;
  factories: Array<{ id: string; name: string; status: string; countryCode: string | null }>;
  specifications: Array<{ id: string; name: string; code: string; spuName: string; version: number }>;
  profiles: DocumentProfileView[];
  orders: Array<{ id: string; lineId: string | null; number: string; state: string; quantity: number }>;
};
export type DocumentExportView = { id: string; adapter: DocumentAdapter; factoryName: string; createdAt: string;
  rowCount: number; byteSize: number; checksum: string; available: boolean; reason: string | null };
export const RegisterDocumentLabelSchema = z.object({
  exportId: Id, orderId: Id, expectedFingerprint: z.string().regex(/^[a-f0-9]{64}$/),
  trackingNumber: z.string().trim().min(2).max(120).regex(/^[A-Za-z0-9-]+$/),
  fileName: z.string().trim().min(1).max(180).regex(/^[^/\\]+\.pdf$/i)
    .refine(value => [...value].every(char => char.charCodeAt(0) >= 32), "文件名不能包含控制字符"),
  base64: z.string().min(8).max(7_000_000).regex(/^[A-Za-z0-9+/]+={0,2}$/),
  verifiedByOperator: z.literal(true), idempotencyKey: z.uuid(),
}).strict();
export const DownloadYicaiHandoffSchema = z.object({ labelId: Id, deliveryPackageIds: z.array(Id).min(1).max(20) }).strict()
  .refine(value => new Set(value.deliveryPackageIds).size === value.deliveryPackageIds.length, "交付包不可重复");
export type DocumentLabelView = { id: string; orderId: string; orderNumber: string; trackingNumber: string;
  fileName: string; createdAt: string; available: boolean; reason: string | null };
