import { describe, expect, it } from "vitest";
import { erpSessionAuthority } from "@yummyai/contracts/auth/session";
import {
  AdGoalFieldsSchema,
  AdObservationInputSchema,
  AdImportInputSchema,
  AdAccessSchema,
  AdCommitImportResultSchema,
  AdFactPageSchema,
  AdWorkspaceQuerySchema,
  AdEmptyQuerySchema,
  AdvertisingWorkspaceSchema,
} from "./advertising-workbench.js";

const fields = {
  mode: "profit_defense",
  effectiveFrom: "2026-10-08",
  targetAcosBps: null,
  unitPriceMinor: null,
  unitCostMinor: null,
  coreKeywords: [],
  protectedTerms: [],
  trialEndDate: null,
  trialSpendLimitMinor: null,
};
describe("advertising business boundaries", () => {
  it("allows profit configuration with explicit missing economics rather than invented defaults", () => {
    const parsed = AdGoalFieldsSchema.parse(fields);
    expect(parsed.targetAcosBps).toBeNull();
    expect(parsed.unitCostMinor).toBeNull();
  });
  it("requires bounded rank experiments and keeps effective dates ordered", () => {
    expect(AdGoalFieldsSchema.safeParse({ ...fields, mode: "rank_growth" }).success).toBe(false);
    const growth = {
      ...fields,
      mode: "rank_growth",
      coreKeywords: ["custom pillow"],
      trialEndDate: "2026-10-22",
      trialSpendLimitMinor: 14000,
    };
    expect(AdGoalFieldsSchema.safeParse(growth).success).toBe(true);
    expect(AdGoalFieldsSchema.safeParse({ ...growth, trialEndDate: "2026-10-01" }).success).toBe(
      false,
    );
    expect(
      AdGoalFieldsSchema.safeParse({ ...growth, coreKeywords: ["Custom Pillow", "custom pillow"] })
        .success,
    ).toBe(false);
  });
  it("requires source-qualified organic ranks and complete commerce fields", () => {
    const base = {
      scope: {
        accountId: "01999999-0000-7000-8000-000000000001",
        marketplace: "US",
        currency: "USD",
        asin: "B012345678",
      },
      kind: "organic_rank",
      periodStart: "2026-10-08",
      periodEnd: "2026-10-08",
      source: "manual check",
      keyword: "custom pillow",
      organicRank: 8,
      totalSalesMinor: null,
      totalPurchases: null,
      preAdContributionMinor: null,
      observedAt: "2026-10-08T10:00:00Z",
      idempotencyKey: "rank-check-001",
    };
    expect(AdObservationInputSchema.safeParse(base).success).toBe(true);
    expect(AdObservationInputSchema.safeParse({ ...base, totalPurchases: 10 }).success).toBe(false);
    expect(AdObservationInputSchema.safeParse({ ...base, periodEnd: "2026-10-09" }).success).toBe(
      false,
    );
    expect(
      AdObservationInputSchema.safeParse({
        ...base,
        kind: "commerce",
        keyword: null,
        organicRank: null,
        totalSalesMinor: 10000,
        totalPurchases: 5,
      }).success,
    ).toBe(true);
  });
  it("does not accept arbitrary timezones or assume a report's attribution window", () => {
    const base = {
      accountId: "01999999-0000-7000-8000-000000000001",
      marketplaceByCurrency: { USD: "US" },
      timezone: "America/Los_Angeles",
      attributionWindowDays: null,
      attributionBasis: "unknown",
      observedAt: "2026-10-08T10:00:00Z",
      files: [{ fileName: "campaign.csv", content: "a,b\n1,2" }],
      idempotencyKey: "import-001",
    };
    expect(AdImportInputSchema.parse(base).attributionWindowDays).toBeNull();
    expect(AdImportInputSchema.safeParse({ ...base, timezone: "invalid/zone" }).success).toBe(
      false,
    );
    expect(
      AdImportInputSchema.safeParse({
        ...base,
        files: [{ fileName: "../secret.csv", content: "a,b" }],
      }).success,
    ).toBe(false);
  });
});

const accountId = "01999999-0000-7000-8000-000000000001";
const otherAccountId = "01999999-0000-7000-8000-000000000002";
const authority = erpSessionAuthority({ tenantId: "01999999-0000-7000-8000-000000000010", userId: "01999999-0000-7000-8000-000000000011",
  permissions: ["customer_intelligence:read"], dataScope: "tenant" });
const readAccess = { canRead: true, canWrite: false, canReview: false };
const importView = () => ({
  id: "01999999-0000-7000-8000-000000000003", accountId,
  fileName: "synthetic-campaign.csv", checksum: "b".repeat(64),
  periodStart: "2026-09-01", periodEnd: "2026-09-15", reportType: "campaign",
  timezone: "America/Los_Angeles", attributionWindowDays: 7, attributionBasis: "click",
  observedAt: "2026-09-16T18:00:00.000Z", recordedAt: "2026-10-21T00:00:00.000Z",
  sourceRowCount: 1, acceptedRowCount: 1, rejectedRowCount: 0, diagnostics: [], archivedAt: null,
});
const workspace = () => ({
  accountId, contextAuthority: authority, access: readAccess,
  accounts: [{ id: accountId, name: "Synthetic owned advertising account", marketplaceIds: ["ATVPDKIKX0DER"], status: "pending", access: readAccess }],
  imports: [importView()], goals: [], observations: [], actions: [], analyses: [],
});
const factPage = () => ({
  accountId, contextAuthority: authority, count: 1, page: 1, pageSize: 1,
  rows: [{
    id: "01999999-0000-7000-8000-000000000004", importId: importView().id, accountId,
    observedAt: importView().observedAt, recordedAt: importView().recordedAt,
    timezone: importView().timezone, attributionWindowDays: 7, attributionBasis: "click",
    fact: {
      sourceRow: 1, rowKey: "c".repeat(64), entityKey: "d".repeat(64), reportType: "campaign", adProduct: "SP",
      advertiserId: "synthetic-advertiser", currency: "USD", marketplace: "US",
      periodStart: "2026-09-01", periodEnd: "2026-09-15", grain: "interval",
      campaignId: "synthetic-campaign", campaignName: null, adGroupId: null, adGroupName: null,
      asin: null, productName: null, term: null, targetId: null, matchType: null, bidMinor: null,
      status: null, placement: null, metrics: { impressions: 1000, clicks: 40, purchases: 4, spendMinor: 1000, salesMinor: 4000 },
      dimensions: {}, sourceFields: { Currency: "USD", Spend: "10.00" }, qualityCodes: [],
    },
  }],
});

describe("advertising current authority transport", () => {
  it("requires all three explicit capabilities and rejects caller-added scope", () => {
    expect(AdAccessSchema.parse(readAccess)).toEqual(readAccess);
    expect(AdAccessSchema.safeParse({ canRead: true, canWrite: false }).success).toBe(false);
    expect(AdAccessSchema.safeParse({ ...readAccess, ownerId: accountId }).success).toBe(false);
  });
  it("requires the account selection and current authority even for an empty workspace", () => {
    expect(AdvertisingWorkspaceSchema.parse({ ...workspace(), accountId: null, accounts: [], imports: [] }).accountId).toBeNull();
    const { contextAuthority: omitted, ...missing } = workspace(); void omitted;
    expect(AdvertisingWorkspaceSchema.safeParse(missing).success).toBe(false);
    expect(AdvertisingWorkspaceSchema.safeParse({ ...workspace(), contextAuthority: "unknown" }).success).toBe(false);
    expect(AdvertisingWorkspaceSchema.safeParse({ ...workspace(), contextAuthority: "a".repeat(64) }).success).toBe(false);
    expect(AdvertisingWorkspaceSchema.safeParse({ ...workspace(), contextAuthority: JSON.stringify(JSON.parse(authority), null, 2) }).success).toBe(false);
    const { accountId: omittedAccount, ...missingAccount } = workspace(); void omittedAccount;
    expect(AdvertisingWorkspaceSchema.safeParse(missingAccount).success).toBe(false);
  });
  it("keeps Write-only and Review-only account discovery separate from private report reads", () => {
    for (const access of [{ canRead: false, canWrite: true, canReview: false }, { canRead: false, canWrite: false, canReview: true }]) {
      const value = { ...workspace(), access, accounts: [{ ...workspace().accounts[0]!, access }], imports: [] };
      expect(AdvertisingWorkspaceSchema.safeParse(value).success).toBe(true);
      expect(AdvertisingWorkspaceSchema.safeParse({ ...value, imports: [importView()] }).success).toBe(false);
    }
  });
  it("does not let an account widen the member capabilities or omit its own access", () => {
    const value = workspace();
    expect(AdvertisingWorkspaceSchema.safeParse({ ...value, accounts: [{ ...value.accounts[0]!, access: { ...readAccess, canWrite: true } }] }).success).toBe(false);
    const { access: omitted, ...account } = value.accounts[0]!; void omitted;
    expect(AdvertisingWorkspaceSchema.safeParse({ ...value, accounts: [account] }).success).toBe(false);
  });
  it("rejects duplicate accounts, an absent selected account, and data from another account", () => {
    const value = workspace();
    for (const invalid of [
      { ...value, accounts: [...value.accounts, value.accounts[0]!] },
      { ...value, accountId: otherAccountId },
      { ...value, imports: [{ ...importView(), accountId: otherAccountId }] },
    ]) expect(AdvertisingWorkspaceSchema.safeParse(invalid).success).toBe(false);
  });
  it("does not accept sibling report data while a different account is explicitly selected", () => {
    const value = workspace();
    value.accounts.push({ ...value.accounts[0]!, id: otherAccountId });
    expect(AdvertisingWorkspaceSchema.safeParse(value).success).toBe(true);
    expect(AdvertisingWorkspaceSchema.safeParse({ ...value, imports: [{ ...importView(), accountId: otherAccountId }] }).success).toBe(false);
  });
  it("binds every fact page to its actual account and current authority", () => {
    const value = factPage();
    expect(AdFactPageSchema.parse(value).rows[0]?.fact.sourceFields).toEqual({ Currency: "USD", Spend: "10.00" });
    expect(AdFactPageSchema.safeParse({ ...value, rows: [{ ...value.rows[0]!, accountId: otherAccountId }] }).success).toBe(false);
    const { contextAuthority: omitted, ...missing } = value; void omitted;
    expect(AdFactPageSchema.safeParse(missing).success).toBe(false);
  });
  it("rejects duplicate, overfull, and impossible count fact pages", () => {
    const value = factPage();
    expect(AdFactPageSchema.safeParse({ ...value, pageSize: 2, count: 2, rows: [value.rows[0]!, value.rows[0]!] }).success).toBe(false);
    expect(AdFactPageSchema.safeParse({ ...value, count: 0 }).success).toBe(false);
    expect(AdFactPageSchema.safeParse({ ...value, count: 2, rows: [value.rows[0]!, { ...value.rows[0]!, id: otherAccountId }] }).success).toBe(false);
  });
  it("keeps read queries strict without accepting client-selected authority", () => {
    expect(AdWorkspaceQuerySchema.parse({ accountId })).toEqual({ accountId });
    for (const query of [{ accountId, tenantId: otherAccountId }, { accountId, canWrite: true }, { accountId: "missing" }])
      expect(AdWorkspaceQuerySchema.safeParse(query).success).toBe(false);
    expect(AdEmptyQuerySchema.safeParse({ accountId }).success).toBe(false);
  });
  it("returns only actual commit receipts without raw object paths or fabricated replay defaults", () => {
    const value = { imports: [importView()], replayed: false };
    expect(AdCommitImportResultSchema.parse(value)).toEqual(value);
    expect(AdCommitImportResultSchema.safeParse({ imports: value.imports }).success).toBe(false);
    expect(AdCommitImportResultSchema.safeParse({ imports: [], replayed: true }).success).toBe(false);
    expect(AdCommitImportResultSchema.safeParse({ ...value, imports: [{ ...importView(), objectKey: "must-not-escape" }] }).success).toBe(false);
  });
});
