"use client";
import Link from "next/link";
import type { DevelopmentOptions, SpecificationView } from "@yummyai/contracts/catalog/development";
import { boundSpecificationAxes } from "./specification-options";
import { useWorkflowReturn } from "../navigation/use-workflow-return";
import { workflowHref } from "../navigation/workflow-href";
import { TaskDrawerActions } from "../navigation/task-drawer";

export function SpuDetailPanel({
  options,
  spuId,
  busy,
  onEdit,
  onBind,
  onSpecification,
}: {
  options: DevelopmentOptions;
  spuId: string;
  busy: boolean;
  onEdit: () => void;
  onBind: () => void;
  onSpecification: (spec: SpecificationView) => void;
}) {
  const workflow = useWorkflowReturn();
  const spu = options.spus.find((item) => item.id === spuId);
  const specifications = options.specifications.filter((item) => item.spuId === spuId);
  if (!spu) return <p role="alert">此 SPU 当前不可用，请关闭详情后刷新列表。</p>;
  return (
    <>
      <p style={{ whiteSpace: "pre-wrap" }}>{spu.description || "尚未填写产品说明。"}</p>
      <div className="pd-detail-toolbar">
        <Link className="oc-button" href={workflowHref("/process-library", workflow.current)}>
          工艺底稿
        </Link>
      </div>
      <h3>产品规格（{specifications.length}）</h3>
      <dl className="pd-bound-options" aria-label="已绑定规格选项">
        {boundSpecificationAxes(specifications).map((axis) => (
          <div key={axis.name}>
            <dt>{axis.name}</dt>
            <dd>{axis.values.join("、")}</dd>
          </div>
        ))}
      </dl>
      <div className="pd-table">
        <table>
          <thead>
            <tr>
              <th>规格</th>
              <th>材质 / 尺寸</th>
              <th>工艺 / 共用物料</th>
              <th>版本</th>
              <th>操作</th>
            </tr>
          </thead>
          <tbody>
            {specifications.map((spec) => (
              <tr key={spec.id}>
                <td>
                  <strong>{spec.name}</strong>
                  <small>
                    {spec.code} ·{" "}
                    {Object.entries(spec.attributes)
                      .map(([key, value]) => `${key}：${value}`)
                      .join(" / ")}
                  </small>
                </td>
                <td>
                  {spec.facts.material} · {spec.facts.dimensions}
                  <small>
                    {!spec.processProfileVersionId
                      ? "规格草稿 · 待确认生产参数"
                      : spec.facts.factsConfirmed
                        ? "事实已核实"
                        : "待核实事实"}
                  </small>
                </td>
                <td>
                  {spec.processName}
                  <small>
                    {options.stockItems.find((item) => item.id === spec.stockItemId)?.code ??
                      "未关联共用物料"}
                  </small>
                </td>
                <td>V{spec.version}</td>
                <td>
                  <button
                    className="oc-button"
                    disabled={busy}
                    onClick={() => onSpecification(spec)}
                  >
                    修改规格
                  </button>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
        {!specifications.length && (
          <p className="pd-empty">
            此 SPU 尚无规格，点击“绑定多个规格”添加尺寸、形状、颜色等选项。
          </p>
        )}
      </div>
      <TaskDrawerActions>
        <button className="oc-button" disabled={busy || !spu.revision} onClick={onEdit}>
          编辑 SPU
        </button>
        <button className="oc-button primary" disabled={busy} onClick={onBind}>
          绑定多个规格
        </button>
      </TaskDrawerActions>
    </>
  );
}
