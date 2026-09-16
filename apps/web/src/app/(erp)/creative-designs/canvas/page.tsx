import { CanvasWorkspace } from "../../../../features/canvas/canvas-workspace";
import { canvasWorkbenchUrl } from "../../../../features/canvas/canvas-configuration";
import { EntityIdSchema } from "@yummyai/contracts/common/ids";

export const dynamic = "force-dynamic";
export const metadata = { title: "创意项目 · YummyAI" };
export default async function CanvasPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const params = await searchParams;
  const initial = EntityIdSchema.safeParse(params.brief);
  const ids =
    typeof params.research === "string"
      ? [...new Set(params.research.split(","))]
          .filter((id) => EntityIdSchema.safeParse(id).success)
          .slice(0, 30)
      : [];
  const snapshot = EntityIdSchema.safeParse(params.snapshot),
    study = EntityIdSchema.safeParse(params.study);
  const sources = initial.success
    ? []
    : ids.map((researchItemId) => ({
        researchItemId,
        ...(ids.length === 1 && snapshot.success
          ? { snapshotId: snapshot.data, studyRevisionId: study.success ? study.data : null }
          : {}),
      }));
  return (
    <div className="research-shell">
      <main className="research-main">
        <CanvasWorkspace
          canvasUrl={canvasWorkbenchUrl()}
          initialBriefId={initial.success ? initial.data : undefined}
          initialResearchSources={sources}
        />
      </main>
    </div>
  );
}
