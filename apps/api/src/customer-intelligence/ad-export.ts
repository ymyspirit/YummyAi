import {formatAdMinorAmount,type AdCurrencyBasis,type AdExportView} from "@yummyai/contracts/advertising";
function cell(value: string | number | null) {
  let text = value === null ? "" : String(value);
  if (/^[=+@-]/.test(text.trimStart()) || text.startsWith("\t") || text.startsWith("\r"))
    text = `'${text}`;
  return `"${text.replaceAll('"', '""')}"`;
}
function amount(minor: number | null, currency: string | null, versionTwo=false, basis?:AdCurrencyBasis|null) {
  if (minor === null || !currency) return null;
  if (versionTwo) return formatAdMinorAmount(minor,currency,basis);
  const digits =
    new Intl.NumberFormat("en", { style: "currency", currency }).resolvedOptions()
      .maximumFractionDigits ?? 2;
  const padded = String(minor).padStart(digits + 1, "0");
  return digits ? `${padded.slice(0, -digits)}.${padded.slice(-digits)}` : padded;
}
/** This is a reviewed operator checklist, not a marketplace bulk-upload command. */
export function advertisingReviewCsv(sealed: AdExportView): string {
  const versionTwo=sealed.payload.csvFormatVersion===2;
  const headings = [
    "导出编号",
    "内容校验值",
    "调整记录编号",
    "状态",
    "规则",
    "产品ASIN",
    "站点",
    "币种",
    "活动ID",
    "广告组ID",
    "投放ID",
    "搜索词",
    "原竞价",
    "建议竞价",
    "实际原竞价",
    "实际新竞价",
    "执行时间",
    "实际执行活动ID",
    "实际执行广告组ID",
    "实际执行投放ID",
    "统计开始",
    "统计结束",
    "原因",
    "限制",
    ...(versionTwo?["金额精度版本","最小单位位数","转化模型","转化窗口天数","保存原竞价最小整数","保存建议竞价最小整数","保存实际原竞价最小整数","保存实际新竞价最小整数"]:[]),
  ];
  const rows = sealed.payload.actions.map((a) => {
    const r = a.recommendation;
    return [
      sealed.id,
      sealed.checksum,
      a.id,
      a.status,
      r.ruleId,
      r.scope?.asin ?? null,
      r.marketplace,
      r.currency,
      r.campaignId,
      r.adGroupId,
      r.targetId,
      r.term,
      amount(r.currentBidMinor, r.currency,versionTwo,r.monetaryBasis),
      amount(r.proposedBidMinor, r.currency,versionTwo,r.monetaryBasis),
      amount(a.actualBeforeMinor, r.currency,versionTwo,r.monetaryBasis),
      amount(a.actualAfterMinor, r.currency,versionTwo,r.monetaryBasis),
      a.executedAt,
      a.execution?.campaignId ?? null,
      a.execution?.adGroupId ?? null,
      a.execution?.targetId ?? null,
      r.periodStart,
      r.periodEnd,
      r.reason,
      r.constraints.join("；"),
      ...(versionTwo?[r.monetaryBasis?.currencyTableVersion??"原精度未保存",r.monetaryBasis?.minorDigits??null,r.conversion?.model??"unknown",r.conversion?.windowDays??null,r.currentBidMinor,r.proposedBidMinor,a.actualBeforeMinor,a.actualAfterMinor]:[]),
    ];
  });
  return `\ufeff${[headings, ...rows].map((r) => r.map(cell).join(",")).join("\r\n")}\r\n`;
}
