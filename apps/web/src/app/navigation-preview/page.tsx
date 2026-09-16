import type { Metadata } from "next";

import { NavigationPreview } from "../../features/navigation/preview/navigation-preview";
import { FUNCTION_DESTINATIONS } from "../../features/navigation/navigation-registry";
import "../../features/navigation/preview/navigation-preview.css";

type PreviewPageProps = { searchParams: Promise<{ page?: string | string[] }> };

export async function generateMetadata({ searchParams }: PreviewPageProps): Promise<Metadata> {
  const query = await searchParams;
  const active = FUNCTION_DESTINATIONS.find((item) => item.id === query.page)
    ?? FUNCTION_DESTINATIONS.find((item) => item.id === "orders")!;
  return { title: `${active.label} · 导航预览 · YummyAI`, robots: { index: false, follow: false } };
}

export default async function NavigationPreviewPage({ searchParams }: PreviewPageProps) {
  const query = await searchParams;
  const activeId = FUNCTION_DESTINATIONS.find((item) => item.id === query.page)?.id ?? "orders";
  return <NavigationPreview activeId={activeId} />;
}
