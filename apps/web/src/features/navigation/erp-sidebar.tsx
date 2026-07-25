import {
  Activity,
  Archive,
  BadgeDollarSign,
  Boxes,
  Cable,
  ChartNoAxesCombined,
  ClipboardList,
  FileText,
  Gauge,
  Megaphone,
  Network,
  PackageSearch,
  Palette,
  ScanSearch,
  ShoppingCart,
  Store,
} from "lucide-react";
import Link from "next/link";

export type ErpSection =
  | "dashboard"
  | "research"
  | "competitors"
  | "products"
  | "design"
  | "stores"
  | "listings"
  | "orders"
  | "inventory"
  | "procurement"
  | "supplier-performance"
  | "channel-inventory"
  | "finance"
  | "customer-intelligence"
  | "operating-cockpit";

const navigationGroups = [
  {
    id: "overview",
    label: "总览",
    items: [{ id: "dashboard", href: "/", label: "运营总览", icon: Gauge }],
  },
  {
    id: "research",
    label: "研究",
    items: [
      { id: "research", href: "/research", label: "研究资料库", icon: Archive },
      { id: "competitors", href: "/competitors", label: "竞争店铺", icon: Store },
    ],
  },
  {
    id: "catalog",
    label: "商品",
    items: [
      { id: "products", href: "/products", label: "产品目录", icon: Boxes },
      { id: "design", href: "/design", label: "设计校样", icon: Palette },
      { id: "listings", href: "/listings", label: "刊登控制台", icon: FileText },
    ],
  },
  {
    id: "commerce",
    label: "交易履约",
    items: [
      { id: "stores", href: "/stores", label: "店铺运营", icon: Cable },
      { id: "orders", href: "/orders", label: "订单履约", icon: ClipboardList },
    ],
  },
  {
    id: "supply",
    label: "供应链",
    items: [
      { id: "inventory", href: "/inventory", label: "库存台账", icon: PackageSearch },
      { id: "procurement", href: "/procurement", label: "采购补货", icon: ShoppingCart },
      {
        id: "supplier-performance",
        href: "/supplier-performance",
        label: "供应商绩效",
        icon: ChartNoAxesCombined,
      },
      { id: "channel-inventory", href: "/channel-inventory", label: "渠道库存", icon: Network },
    ],
  },
  {
    id: "insights",
    label: "经营洞察",
    items: [
      { id: "finance", href: "/finance", label: "财务利润", icon: BadgeDollarSign },
      {
        id: "customer-intelligence",
        href: "/customer-intelligence",
        label: "广告与 VOC",
        icon: Megaphone,
      },
      { id: "operating-cockpit", href: "/operating-cockpit", label: "数据与集成", icon: Activity },
    ],
  },
] as const satisfies ReadonlyArray<{
  id: string;
  label: string;
  items: ReadonlyArray<{ id: ErpSection; href: string; label: string; icon: typeof Gauge }>;
}>;

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
  return (
    <aside className="side-rail">
      <div className="rail-brand">
        <span className="rail-mark">
          <ScanSearch aria-hidden="true" size={20} />
        </span>
        <div>
          <strong>YummyAI</strong>
          <span>{contextLabel}</span>
        </div>
      </div>
      <nav className="rail-nav analysis-nav" aria-label="主导航">
        {navigationGroups.map((group) => (
          <section
            aria-labelledby={`rail-group-${group.id}`}
            className="rail-nav-section"
            key={group.id}
          >
            <p className="rail-nav-heading" id={`rail-group-${group.id}`}>
              {group.label}
            </p>
            <div className="rail-nav-links">
              {group.items.map(({ id, href, label, icon: Icon }) => (
                <Link
                  className={active === id ? "active" : undefined}
                  aria-current={active === id ? "page" : undefined}
                  href={id === "listings" ? listingHref : href}
                  key={id}
                >
                  <Icon aria-hidden="true" size={16} />
                  {label}
                </Link>
              ))}
            </div>
          </section>
        ))}
      </nav>
      <p className="rail-note">{note}</p>
    </aside>
  );
}
