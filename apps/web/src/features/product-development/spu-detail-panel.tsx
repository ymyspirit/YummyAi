"use client";
import { specificationFactsReady } from "@yummyai/contracts/catalog/development";

import Link from "next/link";
import type { DevelopmentOptions, SpecificationView } from "@yummyai/contracts/catalog/development";
import { boundSpecificationAxes } from "./specification-options";
import { useWorkflowReturn } from "../navigation/use-workflow-return";
import { workflowHref } from "../navigation/workflow-href";
import { TaskDrawerActions } from "../navigation/task-drawer";
import { Permission } from "@yummyai/authz/permissions";
import { useErpAccess } from "../identity/erp-access";

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
  const { can } = useErpAccess();
  const workflow = useWorkflowReturn();
  const spu = options.spus.find((item) => item.id === spuId);
  const canWrite =
    Boolean(spu) &&
    can(Permission.ProductWrite, { ownerId: spu?.ownerUserId, teamId: spu?.teamId });
  const specifications = options.specifications.filter((item) => item.spuId === spuId);
  if (!spu) return <p role="alert">此 SPU 当前不可用，请关闭详情后刷新列表。</p>;
  return (
    <>
      {spu.legacyPlanAmbiguous ? <p className="product-legacy-notice" role="status">历史商品关系待核对 共享企划暂时只读 当前显示所选原 SPU 的规格与历史</p> : null}
      <p style={{ whiteSpace: "pre-wrap" }}>{spu.description || "尚未填写产品说明。"}</p>
      <div className="pd-detail-toolbar">
        {canWrite && (
          <Link
            className="oc-button primary"
            href={workflowHref(`/sales-plans?spuId=${spuId}&new=1`, workflow.current)}
          >
            新建销售方案
          </Link>
        )}
        <Link
          className="oc-button"
          href={workflowHref(`/sales-plans?spuId=${spuId}`, workflow.current)}
        >
          查看销售方案
        </Link>
        <Link className="oc-button" href={workflowHref("/process-library", workflow.current)}>
          工艺底稿
        </Link>
        <Link className="oc-button" href={workflowHref(`/manufacturing-recipes?${new URLSearchParams({ spuId })}`, workflow.current)}>制造模板</Link>
      </div>
      <dl className="pd-bound-options">
        <div>
          <dt>可用加工工艺</dt>
          <dd>{spu.capabilities?.processes || "待补充"}</dd>
        </div>
        <div>
          <dt>可定制范围</dt>
          <dd>{spu.capabilities?.customizationScope || "待补充"}</dd>
        </div>
        <div>
          <dt>通用包装要求</dt>
          <dd>{spu.capabilities?.packaging || "待补充"}</dd>
        </div>
      </dl>
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
                    重量：{spec.facts.weightGrams ? `${spec.facts.weightGrams} g` : "待确认"} /
                    含包装：
                    {spec.facts.packagedWeightGrams
                      ? `${spec.facts.packagedWeightGrams} g`
                      : "待确认"}
                  </small>
                  <small>
                    {!spec.processProfileVersionId
                      ? "规格草稿 · 待确认生产参数"
                      : specificationFactsReady(spec.facts)
                        ? "事实已核实"
                        : "待核实事实"}
                  </small>
                  {spec.facts.structure && <small>结构：{spec.facts.structure}</small>}
                  <small>每份件数：{spec.facts.packageQuantity ?? "待确认"} · 包装尺寸：{spec.facts.packageDimensions || "待确认"}</small>
                  {spec.factVerification && <small>确认于 {new Date(spec.factVerification.confirmedAt).toLocaleString("zh-CN")} · 依据：{spec.factVerification.reference}</small>}
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
                    disabled={busy || !canWrite}
                    onClick={() => onSpecification(spec)}
                  >
                    修改规格
                  </button>
                  <Link className="oc-button" href={workflowHref(`/manufacturing-recipes?${new URLSearchParams({ spuId, specificationId: spec.id, new: "1" })}`, workflow.current)}>本规格制造模板</Link>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
        {!specifications.length && (
          <p className="pd-empty">
            {canWrite
              ? "此 SPU 尚无规格 点击绑定多个规格添加尺寸 形状 颜色等选项"
              : "此 SPU 尚无规格 当前账户只读 请联系可维护商品的成员补充"}
          </p>
        )}
      </div>
      {canWrite && (
        <TaskDrawerActions>
          <button className="oc-button" disabled={busy || !spu.revision || spu.legacyPlanAmbiguous} onClick={onEdit}>
            编辑 SPU
          </button>
          <button className="oc-button primary" disabled={busy} onClick={onBind}>
            绑定多个规格
          </button>
        </TaskDrawerActions>
      )}
    </>
  );
}
