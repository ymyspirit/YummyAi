import { z } from "zod";
import { EntityIdSchema as Id } from "@yummyai/contracts/common/ids";
import { ErpContextAuthoritySchema } from "@yummyai/contracts/auth/session";

export const FactoryLocalDateSchema = z.iso.date().refine(value => /^20\d{2}-/.test(value), "排程日期须在2000至2099年范围内");
export const FactoryTimeZoneSchema = z.string().min(1).max(80).refine(value => {
  if (/^[+-]/.test(value)) return false;
  try { new Intl.DateTimeFormat("en", { timeZone: value }); return true; } catch { return false; }
}, "须使用工厂实际IANA时区");
const Clock = z.string().regex(/^(?:[01]\d|2[0-3]):[0-5]\d$/);
export const FactoryWorkingIntervalSchema = z.object({ start: Clock, end: z.union([Clock, z.literal("24:00")]) }).strict().refine(value => value.start < value.end, { path: ["end"], message: "工作区间须在同一当地日内结束 跨日请拆成两日" });
const Intervals = z.array(FactoryWorkingIntervalSchema).max(12).superRefine((values, context) => {
  const sorted = [...values].sort((a, b) => a.start.localeCompare(b.start));
  if (sorted.some((value, index) => index > 0 && value.start < sorted[index - 1]!.end)) context.addIssue({ code: "custom", message: "同日工作区间不能重叠" });
});
export const FactoryCapacityBindingSchema = z.object({ capabilityVersionId: Id, unitsPerItem: z.int().positive().max(1_000_000) }).strict();
export const FactoryCapacityPoolProfileSchema = z.object({
  name: z.string().trim().min(1).max(200), status: z.enum(["draft", "active", "paused", "archived"]),
  dailyCapacityUnits: z.int().nonnegative().max(1_000_000_000).nullable(),
  weekly: z.array(z.object({ weekday: z.int().min(1).max(7), intervals: Intervals }).strict()).length(7),
  exceptions: z.array(z.object({ localDate: FactoryLocalDateSchema, intervals: Intervals, capacityUnits: z.int().nonnegative().max(1_000_000_000) }).strict()).max(366),
  cutoffTime: Clock.nullable(), bindings: z.array(FactoryCapacityBindingSchema).max(100),
  evidenceReference: z.string().trim().max(2_000), notes: z.string().trim().max(4_000),
}).strict().superRefine((value, context) => {
  if (new Set(value.weekly.map(day => day.weekday)).size !== 7) context.addIssue({ code: "custom", path: ["weekly"], message: "须明确七个当地工作日 含不工作的日期" });
  if (new Set(value.exceptions.map(day => day.localDate)).size !== value.exceptions.length) context.addIssue({ code: "custom", path: ["exceptions"], message: "同一天只能有一份例外安排" });
  if (new Set(value.bindings.map(binding => binding.capabilityVersionId)).size !== value.bindings.length) context.addIssue({ code: "custom", path: ["bindings"], message: "同一能力版本不能重复绑定资源池" });
  if (value.status === "active" && (value.dailyCapacityUnits === null || !value.bindings.length || value.evidenceReference.length < 5)) context.addIssue({ code: "custom", path: ["evidenceReference"], message: "启用资源池须确认额度 能力用量和实际依据 不能用旧参考值自动补齐" });
  for (const [index, day] of value.exceptions.entries()) if (!day.intervals.length && day.capacityUnits !== 0) context.addIssue({ code: "custom", path: ["exceptions", index, "capacityUnits"], message: "闭厂日期额度必须为零" });
});
export const FactoryCapacityUnitSchema = z.enum(["each", "minute"]);
export const CreateFactoryCapacityPoolSchema = z.object({ factoryVersionId: Id, code: z.string().regex(/^[A-Za-z0-9][A-Za-z0-9_.-]{0,63}$/), timeZone: FactoryTimeZoneSchema,
  unit: FactoryCapacityUnitSchema, profile: FactoryCapacityPoolProfileSchema, idempotencyKey: z.uuid() }).strict();
export const ReviseFactoryCapacityPoolSchema = z.object({ expectedVersion: z.int().positive(), profile: FactoryCapacityPoolProfileSchema, idempotencyKey: z.uuid() }).strict();
export const FactoryCapacitySelectionSchema = z.object({ poolId: Id, poolVersionId: Id, localDate: FactoryLocalDateSchema }).strict();
export const ProductionCapacityPlanSchema = z.object({ allocations: z.array(FactoryCapacitySelectionSchema).min(1).max(32) }).strict().superRefine((value, context) => {
  if (new Set(value.allocations.map(item => item.poolId)).size !== value.allocations.length) context.addIssue({ code: "custom", path: ["allocations"], message: "同一生产安排的每个资源池只能选择一次" });
});
export const FactoryCapacityPoolViewSchema = z.object({ id: Id, factoryId: Id, code: z.string(), timeZone: FactoryTimeZoneSchema, unit: FactoryCapacityUnitSchema,
  factoryVersionId: Id, versionId: Id, versionNumber: z.int().positive(), profile: FactoryCapacityPoolProfileSchema, createdAt: z.iso.datetime() }).strict();
export const FactoryCapacityDaySchema = z.object({ poolId: Id, poolVersionId: Id, localDate: FactoryLocalDateSchema, timeZone: FactoryTimeZoneSchema, unit: FactoryCapacityUnitSchema,
  intervals: z.array(z.object({ start: z.iso.datetime(), end: z.iso.datetime() }).strict()).max(12), cutoffAt: z.iso.datetime().nullable(),
  capacityUnits: z.int().nonnegative().max(1_000_000_000).nullable(), allocatedUnits: z.int().nonnegative(), committedUnits: z.int().nonnegative(), releasedUnits: z.int().nonnegative(), availableUnits: z.int().nonnegative(),
  blockers: z.array(z.string()),
}).strict().superRefine((value, context) => {
  if (value.committedUnits + value.releasedUnits > value.allocatedUnits) context.addIssue({ code: "custom", path: ["allocatedUnits"], message: "承诺与释放不能超过原预留" });
  const upperBound = value.capacityUnits === null ? 0 : Math.max(0, value.capacityUnits - value.allocatedUnits + value.releasedUnits);
  if (value.availableUnits > upperBound) context.addIssue({ code: "custom", path: ["availableUnits"], message: "可用产能不能超过已核对净余额" });
});
const Authority = { contextAuthority: ErpContextAuthoritySchema, access: z.object({ canRead: z.boolean(), canWrite: z.boolean() }).strict() };
function validateAuthority(value: { contextAuthority: string; access: { canRead: boolean; canWrite: boolean } }, context: z.RefinementCtx) {
  if (!ErpContextAuthoritySchema.safeParse(value.contextAuthority).success) return;
  const ceiling = JSON.parse(value.contextAuthority) as { permissions: string[]; dataScope: string; permissionScopes?: Record<string, string> };
  const can = (permission: string) => ceiling.permissions.includes(permission) && (ceiling.permissionScopes ? ceiling.permissionScopes[permission] : ceiling.dataScope) === "tenant";
  if (!value.access.canRead || value.access.canRead !== can("order:read") || value.access.canWrite !== can("order:write")) context.addIssue({ code: "custom", path: ["access"], message: "产能读取权限须与当前逐项范围一致" });
}
export const FactoryCapacityWorkspaceSchema = z.object({ ...Authority, factoryId: Id, from: FactoryLocalDateSchema, days: z.int().min(1).max(31), recordedAt: z.iso.datetime(),
  pools: z.array(FactoryCapacityPoolViewSchema).max(200), calendar: z.array(FactoryCapacityDaySchema).max(6200) }).strict().superRefine((value, context) => {
    validateAuthority(value, context);
    if (value.pools.some(pool => pool.factoryId !== value.factoryId) || new Set(value.pools.map(pool => pool.id)).size !== value.pools.length) context.addIssue({ code: "custom", path: ["pools"], message: "资源池须唯一并归属当前工厂" });
    const pools = new Map(value.pools.map(pool => [pool.id, pool]));
    if (value.calendar.some(day => { const pool = pools.get(day.poolId); return !pool || pool.versionId !== day.poolVersionId || pool.unit !== day.unit || pool.timeZone !== day.timeZone; }) || new Set(value.calendar.map(day => `${day.poolId}:${day.localDate}`)).size !== value.calendar.length) context.addIssue({ code: "custom", path: ["calendar"], message: "工作日须属于当前资源池版本且不得重复" });
  });
export const FactoryCapacityQuerySchema = z.object({ from: FactoryLocalDateSchema.optional(), days: z.coerce.number().int().min(1).max(31).default(14), capabilityVersionId: Id.optional() }).strict();
export const FactoryCapacityPreviewItemSchema = z.object({ reference: z.string().min(1).max(160), factoryVersionId: Id, capabilityVersionId: Id, quantity: z.int().positive().max(100_000),
  expectedCompletionAt: z.iso.datetime(), capacityPlan: ProductionCapacityPlanSchema }).strict();
export const FactoryCapacityPreviewInputSchema = z.object({ items: z.array(FactoryCapacityPreviewItemSchema).min(1).max(100) }).strict().refine(value => new Set(value.items.map(item => item.reference)).size === value.items.length, { path: ["items"], message: "预览中的商品引用不能重复" });
export const FactoryCapacityPreviewSchema = z.object({ ...Authority, factoryId: Id, recordedAt: z.iso.datetime(), canReserve: z.boolean(), blockers: z.array(z.string()), items: z.array(z.object({
  reference: z.string(), quantity: z.int().positive(), expectedCompletionAt: z.iso.datetime(), blockers: z.array(z.string()), allocations: z.array(z.object({
    selection: FactoryCapacitySelectionSchema, poolName: z.string(), unitsPerItem: z.int().positive(), requestedUnits: z.int().positive(), day: FactoryCapacityDaySchema,
  }).strict()),
}).strict()) }).strict().superRefine(validateAuthority);
export const FactoryCapacityHistorySchema = z.object({ ...Authority, factoryId: Id, poolId: Id, versions: z.array(FactoryCapacityPoolViewSchema) }).strict().superRefine((value, context) => {
  validateAuthority(value, context);
  if (value.versions.some(version => version.factoryId !== value.factoryId || version.id !== value.poolId) || new Set(value.versions.map(version => version.versionId)).size !== value.versions.length || new Set(value.versions.map(version => version.versionNumber)).size !== value.versions.length) context.addIssue({ code: "custom", path: ["versions"], message: "历史须归属同一资源池 每版依据不得重复" });
});
export const ResolveFactoryLocalTimeInputSchema = z.object({ factoryVersionId: Id, localDateTime: z.string().regex(/^20\d{2}-\d{2}-\d{2}T(?:[01]\d|2[0-3]):[0-5]\d$/) }).strict();
export const ResolvedFactoryLocalTimeSchema = z.object({ ...Authority, factoryId: Id, factoryVersionId: Id, timeZone: FactoryTimeZoneSchema, localDateTime: z.string(), instant: z.iso.datetime() }).strict().superRefine(validateAuthority);
export const FactoryCapacityReservationViewSchema = z.object({ id: Id, factoryId: Id, poolId: Id, poolVersionId: Id, productionOrderId: Id, productionVersionId: Id,
  capabilityVersionId: Id, localDate: FactoryLocalDateSchema, timeZone: FactoryTimeZoneSchema, unit: FactoryCapacityUnitSchema, quantity: z.int().positive(), unitsPerItem: z.int().positive(), totalUnits: z.int().positive(),
  committedUnits: z.int().nonnegative(), releasedUnits: z.int().nonnegative(), workStartsAt: z.iso.datetime(), workEndsAt: z.iso.datetime(), createdAt: z.iso.datetime(),
}).strict().superRefine((value, context) => {
  if (value.committedUnits + value.releasedUnits > value.totalUnits || value.totalUnits !== value.quantity * value.unitsPerItem) context.addIssue({ code: "custom", path: ["totalUnits"], message: "产能原数量 单位换算 承诺与释放须守恒" });
});
export const ProductionCapacityViewSchema = z.object({ ...Authority, productionOrderId: Id, status: z.enum(["reserved", "legacy_unreserved"]), reservations: z.array(FactoryCapacityReservationViewSchema) }).strict().superRefine((value, context) => {
  validateAuthority(value, context);
  if ((value.status === "reserved") !== (value.reservations.length > 0) || value.reservations.some(row => row.productionOrderId !== value.productionOrderId) || new Set(value.reservations.map(row => row.id)).size !== value.reservations.length || new Set(value.reservations.map(row => `${row.productionVersionId}:${row.poolId}`)).size !== value.reservations.length) context.addIssue({ code: "custom", path: ["reservations"], message: "生产产能回执须归属原生产单 旧无预留不得补造" });
});
export type FactoryCapacityPoolProfile = z.infer<typeof FactoryCapacityPoolProfileSchema>;
export type FactoryCapacityPoolView = z.infer<typeof FactoryCapacityPoolViewSchema>;
export type FactoryCapacityDay = z.infer<typeof FactoryCapacityDaySchema>;
export type FactoryCapacitySelection = z.infer<typeof FactoryCapacitySelectionSchema>;
export type ProductionCapacityPlan = z.infer<typeof ProductionCapacityPlanSchema>;
export type FactoryCapacityWorkspace = z.infer<typeof FactoryCapacityWorkspaceSchema>;
export type FactoryCapacityPreview = z.infer<typeof FactoryCapacityPreviewSchema>;
export type FactoryCapacityPreviewInput = z.infer<typeof FactoryCapacityPreviewInputSchema>;
export type ProductionCapacityView = z.infer<typeof ProductionCapacityViewSchema>;
