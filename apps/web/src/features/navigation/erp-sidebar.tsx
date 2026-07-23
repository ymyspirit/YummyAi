import { Archive, BadgeDollarSign, Boxes, Cable, ChartNoAxesCombined, ClipboardList, FileText, Gauge, Megaphone, Network, PackageSearch, Palette, ScanSearch, ShoppingCart, Store } from "lucide-react";
import Link from "next/link";

export type ErpSection =
  "dashboard" | "research" | "competitors" | "products" | "design" | "stores" | "listings" | "orders" | "inventory" | "procurement" | "supplier-performance" | "channel-inventory" | "finance" | "customer-intelligence";

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
  listingHref = "/listings",
}: ErpSidebarProps) {
  const items = [
    { id: "dashboard", href: "/", label: "运营总览", icon: Gauge },
    { id: "research", href: "/research", label: "研究资料库", icon: Archive },
    { id: "competitors", href: "/competitors", label: "竞争店铺", icon: Store },
    { id: "products", href: "/products", label: "产品开发", icon: Boxes },
    { id: "design", href: "/design", label: "设计校样", icon: Palette },
    { id: "stores", href: "/stores", label: "店铺连接", icon: Cable },
    { id: "listings", href: listingHref, label: "刊登控制台", icon: FileText },
    { id: "orders", href: "/orders", label: "订单履约", icon: ClipboardList },
    { id: "inventory", href: "/inventory", label: "库存台账", icon: PackageSearch },
    { id: "procurement", href: "/procurement", label: "采购补货", icon: ShoppingCart },
    { id: "supplier-performance", href: "/supplier-performance", label: "供应商绩效", icon: ChartNoAxesCombined },
    { id: "channel-inventory", href: "/channel-inventory", label: "渠道库存", icon: Network },
    { id: "finance", href: "/finance", label: "财务利润", icon: BadgeDollarSign },
    { id: "customer-intelligence", href: "/customer-intelligence", label: "广告与 VOC", icon: Megaphone },
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
