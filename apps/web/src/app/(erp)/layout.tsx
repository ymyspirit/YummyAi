import { Suspense } from "react";
import { headers } from "next/headers";
import { redirect } from "next/navigation";
import { erpAmbientIdentity } from "../../erp-auth/request";
import { erpReturnPath, localServiceAuth } from "../../web-auth-mode";
import { ErpIdentityBoundary } from "../../features/identity/erp-identity-boundary";

import { ErpBreadcrumbs } from "../../features/navigation/erp-breadcrumbs";
import { BreadcrumbDetailsProvider } from "../../features/navigation/breadcrumb-details";
import { ErpSidebar } from "../../features/navigation/erp-sidebar";
import { StudioSession } from "../../features/creative-studio/studio-session";
import { studioRuntimeUrl } from "../../features/creative-studio/studio-configuration";
import "../../features/navigation/navigation.css";
import "../../features/manual-operations/manual-operations.css";

export const dynamic = "force-dynamic";
export default async function ErpLayout({ children }: { children: React.ReactNode }) {
  let session = null;
  if (!localServiceAuth()) {
    try {
      session = (await erpAmbientIdentity()).view;
    } catch {
      const current = await headers();
      redirect(
        `/login?${new URLSearchParams({ returnTo: erpReturnPath(current.get("x-yummyai-return-path")) })}`,
      );
    }
  }
  return (
    <ErpIdentityBoundary session={session} localDevelopment={localServiceAuth()}>
      <BreadcrumbDetailsProvider>
        <div className="erp-layout">
          <a className="erp-skip-link" href="#erp-page-content">
            跳到页面内容
          </a>
          <ErpSidebar />
          <div className="erp-page-content" id="erp-page-content" tabIndex={-1}>
            <Suspense fallback={<div className="erp-location-bar" aria-label="正在加载当前位置" />}>
              <ErpBreadcrumbs />
            </Suspense>
            {children}
            <Suspense fallback={null}>
              <StudioSession runtimeUrl={studioRuntimeUrl()} />
            </Suspense>
          </div>
        </div>
      </BreadcrumbDetailsProvider>
    </ErpIdentityBoundary>
  );
}
