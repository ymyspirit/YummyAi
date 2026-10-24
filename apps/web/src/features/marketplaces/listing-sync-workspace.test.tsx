import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { ErpIdentityContext } from "../identity/erp-access";
import { ListingSyncWorkspace } from "./listing-sync-workspace";
import { ListingSyncReceipt } from "./listing-sync-receipt";
import { syncActor, syncIds, syncView } from "./listing-sync.test-fixture";

describe("Listing sync render boundaries", () => {
  it("does not show saved source facts or a new submission before an independent current personal workspace read", () => {
    const panel = <ListingSyncWorkspace listingId={syncIds.listing} listingVersionId={syncIds.version} />;
    const anonymous = renderToStaticMarkup(panel); expect(anonymous).toContain("当前无原刊登同步读取权限");
    expect(anonymous).not.toContain("保存原同步任务");
    const personal = renderToStaticMarkup(<ErpIdentityContext.Provider value={{ session: syncActor, localDevelopment: false, logout() {} }}>{panel}</ErpIdentityContext.Provider>);
    expect(personal).toContain("正在核对本人原同步依据"); expect(personal).not.toContain("SYNTHETIC-ORIGINAL-SKU"); expect(personal).not.toContain("保存原同步任务");
  });
  it("shows complete original IDs, fixed versions and zero inventory while distinguishing unavailable snapshots and saved-only queue status", () => {
    const request = syncView(); request.current.status = "queued"; request.current.snapshot!.price = null;
    const html = renderToStaticMarkup(<ListingSyncReceipt request={request} events={null} busy={false} onRefresh={() => {}} onReadEvents={() => {}} />);
    for (const id of [syncIds.request, syncIds.listing, syncIds.version, syncIds.source]) expect(html).toContain(id);
    expect(html).toContain("不承诺已入队派发或平台已接受"); expect(html).toContain("未提供 不等于 0"); expect(html).toContain("quantity"); expect(html).toContain("0");
    expect(html).toContain(request.desiredChecksum); expect(html).toContain(request.current.snapshotChecksum!); expect(html).toContain("尚未读取原事件历史");
  });
});
