import { Suspense } from "react";

import { ErpBreadcrumbs } from "../../features/navigation/erp-breadcrumbs";
import { ErpSidebar } from "../../features/navigation/erp-sidebar";
import "../../features/navigation/navigation.css";

export default function ErpLayout({ children }: { children: React.ReactNode }) {
  return <div className="erp-layout">
    <a className="erp-skip-link" href="#erp-page-content">跳到页面内容</a>
    <ErpSidebar />
    <div className="erp-page-content" id="erp-page-content" tabIndex={-1}>
      <Suspense fallback={<div className="erp-location-bar" aria-label="正在加载当前位置" />}><ErpBreadcrumbs /></Suspense>
      {children}
    </div>
  </div>;
}
