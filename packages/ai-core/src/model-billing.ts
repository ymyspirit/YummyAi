/** The existing budget ledger uses six decimals. Preserve exact evidence at eight. */
export function modelBillingBudgetAmount(confirmedUsd: string): string {
  if (!/^(0|[1-9]\d{0,7})\.\d{8}$/.test(confirmedUsd))
    throw new Error("MODEL_BILLING_AMOUNT_INVALID");
  const units = BigInt(confirmedUsd.replace(".", "")),
    micros = (units + 99n) / 100n;
  if (micros > 99999999999999n) throw new Error("MODEL_BILLING_AMOUNT_INVALID");
  return (micros / 1000000n).toString() + "." + (micros % 1000000n).toString().padStart(6, "0");
}
