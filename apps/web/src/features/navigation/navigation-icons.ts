import {
  Activity, Archive, BadgeDollarSign, Boxes, Cable, ChartNoAxesCombined,
  ClipboardList, FileText, FileUp, Gauge, Images, Megaphone, Network,
  PackageSearch, Palette, Scissors, ShoppingCart, Store, Truck, WandSparkles, Workflow,
} from "lucide-react";

import type { ErpSection } from "./navigation-registry";

export const destinationIcons = {
  dashboard: Gauge, research: Archive, competitors: Store, "creative-designs": WandSparkles, "creative-canvas": Workflow,
  "pod-workbench": Palette, design: Palette, "mockup-batches": Images, "production-editor": Scissors,
  products: Boxes, workflows: Workflow, listings: FileText, stores: Cable, orders: ClipboardList,
  "order-import": FileUp, inventory: PackageSearch, procurement: ShoppingCart,
  "supplier-performance": ChartNoAxesCombined, "channel-inventory": Network, finance: BadgeDollarSign,
  "customer-intelligence": Megaphone, "operating-cockpit": Activity,
} satisfies Record<ErpSection, typeof Gauge>;

export const groupIcons = {
  overview: Gauge, commerce: ClipboardList, creative: Palette, catalog: Boxes,
  research: Archive, supply: Truck, insights: ChartNoAxesCombined,
};
