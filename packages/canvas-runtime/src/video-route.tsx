import { useEffect, useSyncExternalStore, type ReactNode } from "react";
import type { createStudioVideoAdmission } from "./video-admission";

function StudioVideoRoute({ admission, required, children }: { admission: ReturnType<typeof createStudioVideoAdmission>; required: (authority: string) => void; children: ReactNode }) {
  const current = useSyncExternalStore(admission.subscribe, admission.snapshot, admission.snapshot);
  useEffect(() => { if (!current.allowed) required(current.authority); }, [current, required]);
  return <div className="h-full min-h-0" data-studio-video-admitted={current.allowed ? "true" : "false"}>{current.allowed ? children : <div className="studio-editor-error" role="status"><p>视频历史尚未核对 原任务与记录保持不变</p><button type="button" onClick={() => required(current.authority)}>返回视频历史检查</button></div>}</div>;
}

/** The real router uses this guarded element for init, host and native navigation. */
export function studioVideoRoute(admission: ReturnType<typeof createStudioVideoAdmission>, required: (authority: string) => void, page: ReactNode) {
  return { path: "/video", element: <StudioVideoRoute admission={admission} required={required}>{page}</StudioVideoRoute> };
}
