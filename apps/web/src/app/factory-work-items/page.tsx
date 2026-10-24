import { notFound } from "next/navigation";
import { factoryPortalOnly } from "../../factory-portal-mode";
import { FactoryPortalClient } from "../../features/factory-portal/factory-portal-client";
export const dynamic = "force-dynamic";
export default function FactoryWorkItems() {
  if (!factoryPortalOnly()) notFound();
  return <FactoryPortalClient />;
}
