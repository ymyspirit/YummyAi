import { notFound } from "next/navigation";
import { StudioToolSchema } from "@yummyai/contracts/pod/creative-studio";
export const dynamic = "force-dynamic";
export const metadata = { title: "创作中心 · YummyAI" };
export default async function StudioPage({ params }: { params: Promise<{ tool: string }> }) {
  const tool = StudioToolSchema.safeParse((await params).tool); if (!tool.success) notFound();
  return null;
}
