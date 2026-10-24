import type { ReactNode } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { Permission } from "@yummyai/authz/permissions";
import type { ErpSessionView } from "@yummyai/contracts/auth/session";
import { ErpIdentityContext } from "../identity/erp-access";
import { StoreNodeWorkspace } from "./store-node-workspace";
import { nodeActor, nodeAuthority, nodeIds } from "./store-node.test-fixture";

const person = (session: ErpSessionView | null, content: ReactNode) => <ErpIdentityContext.Provider value={{ session, localDevelopment: false, logout() {} }}>{content}</ErpIdentityContext.Provider>;
const panel = <StoreNodeWorkspace accountId={nodeIds.account} contextAuthority={nodeAuthority} />;

// Pre-effect render boundaries only. GET, mutations, real heartbeats and secret
// lifetime still require the independent personal compiled-browser acceptance.
describe("store node initial private render", () => {
  it("does not render node facts, enrollment inputs or bundles without current StoreRead", () => {
    for (const identity of [null, { ...nodeActor, permissions: [Permission.StoreManage, Permission.StoreAuthorize] }]) {
      const html = renderToStaticMarkup(person(identity, panel));
      expect(html).toContain("当前无本店节点读取权限");
      for (const privateText of ["节点公钥 PEM", "创建一次性登记票据", "本次节点登记包", nodeIds.node]) expect(html).not.toContain(privateText);
    }
  });
  it("requires its independent node read even with a matching parent authority and all three bits", () => {
    const html = renderToStaticMarkup(person(nodeActor, panel));
    expect(html).toContain('aria-label="本店独立节点"'); expect(html).toContain("重新读取节点状态");
    expect(html).toContain("节点资料尚未核对");
    for (const priorFact of [nodeIds.node, "当前授权下有效", "创建一次性登记票据", "一次性节点登记包", 'data-private-secret="true"']) expect(html).not.toContain(priorFact);
  });
});
