import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { ErpIdentityContext } from "../identity/erp-access";
import { StoreNodeExecutionWorkspace } from "./store-node-execution-workspace";
import { executionActor, executionAuthority, executionIds } from "./store-node-execution.test-fixture";

describe("node execution initial render fences", () => {
  it("does not disclose task or capability facts to an anonymous or nonreader context", () => {
    const panel = <StoreNodeExecutionWorkspace accountId={executionIds.account} contextAuthority={executionAuthority} />;
    for (const html of [renderToStaticMarkup(panel), renderToStaticMarkup(<ErpIdentityContext.Provider value={{ session: { ...executionActor, permissions: ["store:manage"] }, localDevelopment: false, logout() {} }}>{panel}</ErpIdentityContext.Provider>)]) {
      expect(html).toContain("当前无本店节点任务读取权限"); expect(html).not.toContain(executionIds.execution); expect(html).not.toContain("保存并交绑定节点同步");
    }
  });
  it("waits for an independent workspace and stored-intent read instead of using parent authority as task data", () => {
    const html = renderToStaticMarkup(<ErpIdentityContext.Provider value={{ session: executionActor, localDevelopment: false, logout() {} }}>
      <StoreNodeExecutionWorkspace accountId={executionIds.account} contextAuthority={executionAuthority} /></ErpIdentityContext.Provider>);
    expect(html).toContain('aria-label="绑定节点能力同步"'); expect(html).toContain("执行依据尚未核对");
    expect(html).not.toContain("本次读取时有真实心跳"); expect(html).not.toContain(executionIds.node); expect(html).not.toContain("核对本次同步");
  });
});
