import {z} from "zod";
import {FINANCE_CURRENCY_TABLE_VERSION,financeCurrencyMinorDigits} from "@yummyai/contracts/finance/monetary";

export const AD_MEASUREMENT_ADAPTER = "amazon_csv_measurement_v1" as const;
const Currency=z.string().regex(/^[A-Z]{3}$/),Column=z.string().min(1).max(200);
export const AdAttributionModelSchema=z.enum(["click","legacy_click_and_view","shopping_signal_2026","all_views_14d","unknown"]);
export const AdConversionDefinitionSchema=z.object({model:AdAttributionModelSchema,source:z.string().trim().max(1000)}).strict().superRefine((value,context)=>{
 if(value.model!=="unknown"&&value.source.length<3)context.addIssue({code:"custom",path:["source"],message:"请填写实际报告设置或指标定义的核对依据"});
});
export const AdMetricColumnsSchema=z.object({impressions:Column.nullable(),clicks:Column.nullable(),purchases:Column.nullable(),spendMinor:Column.nullable(),salesMinor:Column.nullable(),bidMinor:Column.nullable()}).strict();
export const AdMetricColumnSelectionSchema=AdMetricColumnsSchema.partial();
const Candidates=z.array(Column).max(200);
export const AdMetricCandidatesSchema=z.object({impressions:Candidates,clicks:Candidates,purchases:Candidates,spendMinor:Candidates,salesMinor:Candidates,bidMinor:Candidates}).strict();
export const AdCurrencyPrecisionSchema=z.object({schemaVersion:z.literal(1),currency:Currency,minorDigits:z.number().int().min(0).max(4).nullable(),currencyTableVersion:z.literal(FINANCE_CURRENCY_TABLE_VERSION)}).strict().superRefine((value,context)=>{
 if(value.minorDigits!==financeCurrencyMinorDigits(value.currency))context.addIssue({code:"custom",path:["minorDigits"],message:"币种精度必须与固定ISO快照一致 未知不能推测"});
});
export const AdCurrencyBasisSchema=z.object({schemaVersion:z.literal(1),currency:Currency,minorDigits:z.number().int().min(0).max(4),currencyTableVersion:z.literal(FINANCE_CURRENCY_TABLE_VERSION)}).strict().superRefine((value,context)=>{
 if(value.minorDigits!==financeCurrencyMinorDigits(value.currency))context.addIssue({code:"custom",path:["minorDigits"],message:"金额转换依据与固定ISO快照不一致"});
});
export const AdConversionBasisSchema=z.object({state:z.enum(["resolved","unresolved","conflict"]),model:AdAttributionModelSchema,windowDays:z.number().int().min(0).max(90).nullable(),source:z.string().trim().min(3).max(1000).nullable()}).strict().superRefine((value,context)=>{
 if(value.state==="resolved"&&(value.model==="unknown"||value.windowDays===null||!value.source))context.addIssue({code:"custom",message:"已核对转化必须固定模型 窗口及来源"});
 if(value.model==="all_views_14d"&&value.windowDays!==14)context.addIssue({code:"custom",path:["windowDays"],message:"all views指标固定14天窗口"});
});
const MeasurementFields={schemaVersion:z.literal(1),adapterVersion:z.literal(AD_MEASUREMENT_ADAPTER),columns:AdMetricColumnsSchema,conversion:AdConversionBasisSchema};
export const AdFactMeasurementSchema=z.object({...MeasurementFields,monetaryBasis:AdCurrencyBasisSchema.nullable()}).strict();
export const AdFileMeasurementSchema=z.object({...MeasurementFields,currencies:z.array(AdCurrencyPrecisionSchema).max(2000)}).strict().superRefine((value,context)=>{
 const codes=value.currencies.map(item=>item.currency);if(new Set(codes).size!==codes.length||codes.some((code,index)=>code!==[...codes].sort()[index]))context.addIssue({code:"custom",path:["currencies"],message:"币种精度清单必须唯一并排序"});
});
export type AdAttributionModel=z.infer<typeof AdAttributionModelSchema>;
export type AdConversionDefinition=z.infer<typeof AdConversionDefinitionSchema>;
export type AdConversionBasis=z.infer<typeof AdConversionBasisSchema>;
export type AdMetricColumns=z.infer<typeof AdMetricColumnsSchema>;
export type AdMetricColumnSelection=z.infer<typeof AdMetricColumnSelectionSchema>;
export type AdMetricCandidates=z.infer<typeof AdMetricCandidatesSchema>;
export type AdCurrencyBasis=z.infer<typeof AdCurrencyBasisSchema>;
export type AdCurrencyPrecision=z.infer<typeof AdCurrencyPrecisionSchema>;
export type AdFactMeasurement=z.infer<typeof AdFactMeasurementSchema>;
export type AdFileMeasurement=z.infer<typeof AdFileMeasurementSchema>;

export function adCurrencyPrecision(currency:string):AdCurrencyPrecision{return AdCurrencyPrecisionSchema.parse({schemaVersion:1,currency,minorDigits:financeCurrencyMinorDigits(currency),currencyTableVersion:FINANCE_CURRENCY_TABLE_VERSION});}
export function adCurrencyBasis(currency:string):AdCurrencyBasis|null{const precision=adCurrencyPrecision(currency);return precision.minorDigits===null?null:AdCurrencyBasisSchema.parse(precision);}
/** Exact nonnegative reported amounts. Currency tokens cannot override the row currency. */
export function parseAdMinorAmount(value:string|null,currency:string):number|null{
 if(value===null)return null;const basis=adCurrencyBasis(currency);if(!basis)throw new RangeError("广告币种精度未知 请核对原币种 不按默认两位转换");
 let text=value.trim();const leading=/^([A-Za-z]{3})(?=\s|[\d.\p{Sc}])/u.exec(text),trailing=/([A-Za-z]{3})$/.exec(text);
 for(const token of[leading?.[1],trailing?.[1]])if(token&&token.toUpperCase()!==currency)throw new RangeError("金额中的币种代码与报告币种不一致");
 if(leading)text=text.slice(leading[0].length).trim();if(trailing)text=text.slice(0,-trailing[0].length).trim();
 const symbol=/^\p{Sc}/u.exec(text)?.[0];if(symbol){const allowed:Record<string,string[]>={"$":["USD","CAD","AUD","NZD","MXN","ARS","CLP","COP","HKD","SGD","TWD","BBD","BMD","BSD","BZD","FJD","GYD","JMD","KYD","LRD","NAD","SBD","SRD","TTD","XCD"],"€":["EUR"],"£":["GBP"],"¥":["JPY","CNY"],"₹":["INR"],"₩":["KRW"]};if(!allowed[symbol]?.includes(currency))throw new RangeError("金额符号与报告币种不一致或无法核对");text=text.slice(symbol.length);}
 if(!/^(?:(?:\d+|\d{1,3}(?:,\d{3})+)(?:\.\d+)?|\.\d+)$/.test(text))throw new RangeError("数值格式无效 请保留原始小数点和千位格式");
 const[whole="0",fraction=""]=text.replaceAll(",","").split("."),digits=basis.minorDigits;
 if(fraction.length>digits&&/[1-9]/.test(fraction.slice(digits)))throw new RangeError("金额超过固定币种最小单位 未舍入或截断");
 const amount=BigInt(whole||"0")*10n**BigInt(digits)+BigInt(fraction.slice(0,digits).padEnd(digits,"0")||"0");
 if(amount>BigInt(Number.MAX_SAFE_INTEGER))throw new RangeError("广告金额超过安全整数上限");return Number(amount);
}
export function formatAdMinorAmount(value:number|null,currency:string|null,basis?:AdCurrencyBasis|null):string{
 if(value===null||!currency)return "待补充";if(!Number.isSafeInteger(value))throw new RangeError("广告金额不是安全整数");
 if(!basis)return `${currency} ${value} 保存的最小单位（原精度未保存）`;
 const pinned=AdCurrencyBasisSchema.parse(basis);if(pinned.currency!==currency)throw new RangeError("广告金额与原币种依据不符");
 const amount=BigInt(value),absolute=amount<0n?-amount:amount,scale=10n**BigInt(pinned.minorDigits);
 return `${currency} ${amount<0n?"-":""}${absolute/scale}${pinned.minorDigits?"."+String(absolute%scale).padStart(pinned.minorDigits,"0"):""}`;
}
