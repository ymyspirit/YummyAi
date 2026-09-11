import { CanvasWorkspace } from "../../../../features/canvas/canvas-workspace";
import { canvasWorkbenchUrl } from "../../../../features/canvas/canvas-configuration";
import { EntityIdSchema } from "@yummyai/contracts/common/ids";

export const dynamic = "force-dynamic";
export const metadata = { title: "创意画布 · YummyAI" };
export default async function CanvasPage({ searchParams }: { searchParams: Promise<Record<string, string | string[] | undefined>> }) {
  const initial = EntityIdSchema.safeParse((await searchParams).brief);
  return <div className="research-shell"><main className="research-main"><CanvasWorkspace canvasUrl={canvasWorkbenchUrl()} initialBriefId={initial.success ? initial.data : undefined} /></main></div>;
}
