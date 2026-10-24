import type { ReactNode } from "react";
import type { Permission } from "@yummyai/authz/permissions";
import { ErpIdentityContext } from "./erp-access";

export function PersonalAccessFixture({
  permissions,
  children,
}: {
  permissions: Permission[];
  children: ReactNode;
}) {
  return (
    <ErpIdentityContext.Provider
      value={{
        session: {
          authenticated: true,
          canUseErp: true,
          userId: "019f0000-0000-7000-8000-000000000001",
          tenantId: "019f0000-0000-7000-8000-000000000002",
          displayName: "Synthetic operator",
          organizationName: "Synthetic organization",
          dataScope: "tenant",
          permissions,
        },
        localDevelopment: false,
        logout: () => {},
      }}
    >
      {children}
    </ErpIdentityContext.Provider>
  );
}
