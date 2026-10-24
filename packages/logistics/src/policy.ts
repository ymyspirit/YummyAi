import type { LogisticsQuote, LogisticsRule, LogisticsTaskSnapshot } from "@yummyai/contracts/logistics";
export function selectLogisticsQuote(quotes: LogisticsQuote[], rule: LogisticsRule, task: Pick<LogisticsTaskSnapshot, "readyAt" | "latestShipAt" | "deliverBy">, now = new Date()) {
  const rejected: Array<{ channelCode: string; reason: string }> = [];
  const candidates = quotes.filter(q => {
    let reason: string | undefined;
    if (!rule.allowedChannelCodes.includes(q.channelCode)) reason = "CHANNEL_NOT_ALLOWED";
    else if (q.diagnostic) reason = q.diagnostic;
    else if (!q.currency || q.currency !== rule.currency || !q.currencySource) reason = "CURRENCY_UNVERIFIED";
    else if (q.transitDaysMax === null || !q.transitSource || !q.conditionsVerified) reason = "SERVICE_UNVERIFIED";
    else if (Date.parse(task.latestShipAt) < now.getTime() || Date.parse(task.readyAt) > Date.parse(task.latestShipAt)) reason = "SHIP_DEADLINE_MISSED";
    else if (Date.parse(task.latestShipAt) + q.transitDaysMax * 86_400_000 > Date.parse(task.deliverBy)) reason = "DELIVERY_DEADLINE_MISSED";
    else if (now.getTime() - Date.parse(q.quotedAt) > rule.quoteMaxAgeSeconds * 1000 || Date.parse(q.quotedAt) > now.getTime() + 5000) reason = "QUOTE_EXPIRED";
    else if (q.totalMinor > rule.maxTicketMinor) reason = "TICKET_BUDGET_EXCEEDED";
    if (reason) rejected.push({ channelCode: q.channelCode, reason });
    return !reason;
  }).sort((a,b) => a.totalMinor - b.totalMinor || a.transitDaysMax! - b.transitDaysMax! || a.channelCode.localeCompare(b.channelCode));
  return { selected: candidates[0] ?? null, rejected };
}
export function decimalMinor(value: unknown, digits: number): number {
  if (typeof value !== "string" && typeof value !== "number") throw new Error("INVALID_FEE");
  const text = String(value);
  if (!/^\d+(\.\d+)?$/.test(text)) throw new Error("INVALID_FEE");
  const [whole, fraction = ""] = text.split(".");
  if (fraction.slice(digits).replace(/0/g, "")) throw new Error("FEE_PRECISION_MISMATCH");
  const result = BigInt(whole!) * 10n ** BigInt(digits) + BigInt(fraction.slice(0,digits).padEnd(digits,"0") || "0");
  if (result > BigInt(Number.MAX_SAFE_INTEGER)) throw new Error("INVALID_FEE");
  return Number(result);
}
