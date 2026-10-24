"use client";

import { ChevronRight, LayoutGrid } from "lucide-react";
import Link from "next/link";
import { usePathname, useSearchParams } from "next/navigation";
import { useEffect, useState } from "react";

import { resolveNavigationLocation } from "./navigation-registry";
import { ErpAppearance } from "./erp-appearance";
import {ErpSessionControl} from "../identity/erp-identity-boundary";
import { useBreadcrumbDetailLabel } from "./breadcrumb-details";

export function ErpBreadcrumbs() {
  const pathname = usePathname() ?? "/";
  const search = useSearchParams();
  const [hydrated, setHydrated] = useState(false);
  const { current, breadcrumbs, detailKey } = resolveNavigationLocation(pathname, search.toString());
  const detailLabel = useBreadcrumbDetailLabel(detailKey);
  const currentLabel = detailLabel ?? current.label;
  // A shared Suspense boundary can hydrate after navigation has already changed the URL.
  // Keep its first render identical to the server, then read the current client location.
  useEffect(() => { setHydrated(true); }, []);
  useEffect(() => { if (hydrated) document.title = `${currentLabel} · YummyAI`; }, [currentLabel, hydrated]);
  if (!hydrated) return <div className="erp-location-bar" aria-label="正在加载当前位置" />;
  return <div className="erp-location-bar">
    <nav aria-label="当前位置"><ol>{breadcrumbs.map((item, index) => <li key={`${index}-${item.label}`}>
      {index > 0 && <ChevronRight size={13} aria-hidden="true" />}
      {item.href ? <Link href={item.href} prefetch={false}>{item.label}</Link> : <span aria-current="page">{currentLabel}</span>}
    </li>)}</ol></nav>
    <div className="erp-location-tools"><ErpSessionControl/><ErpAppearance /><Link className="erp-all-functions" href="/navigation"><LayoutGrid size={15} aria-hidden="true" />全部功能</Link></div>
  </div>;
}
