import { z } from "zod";

const Text = z.string().trim().max(200);
export const BusinessAddressSchema = z.object({
  countryCode: z.string().trim().regex(/^$|^[A-Z]{2}$/).default(""), province: Text.default(""), city: Text.default(""), district: Text.default(""),
  street: z.string().trim().max(500).default(""), postalCode: z.string().trim().max(40).default(""), recipient: Text.default(""), phone: z.string().trim().max(80).default(""),
}).strict();
export const BusinessContactSchema = z.object({
  name: Text.default(""), role: z.enum(["business", "production", "quality", "shipping"]),
  phone: z.string().trim().max(80).default(""), wechat: Text.default(""), email: z.union([z.literal(""), z.email().max(254)]).default(""),
}).strict().refine(value => !!(value.name || value.phone || value.wechat || value.email), { message: "联系人至少填写姓名或一种联系方式" });
export const SupplierProfileSchema = z.object({
  schemaVersion: z.literal(1).default(1), entityKind: z.enum(["unconfirmed", "external_supplier", "internal_entity"]).default("unconfirmed"),
  legalName: Text.default(""), alias: Text.default(""), roles: z.array(z.enum(["manufacturing", "blank_goods", "raw_material", "packaging"])).max(4).default([]),
  contacts: z.array(BusinessContactSchema).max(12).default([]), officeAddress: BusinessAddressSchema.nullable().default(null),
  paymentTerms: z.string().trim().max(2000).default(""), invoiceInformation: z.string().trim().max(1000).default(""), notes: z.string().trim().max(4000).default(""),
}).strict();
export type SupplierProfile = z.infer<typeof SupplierProfileSchema>;
export type BusinessAddress = z.infer<typeof BusinessAddressSchema>;
