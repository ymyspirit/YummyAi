import { Archive, Boxes, FileText, Gauge, Palette, ScanSearch, Store } from "lucide-react";
import Link from "next/link";

export type ErpSection =
  "dashboard" | "research" | "competitors" | "products" | "design" | "listings";

interface ErpSidebarProps {
  active: ErpSection;
  contextLabel: string;
  note: string;
  listingHref?: string;
}

export function ErpSidebar({
  active,
  contextLabel,
  note,
  listingHref = "/listings/demo",
}: ErpSidebarProps) {
  const items = [
    { id: "dashboard", href: "/", label: "运营总览", icon: Gauge },
    { id: "research", href: "/research", label: "研究资料库", icon: Archive },
    { id: "competitors", href: "/competitors", label: "竞争店铺", icon: Store },
    { id: "products", href: "/products", label: "产品开发", icon: Boxes },
    { id: "design", href: "/design", label: "设计校样", icon: Palette },
    { id: "listings", href: listingHref, label: "刊登控制台", icon: FileText },
  ] as const;

  return (
    <aside className="side-rail">
      <div className="rail-brand">
        <span className="rail-mark">
          <ScanSearch size={20} />
        </span>
        <div>
          <strong>YummyAI</strong>
          <span>{contextLabel}</span>
        </div>
      </div>
      <nav className="rail-nav analysis-nav" aria-label="主导航">
        {items.map(({ id, href, label, icon: Icon }) => (
          <Link
            className={active === id ? "active" : undefined}
            aria-current={active === id ? "page" : undefined}
            href={href}
            key={id}
          >
            <Icon size={16} />
            {label}
          </Link>
        ))}
      </nav>
      <p className="rail-note">{note}</p>
    </aside>
  );
}
