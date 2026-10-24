import type { ReactNode } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { Permission, type Permission as PermissionValue } from "@yummyai/authz/permissions";
import type { ErpSessionView } from "@yummyai/contracts/auth/session";
import { ErpIdentityContext, useErpAccess } from "./erp-access";
import { ProductCreatePanel } from "../products/product-create-panel";
import { ProductDevelopmentActions } from "../products/product-development-actions";
import { ProductEditor } from "../products/product-editor";

const session = (permissions: PermissionValue[]): ErpSessionView => ({
  authenticated: true,
  canUseErp: true,
  userId: "019f0000-0000-7000-8000-000000000001",
  tenantId: "019f0000-0000-7000-8000-000000000002",
  displayName: "Synthetic reader",
  organizationName: "Synthetic organization",
  dataScope: "tenant",
  permissions,
});
function person(permissions: PermissionValue[], children: ReactNode) {
  return (
    <ErpIdentityContext.Provider
      value={{ session: session(permissions), localDevelopment: false, logout: () => {} }}
    >
      {children}
    </ErpIdentityContext.Provider>
  );
}
function Probe() {
  const { can, canAll } = useErpAccess();
  return (
    <span>
      {JSON.stringify({
        write: can(Permission.ProductWrite),
        review: canAll([Permission.ProductWrite, Permission.DesignReview]),
        empty: canAll([]),
      })}
    </span>
  );
}
const plan = {
  id: "019f0000-0000-7000-8000-000000000003",
  name: "Synthetic plan",
  status: "researching" as const,
  sourceReportIds: [],
  customization: {
    version: 1,
    fields: [{ key: "buyer_name", label: "姓名", type: "short_text" as const, required: true }],
  },
};
describe("current-session UI access", () => {
  it("does not treat a missing provider or absent session as developer authority", () => {
    expect(renderToStaticMarkup(<ProductCreatePanel />)).toBe("");
    expect(
      renderToStaticMarkup(
        <ErpIdentityContext.Provider
          value={{ session: null, localDevelopment: false, logout: () => {} }}
        >
          <ProductCreatePanel />
        </ErpIdentityContext.Provider>,
      ),
    ).toBe("");
  });
  it("keeps product facts readable without offering create, development or schema writes", () => {
    const html = renderToStaticMarkup(
      person(
        [Permission.ProductRead],
        <>
          <ProductCreatePanel />
          <ProductDevelopmentActions plan={plan} />
          <ProductEditor initialPlan={plan} />
        </>,
      ),
    );
    expect(html).toContain("Synthetic plan");
    expect(html).toContain("当前账户只读");
    expect(html).toContain("姓名");
    for (const label of ["创建产品企划", "提交立项审核", "保存产品计划", "添加字段", "删除字段"])
      expect(html).not.toContain(label);
    expect(html).toMatch(/readonly=""/i);
  });
  it("offers original write flows only when the personal role grants product write", () => {
    const html = renderToStaticMarkup(
      person(
        [Permission.ProductRead, Permission.ProductWrite],
        <>
          <ProductCreatePanel />
          <ProductDevelopmentActions plan={plan} />
          <ProductEditor initialPlan={plan} />
        </>,
      ),
    );
    for (const label of ["创建产品企划", "提交立项审核", "保存产品计划", "添加字段"])
      expect(html).toContain(label);
  });
  it("requires every permission in a composite operation and never treats an empty policy as a grant", () => {
    const writeOnly = renderToStaticMarkup(person([Permission.ProductWrite], <Probe />));
    expect(writeOnly).toContain("&quot;write&quot;:true");
    expect(writeOnly).toContain("&quot;review&quot;:false");
    expect(writeOnly).toContain("&quot;empty&quot;:false");
    expect(
      renderToStaticMarkup(person([Permission.ProductWrite, Permission.DesignReview], <Probe />)),
    ).toContain("&quot;review&quot;:true");
  });
  it("preserves an explicitly supplied loopback developer context without inventing a personal session", () => {
    const html = renderToStaticMarkup(
      <ErpIdentityContext.Provider
        value={{ session: null, localDevelopment: true, logout: () => {} }}
      >
        <ProductCreatePanel />
      </ErpIdentityContext.Provider>,
    );
    expect(html).toContain("创建产品企划");
  });

  it("keeps creation available while another owner's plan is read-only under a self write grant", () => {
    const mixed = {
      ...session([Permission.ProductRead, Permission.ProductWrite]),
      permissionScopes: {
        [Permission.ProductRead]: "tenant" as const,
        [Permission.ProductWrite]: "self" as const,
      },
    };
    const html = renderToStaticMarkup(
      <ErpIdentityContext.Provider
        value={{ session: mixed, localDevelopment: false, logout: () => {} }}
      >
        <ProductCreatePanel />
        <ProductEditor
          initialPlan={{ ...plan, ownerUserId: "019f0000-0000-7000-8000-000000000099" }}
        />
        <ProductDevelopmentActions
          plan={{ ...plan, ownerUserId: "019f0000-0000-7000-8000-000000000099" }}
        />
      </ErpIdentityContext.Provider>,
    );
    expect(html).toContain("创建产品企划");
    for (const label of ["提交立项审核", "保存产品计划", "添加字段"])
      expect(html).not.toContain(label);
  });
});
