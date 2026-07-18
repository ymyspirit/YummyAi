import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { JobProgress } from "./job-progress";

describe("job progress", () => {
  it("shows running and failed jobs with actual progress", () => {
    const html = renderToStaticMarkup(<JobProgress jobs={[{ id: "1", jobId: "a", label: "AI-03 定价分析", state: "running", progress: 62, occurredAt: "2026-07-18T04:00:00Z" }, { id: "2", jobId: "b", label: "Amazon 导出", state: "failed", progress: 71, message: "素材权利未批准", occurredAt: "2026-07-18T04:02:00Z" }]} />);
    expect(html).toContain("62%"); expect(html).toContain("失败"); expect(html).toContain("素材权利未批准");
  });
  it("renders a useful empty state", () => { expect(renderToStaticMarkup(<JobProgress jobs={[]} />)).toContain("当前没有运行中的后台任务"); });
});
