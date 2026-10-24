import { renderToStaticMarkup } from "react-dom/server";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { Permission } from "@yummyai/authz/permissions";
import { erpSessionAuthority, type ErpSessionView } from "@yummyai/contracts/auth/session";
import { AdvertisingWorkspaceSchema, type AdvertisingWorkspace } from "@yummyai/contracts/advertising";
import { ErpIdentityContext } from "../identity/erp-access";
const navigation = vi.hoisted(() => ({ query: "account=019b0000-0000-7000-8000-000000000001&tab=imports" }));
vi.mock("next/navigation", () => ({ useSearchParams: () => new URLSearchParams(navigation.query) }));
import { AdvertisingWorkbench } from "./advertising-workbench";

const account = "019b0000-0000-7000-8000-000000000001", other = "019b0000-0000-7000-8000-000000000002", at = "2026-09-16T18:00:00.000Z";
const session = (rights: string[] = [Permission.CustomerIntelligenceRead]): ErpSessionView => ({ authenticated: true, canUseErp: true,
  tenantId: "019b0000-0000-7000-8000-000000000003", userId: "019b0000-0000-7000-8000-000000000004", displayName: "Synthetic operator",
  organizationName: "Synthetic organization", permissions: rights, dataScope: "tenant" });
function workspace(identity = session()): AdvertisingWorkspace {
  const access = { canRead: identity.permissions.includes(Permission.CustomerIntelligenceRead), canWrite: identity.permissions.includes(Permission.CustomerIntelligenceWrite),
    canReview: identity.permissions.includes(Permission.CustomerIntelligenceReview) };
  return AdvertisingWorkspaceSchema.parse({ accountId: account, contextAuthority: erpSessionAuthority(identity), access,
    accounts: [{ id: account, name: "Synthetic private advertising account", marketplaceIds: ["ATVPDKIKX0DER"], status: "pending", access }],
    imports: access.canRead ? [{ id: "019b0000-0000-7000-8000-000000000005", accountId: account, fileName: "SYNTHETIC-PRIVATE-ORIGINAL.csv", checksum: "a".repeat(64),
      periodStart: "2026-09-01", periodEnd: "2026-09-15", reportType: "campaign", timezone: "America/Los_Angeles", attributionWindowDays: 7, attributionBasis: "click",
      observedAt: at, recordedAt: at, sourceRowCount: 1, acceptedRowCount: 1, rejectedRowCount: 0, diagnostics: [], archivedAt: null }] : [],
    goals: [], observations: [], actions: [], analyses: [] });
}
const render = (value: AdvertisingWorkspace, identity: ErpSessionView) => renderToStaticMarkup(
  <ErpIdentityContext.Provider value={{ session: identity, localDevelopment: false, logout() {} }}>
    <AdvertisingWorkbench initialData={value} vocData={null} />
  </ErpIdentityContext.Provider>);
beforeEach(() => { navigation.query = `account=${account}&tab=imports`; });

describe("advertising initial server props stay within their actual personal authority", () => {
  it("renders actual Read-only source metadata while withholding import and review writes", () => {
    const html = render(workspace(), session());
    expect(html).toContain("SYNTHETIC-PRIVATE-ORIGINAL.csv"); expect(html).toContain("America/Los_Angeles"); expect(html).toContain("click");
    expect(html).toContain("广告导入历史"); expect(html).not.toContain(">运行分析</button>"); expect(html).not.toContain("导入广告 CSV");
    expect(html).not.toContain("保存目标版本"); expect(html).not.toContain("归档这份来源");
  });
  it("does not render another actor's late initial source props", () => {
    const html = render(workspace(), { ...session(), userId: other });
    expect(html).not.toContain("SYNTHETIC-PRIVATE-ORIGINAL.csv"); expect(html).not.toContain("America/Los_Angeles"); expect(html).not.toContain("广告导入历史");
    expect(html).not.toContain("Synthetic private advertising account");
  });
  it("does not reuse a formerly readable initial snapshot after the same member's authority changes", () => {
    const html = render(workspace(), session([Permission.ProductRead, Permission.CustomerIntelligenceReview]));
    expect(html).not.toContain("SYNTHETIC-PRIVATE-ORIGINAL.csv"); expect(html).not.toContain("广告导入历史"); expect(html).not.toContain("归档这份来源");
  });
  it("does not render old account source props as the currently selected different account", () => {
    navigation.query = `account=${other}&tab=imports`; const html = render(workspace(), session());
    expect(html).not.toContain("SYNTHETIC-PRIVATE-ORIGINAL.csv"); expect(html).not.toContain("广告导入历史"); expect(html).not.toContain("America/Los_Angeles");
  });
  it("keeps Write-only and Review-only discovery explicit without manufacturing readable history", () => {
    for (const permission of [Permission.CustomerIntelligenceWrite, Permission.CustomerIntelligenceReview]) {
      const identity = session([permission]), html = render(workspace(identity), identity);
      expect(html).toContain("当前没有此店铺的广告读取权限"); expect(html).not.toContain("广告导入历史"); expect(html).not.toContain("SYNTHETIC-PRIVATE");
    }
  });
});
