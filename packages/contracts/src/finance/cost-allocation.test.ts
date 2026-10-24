import { describe, expect, it } from "vitest";
import { CalculateFinanceAllocatedProfitInputSchema, FINANCE_COST_ALLOCATION_ALGORITHM, FinanceAllocatedProfitRunViewSchema,
  FinanceCostAllocationPreviewInputSchema, FinanceCostAllocationPreviewViewSchema, FinanceCostAllocationSourceSchema,
  FinanceCostAllocationTargetListInputSchema, FinanceCostAllocationTargetSchema, FinanceCostAllocationVersionInputSchema,
  FinanceCostAllocationVersionViewSchema, financeAllocatedProfitInputIdentity, financeCostPreviewChecksumIdentity,
  financeCostRunRequestIdentity, financeCostSourceChainIdentity, financeCostTargetBasisIdentity, financeCostVersionRequestIdentity,
  normalizeFinanceCostAllocationPreviewInput, splitFinanceCostMinor } from "./cost-allocation.js";
import { buildFinanceCalculationBasis, convertFinanceMinorAmount, pinFinanceFxBasis } from "./monetary.js";

const equal = () => [{ key: "A", weight: "1" }, { key: "B", weight: "1" }, { key: "C", weight: "1" }];
const convert = (amountMinor: number) => convertFinanceMinorAmount({ amountMinor, sourceCurrency: "EUR", targetCurrency: "USD", rateNumerator: 1,
  rateDenominator: 2, rateBasis: pinFinanceFxBasis("EUR", "USD"), calculationBasis: buildFinanceCalculationBasis(["EUR", "USD"]) });

describe("explicit cost attribution conserves already-converted minor units with exact largest remainders", () => {
  it("splits 101 equally into 34, 34 and 33 with the original integer floor and exact tail evidence", () => {
    expect(splitFinanceCostMinor(101, equal())).toEqual([
      { key: "A", weight: "1", weightUnits: "1000000000", floorMinor: 33, amountMinor: 34, remainderNumerator: "2000000000", remainderDenominator: "3000000000", receivesRemainder: true },
      { key: "B", weight: "1", weightUnits: "1000000000", floorMinor: 33, amountMinor: 34, remainderNumerator: "2000000000", remainderDenominator: "3000000000", receivesRemainder: true },
      { key: "C", weight: "1", weightUnits: "1000000000", floorMinor: 33, amountMinor: 33, remainderNumerator: "2000000000", remainderDenominator: "3000000000", receivesRemainder: false },
    ]);
  });
  it("keeps zero shares explicit when one minor unit is shared by three real targets", () => {
    const result = splitFinanceCostMinor(1, equal());
    expect(result.map(row => [row.key, row.floorMinor, row.amountMinor, row.receivesRemainder])).toEqual([
      ["A", 0, 1, true], ["B", 0, 0, false], ["C", 0, 0, false],
    ]);
    expect(result.every(row => row.remainderNumerator === "1000000000" && row.remainderDenominator === "3000000000")).toBe(true);
  });
  it("breaks equal-remainder ties by ordinary ASCII key order rather than supplied order or locale collation", () => {
    const result = splitFinanceCostMinor(2, [{ key: "a", weight: "1" }, { key: "Z", weight: "1" }, { key: "A", weight: "1" }]);
    expect(result.map(row => [row.key, row.amountMinor])).toEqual([["A", 1], ["Z", 1], ["a", 0]]);
  });
  it("awards the tail to the largest fractional remainders rather than the largest weights", () => {
    expect(splitFinanceCostMinor(7, [{ key: "A", weight: "0.5" }, { key: "B", weight: "0.25" }, { key: "C", weight: "0.25" }])).toEqual([
      { key: "A", weight: "0.5", weightUnits: "500000000", floorMinor: 3, amountMinor: 3, remainderNumerator: "500000000", remainderDenominator: "1000000000", receivesRemainder: false },
      { key: "B", weight: "0.25", weightUnits: "250000000", floorMinor: 1, amountMinor: 2, remainderNumerator: "750000000", remainderDenominator: "1000000000", receivesRemainder: true },
      { key: "C", weight: "0.25", weightUnits: "250000000", floorMinor: 1, amountMinor: 2, remainderNumerator: "750000000", remainderDenominator: "1000000000", receivesRemainder: true },
    ]);
  });
  it("retains fixed nanoweight units without reducing the source weight ratio", () => {
    const result = splitFinanceCostMinor(2, [{ key: "A", weight: "0.000000001" }, { key: "B", weight: "0.000000002" }]);
    expect(result).toEqual([
      { key: "A", weight: "0.000000001", weightUnits: "1", floorMinor: 0, amountMinor: 1, remainderNumerator: "2", remainderDenominator: "3", receivesRemainder: true },
      { key: "B", weight: "0.000000002", weightUnits: "2", floorMinor: 1, amountMinor: 1, remainderNumerator: "1", remainderDenominator: "3", receivesRemainder: false },
    ]);
  });
  it("does not mistake weights differing by one nanounit for an equal-remainder tie", () => {
    const result = splitFinanceCostMinor(1, [{ key: "A", weight: "1" }, { key: "Z", weight: "1.000000001" }]);
    expect(result.map(row => [row.key, row.amountMinor, row.remainderNumerator])).toEqual([["A", 0, "1000000000"], ["Z", 1, "1000000001"]]);
    expect(result.every(row => row.remainderDenominator === "2000000001")).toBe(true);
  });
  it("returns the same full evidence after target reordering without mutating the caller's original targets", () => {
    const targets = Object.freeze([Object.freeze({ key: "C", weight: "1" }), Object.freeze({ key: "A", weight: "1" }), Object.freeze({ key: "B", weight: "1" })]);
    const before = JSON.stringify(targets), original = splitFinanceCostMinor(101, targets as unknown as Parameters<typeof splitFinanceCostMinor>[1]);
    expect(splitFinanceCostMinor(101, [...targets].reverse())).toEqual(original); expect(JSON.stringify(targets)).toBe(before);
    expect(original).toEqual(splitFinanceCostMinor(101, equal()));
  });
  it("preserves every positive-weight target even when the original converted cost is zero", () => {
    const result = splitFinanceCostMinor(0, [{ key: "A", weight: "0.000000001" }, { key: "B", weight: "2" }]);
    expect(result).toHaveLength(2);
    expect(result.map(row => [row.key, row.floorMinor, row.amountMinor, row.remainderNumerator, row.receivesRemainder])).toEqual([
      ["A", 0, 0, "0", false], ["B", 0, 0, "0", false],
    ]);
    expect(result.every(row => row.remainderDenominator === "2000000001")).toBe(true);
  });
  it("keeps a single target exact without inventing a rounding tail", () => {
    expect(splitFinanceCostMinor(Number.MAX_SAFE_INTEGER, [{ key: "order:original", weight: "0.000000001" }])).toEqual([
      { key: "order:original", weight: "0.000000001", weightUnits: "1", floorMinor: Number.MAX_SAFE_INTEGER, amountMinor: Number.MAX_SAFE_INTEGER,
        remainderNumerator: "0", remainderDenominator: "1", receivesRemainder: false },
    ]);
  });
  it("conserves the maximum safe minor amount across three equal weights", () => {
    const result = splitFinanceCostMinor(Number.MAX_SAFE_INTEGER, equal());
    expect(result.map(row => row.amountMinor)).toEqual([3002399751580331, 3002399751580330, 3002399751580330]);
    expect(result.every(row => row.floorMinor === 3002399751580330 && row.remainderNumerator === "1000000000")).toBe(true);
    expect(result.reduce((sum, row) => sum + BigInt(row.amountMinor), 0n)).toBe(BigInt(Number.MAX_SAFE_INTEGER));
  });
  it("handles the largest 21-digit integer weight plus nine fractional digits against the smallest positive weight using BigInt", () => {
    const denominator = 10n ** 30n, result = splitFinanceCostMinor(Number.MAX_SAFE_INTEGER, [
      { key: "A", weight: "999999999999999999999.999999999" }, { key: "B", weight: "0.000000001" },
    ]);
    expect(result).toEqual([
      { key: "A", weight: "999999999999999999999.999999999", weightUnits: (denominator - 1n).toString(), floorMinor: Number.MAX_SAFE_INTEGER - 1,
        amountMinor: Number.MAX_SAFE_INTEGER, remainderNumerator: (denominator - BigInt(Number.MAX_SAFE_INTEGER)).toString(), remainderDenominator: denominator.toString(), receivesRemainder: true },
      { key: "B", weight: "0.000000001", weightUnits: "1", floorMinor: 0, amountMinor: 0, remainderNumerator: String(Number.MAX_SAFE_INTEGER),
        remainderDenominator: denominator.toString(), receivesRemainder: false },
    ]);
  });
  it("converts the original fact once before splitting so individual share rounding cannot duplicate one converted minor unit", () => {
    const original = convert(2); expect(original).toEqual({ amountMinor: 1, problem: null });
    const result = splitFinanceCostMinor(original.amountMinor!, [{ key: "A", weight: "1" }, { key: "B", weight: "1" }]);
    expect(result.map(row => row.amountMinor)).toEqual([1, 0]);
    expect(result.reduce((sum, row) => sum + row.amountMinor, 0)).toBe(original.amountMinor);
    // Two separately rounded half-minor source shares would incorrectly become
    // two reporting minor units. Attribution must preserve the original one.
    expect(convert(1).amountMinor! + convert(1).amountMinor!).toBe(2);
  });
  it("preserves an original reversal's direction by mirroring the same nonnegative split instead of allocating a negative principal", () => {
    const source = splitFinanceCostMinor(101, equal()), reversal = splitFinanceCostMinor(101, equal());
    expect(reversal).toEqual(source);
    expect(source.map((row, index) => BigInt(row.amountMinor) - BigInt(reversal[index]!.amountMinor))).toEqual([0n, 0n, 0n]);
    expect(() => splitFinanceCostMinor(-101, equal())).toThrow();
  });
  it("accepts exactly 1000 explicit targets while retaining their zero shares and canonical key ordering", () => {
    const targets = Array.from({ length: 1000 }, (_, index) => ({ key: `target:${String(index).padStart(4, "0")}`, weight: "1" })).reverse();
    const result = splitFinanceCostMinor(1, targets); expect(result).toHaveLength(1000);
    expect(result[0]).toMatchObject({ key: "target:0000", amountMinor: 1, receivesRemainder: true });
    expect(result.slice(1).every(row => row.amountMinor === 0 && row.receivesRemainder === false)).toBe(true);
    expect(result.at(-1)!.key).toBe("target:0999");
  });
  it("rejects negative, fractional, non-number and unsafe amounts rather than truncating, rounding or coercing principal", () => {
    for (const amount of [-1, 0.5, Number.MAX_SAFE_INTEGER + 1, Number.NaN, Number.POSITIVE_INFINITY, Number.NEGATIVE_INFINITY, "1", null, undefined])
      expect(() => splitFinanceCostMinor(amount as number, equal())).toThrow();
  });
  it("rejects zero, noncanonical, overprecision and non-string weights without trimming or reducing the original basis", () => {
    for (const weight of ["0", "0.0", "-1", "+1", "01", "00.1", ".1", "1.", "1.0", "0.10", "1e1", " 1", "1 ",
      "0.0000000001", "1.0000000001", "1000000000000000000000", "NaN", "Infinity", 1, null, undefined])
      expect(() => splitFinanceCostMinor(1, [{ key: "A", weight: weight as string }])).toThrow();
  });
  it("requires exact unique canonical keys and refuses controls, whitespace or oversized keys", () => {
    for (const key of ["", " ", " A", "A ", "A/B", "A\nB", "A\u0000B", "_A", "中", "A".repeat(101), 1, null, undefined])
      expect(() => splitFinanceCostMinor(1, [{ key: key as string, weight: "1" }])).toThrow();
    expect(() => splitFinanceCostMinor(1, [{ key: "same", weight: "1" }, { key: "same", weight: "2" }])).toThrow();
    expect(splitFinanceCostMinor(1, [{ key: `A${"x".repeat(99)}`, weight: "1" }])).toHaveLength(1);
  });
  it("rejects an empty or excessive target collection and malformed runtime shapes", () => {
    expect(() => splitFinanceCostMinor(1, [])).toThrow();
    expect(() => splitFinanceCostMinor(1, Array.from({ length: 1001 }, (_, index) => ({ key: `T:${index}`, weight: "1" })))).toThrow();
    for (const value of [null, undefined, {}, "A", [null], [1], [{ key: "A" }], [{ weight: "1" }]])
      expect(() => splitFinanceCostMinor(1, value as Parameters<typeof splitFinanceCostMinor>[1])).toThrow();
  });
});

const dtoId = (value: number) => `019f0000-0000-7000-8000-${String(value).padStart(12, "0")}`;
const dtoHash = "a".repeat(64), dtoAt = "2026-07-03T00:00:00.000Z";
const dtoTarget = (key = dtoId(1)) => ({ dimension: "order" as const, key, label: "Synthetic non-PII target", orderId: key, orderLineId: null,
  skuId: null, listingId: null, accountId: null, spuId: null, catalogLinkId: null, period: null, periodStart: null, periodEnd: null, basisChecksum: dtoHash });
const dtoInput = () => ({ baseRunId: dtoId(10), baseInputChecksum: dtoHash, allocationId: null, expectedVersion: null, dimension: "order" as const,
  method: "equal" as const, sources: [{ rootFactId: dtoId(11), targets: [{ key: dtoId(1), weight: "1" }, { key: dtoId(2), weight: "1" }] }],
  reasonCode: "SYNTHETIC", basisDescription: "Operator-recorded allocation basis" });
const dtoSource = () => ({ rootFactId: dtoId(11), contributionId: dtoId(12), factId: dtoId(11), statementId: dtoId(13), statementChecksum: dtoHash,
  sourceEntryId: "synthetic:original:cost", factType: "production_cost", effectSign: 1, sourceCurrency: "USD", sourceAmountMinor: 101,
  reportingCurrency: "USD", reportingAmountMinor: 101, fxRateId: null, sourceChainChecksum: dtoHash,
  shares: splitFinanceCostMinor(101, dtoInput().sources[0]!.targets).map(({ key, ...share }) => ({ target: dtoTarget(key), ...share })) });
const dtoPreview = () => ({ ...dtoInput(), algorithm: FINANCE_COST_ALLOCATION_ALGORITHM, reportingCurrency: "USD", sources: [dtoSource()], previewChecksum: dtoHash });

describe("allocation DTO and identity keep actual source, target and approved version pins", () => {
  it("requires an exact prior allocation version for an append and prevents caller-supplied approval or tenant authority", () => {
    expect(FinanceCostAllocationPreviewInputSchema.safeParse(dtoInput()).success).toBe(true);
    expect(FinanceCostAllocationPreviewInputSchema.safeParse({ ...dtoInput(), allocationId: dtoId(20), expectedVersion: 1 }).success).toBe(true);
    for (const extra of [{ allocationId: dtoId(20) }, { expectedVersion: 1 }, { reviewedBy: dtoId(30) }, { tenantId: dtoId(30) }, { approved: true }, { status: "approved" }])
      expect(FinanceCostAllocationPreviewInputSchema.safeParse({ ...dtoInput(), ...extra }).success).toBe(false);
    expect(FinanceCostAllocationVersionInputSchema.safeParse({ ...dtoInput(), previewChecksum: dtoHash, idempotencyKey: "synthetic-approval-original" }).success).toBe(true);
    expect(FinanceCostAllocationVersionInputSchema.safeParse({ ...dtoInput(), idempotencyKey: "synthetic-approval-original" }).success).toBe(false);
  });
  it("keeps equal allocation weights fixed at one and rejects duplicate roots or duplicate normalized target identities", () => {
    const original = dtoInput(), family = original.sources[0]!;
    expect(FinanceCostAllocationPreviewInputSchema.safeParse({ ...original, sources: [family, family] }).success).toBe(false);
    expect(FinanceCostAllocationPreviewInputSchema.safeParse({ ...original, sources: [{ ...family, targets: [{ key: dtoId(1), weight: "1" }, { key: dtoId(1).toUpperCase(), weight: "1" }] }] }).success).toBe(false);
    expect(FinanceCostAllocationPreviewInputSchema.safeParse({ ...original, sources: [{ ...family, targets: [{ key: dtoId(1), weight: "2" }] }] }).success).toBe(false);
    expect(FinanceCostAllocationPreviewInputSchema.safeParse({ ...original, method: "manual_weights", sources: [{ ...family, targets: [{ key: dtoId(1), weight: "0.000000001" }] }] }).success).toBe(true);
  });
  it("binds target key format to its dimension and requires an explicit valid UTC month", () => {
    expect(FinanceCostAllocationTargetListInputSchema.safeParse({ dimension: "period" }).success).toBe(false);
    for (const key of ["2026-00", "2026-13", "0000-01", "9999-12", dtoId(1)])
      expect(FinanceCostAllocationTargetListInputSchema.safeParse({ dimension: "period", key }).success).toBe(false);
    expect(FinanceCostAllocationTargetListInputSchema.parse({ dimension: "period", key: "2026-07" }).key).toBe("2026-07");
    expect(FinanceCostAllocationTargetListInputSchema.safeParse({ dimension: "order", key: "2026-07" }).success).toBe(false);
    const period = { ...dtoTarget(), dimension: "period", key: "2026-07", orderId: null, period: "2026-07", periodStart: "2026-07-01T00:00:00.000Z", periodEnd: "2026-08-01T00:00:00.000Z" };
    expect(FinanceCostAllocationTargetSchema.safeParse(period).success).toBe(true);
    expect(FinanceCostAllocationTargetSchema.safeParse({ ...period, periodEnd: "2026-07-31T23:59:59.999Z" }).success).toBe(false);
    expect(FinanceCostAllocationTargetSchema.safeParse({ ...dtoTarget(), period: "2026-07" }).success).toBe(false);
  });
  it("rejects missing or substituted order-line lineage without accepting a caller's free-form mapping", () => {
    const line = { ...dtoTarget(), dimension: "order_line", key: dtoId(2), orderLineId: dtoId(2) };
    expect(FinanceCostAllocationTargetSchema.safeParse(line).success).toBe(true);
    expect(FinanceCostAllocationTargetSchema.safeParse({ ...line, orderId: null }).success).toBe(false);
    expect(FinanceCostAllocationTargetSchema.safeParse({ ...line, key: dtoId(3) }).success).toBe(false);
    expect(FinanceCostAllocationPreviewInputSchema.safeParse({ ...dtoInput(), sources: [{ rootFactId: dtoId(11), targets: [{ ...dtoTarget(), weight: "1" }] }] }).success).toBe(false);
  });
  it("recomputes every source share receipt and rejects altered floors, tails, denominators or amounts even when the displayed total still balances", () => {
    expect(FinanceCostAllocationSourceSchema.safeParse(dtoSource()).success).toBe(true);
    const original = dtoSource();
    for (const changed of [{ amountMinor: 50 }, { floorMinor: 49 }, { weightUnits: "1" }, { remainderNumerator: "0" }, { remainderDenominator: "2" }, { receivesRemainder: false }])
      expect(FinanceCostAllocationSourceSchema.safeParse({ ...original, shares: [{ ...original.shares[0]!, ...changed }, original.shares[1]!] }).success).toBe(false);
    expect(FinanceCostAllocationSourceSchema.safeParse({ ...original, shares: [original.shares[1], original.shares[0]] }).success).toBe(true);
    expect(FinanceCostAllocationSourceSchema.safeParse({ ...original, shares: [original.shares[0], original.shares[0]] }).success).toBe(false);
  });
  it("keeps preview contributions unique and rejects changed reporting currency, dimension or a fabricated pending approval status", () => {
    const preview = dtoPreview(); expect(FinanceCostAllocationPreviewViewSchema.safeParse(preview).success).toBe(true);
    expect(FinanceCostAllocationPreviewViewSchema.safeParse({ ...preview, sources: [...preview.sources, ...preview.sources] }).success).toBe(false);
    expect(FinanceCostAllocationPreviewViewSchema.safeParse({ ...preview, reportingCurrency: "JPY" }).success).toBe(false);
    expect(FinanceCostAllocationPreviewViewSchema.safeParse({ ...preview, dimension: "sku" }).success).toBe(false);
    const version = { id: dtoId(20), allocationId: dtoId(20), versionNumber: 1, previousVersionId: null, status: "approved", preview,
      checksum: dtoHash, reviewedBy: dtoId(30), createdAt: dtoAt, basisProblems: [] };
    expect(FinanceCostAllocationVersionViewSchema.safeParse(version).success).toBe(true);
    expect(FinanceCostAllocationVersionViewSchema.safeParse({ ...version, status: "pending" }).success).toBe(false);
  });
  it("does not claim complete target profit while any original contribution remains unallocated or any required cost is missing", () => {
    const original = { id: dtoId(40), baseRunId: dtoId(10), baseInputChecksum: dtoHash, dimension: "order", versionPins: [], algorithm: FINANCE_COST_ALLOCATION_ALGORITHM,
      reportingCurrency: "USD", status: "incomplete", revenueMinor: null, costMinor: null, profitMinor: null, marginBps: null,
      diagnostics: { unallocatedContributionIds: [dtoId(12)], checkedTargetCount: 1, missingByTarget: [] }, breakdowns: [], inputChecksum: dtoHash, createdAt: dtoAt, basisProblems: [] };
    expect(FinanceAllocatedProfitRunViewSchema.safeParse(original).success).toBe(true);
    expect(FinanceAllocatedProfitRunViewSchema.safeParse({ ...original, status: "complete", revenueMinor: 1000, costMinor: 101, profitMinor: 899 }).success).toBe(false);
    expect(FinanceAllocatedProfitRunViewSchema.safeParse({ ...original, revenueMinor: 0 }).success).toBe(false);
    expect(FinanceAllocatedProfitRunViewSchema.safeParse({ ...original, diagnostics: { unallocatedContributionIds: [], checkedTargetCount: 1, missingByTarget: [{ key: dtoId(1), missingFactTypes: ["production_cost"] }] } }).success).toBe(true);
  });
  it("normalizes source and target input order while preserving case-sensitive recorded basis text and exact weights", () => {
    const original = dtoInput(), family = original.sources[0]!, second = { ...family, rootFactId: dtoId(14) };
    const forward = normalizeFinanceCostAllocationPreviewInput({ ...original, sources: [family, second] });
    expect(normalizeFinanceCostAllocationPreviewInput({ ...original, sources: [{ ...second, targets: [...second.targets].reverse() }, { ...family, targets: [...family.targets].reverse() }] })).toEqual(forward);
    const version = { ...original, previewChecksum: dtoHash, idempotencyKey: "synthetic-approved-original" };
    expect(financeCostVersionRequestIdentity(version)).not.toEqual(financeCostVersionRequestIdentity({ ...version, basisDescription: "Changed actual basis" }));
    expect(financeCostVersionRequestIdentity(version)).not.toEqual(financeCostVersionRequestIdentity({ ...version, baseInputChecksum: "b".repeat(64) }));
    expect(financeCostVersionRequestIdentity(version)).not.toEqual(financeCostVersionRequestIdentity({ ...version, idempotencyKey: "another-original-request" }));
  });
  it("binds run identity to its actual original base and version set without depending on supplied array order", () => {
    const input = { baseRunId: dtoId(10), baseInputChecksum: dtoHash, dimension: "order" as const, versionIds: [dtoId(20), dtoId(21)], idempotencyKey: "synthetic-projection-original" };
    expect(financeCostRunRequestIdentity({ ...input, versionIds: [...input.versionIds].reverse() })).toEqual(financeCostRunRequestIdentity(input));
    expect(CalculateFinanceAllocatedProfitInputSchema.safeParse({ ...input, versionIds: [dtoId(20), dtoId(20)] }).success).toBe(false);
    const pin = { id: dtoId(20), allocationId: dtoId(22), versionNumber: 1, checksum: dtoHash }, basis = { ...input, versionPins: [pin] };
    expect(financeAllocatedProfitInputIdentity(basis)).not.toEqual(financeAllocatedProfitInputIdentity({ ...basis, versionPins: [{ ...pin, checksum: "b".repeat(64) }] }));
  });
  it("excludes a target's display label from its identity while retaining every actual order, account and catalog relationship", () => {
    const target = dtoTarget(); expect(financeCostTargetBasisIdentity({ ...target, label: "Renamed display only" })).toEqual(financeCostTargetBasisIdentity(target));
    for (const changed of [{ orderId: dtoId(3) }, { accountId: dtoId(4) }, { catalogLinkId: dtoId(5) }, { spuId: dtoId(6) }])
      expect(financeCostTargetBasisIdentity({ ...target, ...changed })).not.toEqual(financeCostTargetBasisIdentity(target));
  });
  it("normalizes full preview and correction-chain evidence order without dropping original statement checksums", () => {
    const preview = dtoPreview(), reordered = { ...preview, sources: [{ ...preview.sources[0]!, shares: [...preview.sources[0]!.shares].reverse() }] };
    expect(financeCostPreviewChecksumIdentity(reordered as Parameters<typeof financeCostPreviewChecksumIdentity>[0])).toEqual(financeCostPreviewChecksumIdentity(preview as Parameters<typeof financeCostPreviewChecksumIdentity>[0]));
    const facts = [{ id: dtoId(11), statementId: dtoId(13), statementChecksum: dtoHash, correctionKind: "original", correctsFactId: null },
      { id: dtoId(14), statementId: dtoId(15), statementChecksum: dtoHash, correctionKind: "reversal", correctsFactId: dtoId(11) }];
    expect(financeCostSourceChainIdentity(dtoId(11), [...facts].reverse())).toEqual(financeCostSourceChainIdentity(dtoId(11), facts));
    expect(financeCostSourceChainIdentity(dtoId(11), [{ ...facts[0]!, statementChecksum: "b".repeat(64) }, facts[1]!])).not.toEqual(financeCostSourceChainIdentity(dtoId(11), facts));
  });
});
