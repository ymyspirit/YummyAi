import {
  Activity, Archive, BadgeDollarSign, BookOpen, Boxes, Cable, ChartNoAxesCombined, FolderOpen, ImagePlus, Settings2, Video,
  ClipboardList, FileText, FileUp, Gauge, Images, Megaphone, Network,
  PackageSearch, Palette, Scissors, ShoppingCart, Store, Truck, WandSparkles, Workflow,
} from "lucide-react";

import type { ErpSection } from "./navigation-registry";

export const destinationIcons = {
  dashboard: Gauge, research: Archive, competitors: Store, "creative-designs": WandSparkles, "creative-canvas": Workflow,
  "pod-workbench": Palette, design: Palette, "mockup-batches": Images, "production-editor": Scissors,
  "product-specifications": Boxes, "product-development": Workflow, "process-library": Scissors,
  products: Boxes, workflows: Workflow, listings: FileText, stores: Cable, orders: ClipboardList,
  "order-artwork": Scissors, production: Boxes, shipments: Truck, "after-sales": Activity, "print-library": BookOpen,
  "order-import": FileUp, inventory: PackageSearch, procurement: ShoppingCart, suppliers: Store,
  "supplier-performance": ChartNoAxesCombined, "channel-inventory": Network, finance: BadgeDollarSign,
  "customer-intelligence": Megaphone, "operating-cockpit": Activity,
  "studio-canvas": Workflow, "studio-image": ImagePlus, "studio-video": Video,
  "studio-prompts": BookOpen, "studio-assets": FolderOpen, "ai-settings": Settings2,
} satisfies Record<ErpSection, typeof Gauge>;

export const groupIcons = {
  overview: Gauge, commerce: ClipboardList, creative: Palette, catalog: Boxes,
  research: Archive, supply: Truck, insights: ChartNoAxesCombined, settings: Settings2,
};
