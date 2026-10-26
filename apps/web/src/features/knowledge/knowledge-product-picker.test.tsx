import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { createEntityId } from "@yummyai/contracts";
import { Permission } from "@yummyai/authz/permissions";
import { erpSessionAuthority, type ErpSessionView } from "@yummyai/contracts/auth/session";
import { ErpIdentityContext } from "../identity/erp-access";
import { KnowledgeProductPicker } from "./knowledge-product-picker";

const person = (productRead: boolean): ErpSessionView => ({ authenticated: true, canUseErp: true, userId: createEntityId(), tenantId: createEntityId(),
  displayName: "Synthetic operator", organizationName: "Synthetic organization", dataScope: "tenant",
  permissions: [Permission.WorkflowRead, ...(productRead ? [Permission.ProductRead] : [])] });
function render(productRead: boolean) {
  const session = person(productRead);
  return renderToStaticMarkup(<ErpIdentityContext.Provider value={{ session, localDevelopment: false, logout: () => undefined }}>
    <KnowledgeProductPicker authority={erpSessionAuthority(session)} value="" enabled onChange={() => undefined} onDenied={() => undefined} />
  </ErpIdentityContext.Provider>);
}

describe("knowledge product selection starts with no expanded scope", () => {
  it("defaults to general knowledge and offers a server-backed search instead of arbitrary ID input", () => {
    const html = render(true);
    expect(html).toContain("通用知识（不限定产品）");
    expect(html).toContain("不自动选择全部产品");
    expect(html).toContain("搜索知识产品");
    expect(html).not.toContain("产品 ID");
  });

  it("leaves general knowledge available without claiming any product candidates when ProductRead is absent", () => {
    const html = render(false);
    expect(html).toContain("当前未读取产品候选");
    expect(html).toContain("仍可按原权限核对通用知识");
    expect(html).toContain("通用知识（不限定产品）");
    expect(html).not.toContain("本次返回");
  });
});
