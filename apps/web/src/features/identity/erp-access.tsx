"use client";

import { createContext, useContext } from "react";
import type { ErpSessionView } from "@yummyai/contracts/auth/session";
import { erpSessionAuthority } from "@yummyai/contracts/auth/session";
import type { Permission } from "@yummyai/authz/permissions";
import { authorize, permissionScope, type AuthorizedResource } from "@yummyai/authz/authorize";

export const ErpIdentityContext = createContext<{
  session: ErpSessionView | null;
  localDevelopment: boolean;
  logout: () => void;
} | null>(null);

/** Controls mirror the current server session; each command still authorizes at its API owner. */
export function useErpAccess() {
  const identity = useContext(ErpIdentityContext);
  const can = (permission: Permission, resource?: AuthorizedResource) => {
    if (identity?.localDevelopment === true) return true;
    if (!identity?.session) return false;
    try {
      authorize(identity.session, permission, resource);
      return true;
    } catch {
      return false;
    }
  };
  return {
    can,
    preferenceScope: identity?.session
      ? `${identity.session.tenantId}:${identity.session.userId}`
      : null,
    authority:
      identity?.localDevelopment === true
        ? "local-development"
        : identity?.session
          ? erpSessionAuthority(identity.session)
          : null,
    localDevelopment: identity?.localDevelopment === true,
    canTenant: (permission: Permission) =>
      identity?.localDevelopment === true ||
      Boolean(
        identity?.session &&
        can(permission) &&
        permissionScope(identity.session, permission) === "tenant",
      ),
    canAll: (permissions: readonly Permission[], resource?: AuthorizedResource) =>
      permissions.length > 0 && permissions.every((permission) => can(permission, resource)),
  };
}
