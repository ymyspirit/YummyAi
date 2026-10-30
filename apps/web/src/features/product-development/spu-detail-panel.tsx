"use client";
import { useId, useState } from "react";
import { ChevronRight, Search } from "lucide-react";
import { SpecificationDimensionBases, specificationFactsReady, specificationProductionFactsReady } from "@yummyai/contracts/catalog/development";
import Link from "next/link";
import type { DevelopmentOptions, SpecificationView } from "@yummyai/contracts/catalog/development";
import { boundSpecificationAxes } from "./specification-options";
import { formatSpecificationWeight, orderedSpecifications } from "./specification-presentation";
import { useWorkflowReturn } from "../navigation/use-workflow-return";
import { workflowHref } from "../navigation/workflow-href";
import { TaskDrawerActions } from "../navigation/task-drawer";
import { Permission } from "@yummyai/authz/permissions";
import { useErpAccess } from "../identity/erp-access";
import "./spu-detail-panel.css";

const exactWeight = (grams: number | null | undefined) => grams == null ? "未知" : String(grams) + " g";

export function SpuDetailPanel({ options, spuId, busy, onEdit, onBind, onSpecification }: {
  options: DevelopmentOptions;
  spuId: string;
  busy: boolean;
  onEdit: () => void;
  onBind: () => void;
  onSpecification: (spec: SpecificationView) => void;
}) {
  const { can } = useErpAccess();
  const workflow = useWorkflowReturn();
  const prefix = useId();
  const [query, setQuery] = useState("");
  const [expandedVersions, setExpandedVersions] = useState<Set<string>>(() => new Set());
  const spu = options.spus.find((item) => item.id === spuId);
  const canWrite = Boolean(spu) && can(Permission.ProductWrite, { ownerId: spu?.ownerUserId, teamId: spu?.teamId });
  const specifications = orderedSpecifications(options.specifications.filter((item) => item.spuId === spuId));
  const search = query.trim().toLocaleLowerCase("zh-CN");
  const visibleSpecifications = specifications.filter(spec => !search || [spec.name, spec.code, spec.facts.dimensions, ...Object.values(spec.attributes)].join(" ").toLocaleLowerCase("zh-CN").includes(search));
  if (!spu) return <p role="alert">此 SPU 当前不可用，请关闭详情后刷新列表。</p>;
  return <div className="spu-detail-panel">
    {spu.legacyPlanAmbiguous ? <p className="product-legacy-notice" role="status">历史商品关系待核对 共享企划暂时只读 当前显示所选原 SPU 的规格与历史</p> : null}
    <nav className="pd-detail-toolbar spu-detail-toolbar" aria-label="产品工作流">
      {canWrite && <Link className="oc-button spu-detail-button primary" href={workflowHref("/sales-plans?spuId=" + spuId + "&new=1", workflow.current)}>新建销售方案</Link>}
      <Link className="oc-button spu-detail-button" href={workflowHref("/sales-plans?spuId=" + spuId, workflow.current)}>查看销售方案</Link>
      <Link className="oc-button spu-detail-button" href={workflowHref("/process-library", workflow.current)}>工艺底稿</Link>
      <Link className="oc-button spu-detail-button" href={workflowHref("/manufacturing-recipes?" + new URLSearchParams({ spuId }), workflow.current)}>制造模板</Link>
    </nav>

    <details className="spu-overview-disclosure">
      <summary aria-controls={prefix + "-overview"}><ChevronRight size={15} aria-hidden="true" /><span>产品说明与通用工艺</span></summary>
      <div id={prefix + "-overview"} className="spu-overview-content">
        <h4>产品说明</h4>
        <p className="spu-preserved-text">{spu.description || "尚未填写产品说明。"}</p>
        <dl className="spu-detail-facts">
          <div><dt>可用加工工艺</dt><dd>{spu.capabilities?.processes || "待补充"}</dd></div>
          <div><dt>可定制范围</dt><dd>{spu.capabilities?.customizationScope || "待补充"}</dd></div>
          <div><dt>通用包装要求</dt><dd>{spu.capabilities?.packaging || "待补充"}</dd></div>
        </dl>
        <dl className="pd-bound-options" aria-label="已绑定规格选项">{boundSpecificationAxes(specifications).map(axis => <div key={axis.name}><dt>{axis.name}</dt><dd>{axis.values.join("、")}</dd></div>)}</dl>
      </div>
    </details>

    <section aria-labelledby={prefix + "-specifications"} className="spu-specifications">
      <header className="spu-specifications-header">
        <div><h3 id={prefix + "-specifications"}>产品规格（{specifications.length}）</h3><p>生产放行仍按订单审核流程执行</p></div>
        <label className="spu-spec-filter" htmlFor={prefix + "-filter"}><span>筛选规格</span><span className="spu-spec-filter-input"><Search size={14} aria-hidden="true" /><input id={prefix + "-filter"} type="search" placeholder="名称 编码或尺寸" value={query} onChange={event => setQuery(event.target.value)} /></span></label>
      </header>
      <p className="spu-spec-count" role="status" aria-live="polite">显示 {visibleSpecifications.length} / 共 {specifications.length} 个规格{query && <button type="button" className="spu-spec-clear" onClick={() => setQuery("")}>清除规格筛选</button>}</p>
      <div className="pd-table spu-spec-table">
        <table aria-label="产品规格对比">
          <colgroup><col className="spu-col-spec" /><col className="spu-col-weight" /><col className="spu-col-package" /><col className="spu-col-status" /><col className="spu-col-actions" /></colgroup>
          <thead><tr><th scope="col">规格 / 尺寸口径</th><th scope="col">含包装重量</th><th scope="col">包装外尺寸</th><th scope="col">资料状态</th><th scope="col">版本 / 操作</th></tr></thead>
          {visibleSpecifications.map(spec => {
            const expanded = expandedVersions.has(spec.versionId), detailsId = prefix + "-spec-" + spec.versionId;
            return <tbody key={spec.versionId}>
              <tr className="spu-spec-summary-row">
                <th scope="row" data-label="规格 / 尺寸口径"><strong>{spec.name}</strong><small className="spu-spec-code">{spec.code}</small><span className="spu-spec-dimensions" title={spec.facts.dimensions}>{spec.facts.dimensions || "尺寸口径待补充"}</span></th>
                <td data-label="含包装重量" className="spu-spec-weight">{formatSpecificationWeight(spec.facts.packagedWeightGrams)}</td>
                <td data-label="包装外尺寸"><span className="spu-spec-package" title={spec.facts.packageDimensions}>{spec.facts.packageDimensions || "待确认"}</span></td>
                <td data-label="资料状态"><span className="spu-spec-status">{!spec.processProfileVersionId ? "规格草稿 · 待确认生产参数" : specificationProductionFactsReady(spec.facts) ? "生产资料可准备" : "生产资料待核对"}</span><small>{specificationFactsReady(spec.facts) ? "完整商品资料已齐备" : "上架资料待补"}</small></td>
                <td data-label="版本 / 操作"><div className="spu-spec-actions"><span className="spu-spec-version">V{spec.version}</span><button type="button" className="oc-button spu-detail-button" disabled={busy || !canWrite} onClick={() => onSpecification(spec)}>修改规格</button><button type="button" className="spu-spec-expand" aria-label={spec.name + " 完整资料与核验依据"} aria-expanded={expanded} aria-controls={detailsId} onClick={() => setExpandedVersions(current => { const next = new Set(current); if (next.has(spec.versionId)) next.delete(spec.versionId); else next.add(spec.versionId); return next; })}><ChevronRight size={14} aria-hidden="true" />详情</button><Link className="spu-spec-template" href={workflowHref("/manufacturing-recipes?" + new URLSearchParams({ spuId, specificationId: spec.id, new: "1" }), workflow.current)}>本规格制造模板</Link></div></td>
              </tr>
              <tr className="spu-spec-details-row"><td colSpan={5}>
                <details className="spu-spec-disclosure" open={expanded}><summary hidden>{spec.name} 完整资料与核验依据</summary>
                  <div id={detailsId} role="region" aria-label={spec.name + " 完整资料"} className="spu-spec-details-content">
                    <h4>规格与制作资料</h4>
                    <dl className="spu-detail-facts">
                      <div><dt>规格编码</dt><dd>{spec.code}</dd></div>
                      <div><dt>规格选项</dt><dd>{Object.entries(spec.attributes).map(([name, value]) => name + "：" + value).join(" / ") || "未填写"}</dd></div>
                      <div className="spu-detail-wide"><dt>完整尺寸口径</dt><dd>{spec.facts.dimensions || "待确认"}</dd></div>
                      {spec.facts.physicalDimensions && <div className="spu-detail-wide"><dt>原始尺寸测量</dt><dd>{spec.facts.physicalDimensions.basis ? SpecificationDimensionBases[spec.facts.physicalDimensions.basis] : "口径待确认"} · 单位 {spec.facts.physicalDimensions.unit ?? "待确认"} · 长 {spec.facts.physicalDimensions.length ?? "未知"} / 宽 {spec.facts.physicalDimensions.width ?? "未知"} / 高 {spec.facts.physicalDimensions.height ?? "未知"}</dd></div>}
                      <div><dt>材质</dt><dd>{spec.facts.material || "待补充"}</dd></div>
                      <div><dt>产品结构</dt><dd>{spec.facts.structure || "待补充"}</dd></div>
                      <div><dt>商品净重 原始记录</dt><dd>{exactWeight(spec.facts.weightGrams)}</dd></div>
                      <div><dt>含包装重量 原始记录</dt><dd>{exactWeight(spec.facts.packagedWeightGrams)}</dd></div>
                      <div><dt>包装内容</dt><dd>{spec.facts.packageContents || "待补充"}</dd></div>
                      <div><dt>每份件数</dt><dd>{spec.facts.packageQuantity ?? "待确认"}</dd></div>
                      <div><dt>包装外尺寸</dt><dd>{spec.facts.packageDimensions || "待确认"}</dd></div>
                      {spec.facts.packageMeasurements && <div><dt>原始包装测量</dt><dd>单位 {spec.facts.packageMeasurements.unit ?? "待确认"} · 长 {spec.facts.packageMeasurements.length ?? "未知"} / 宽 {spec.facts.packageMeasurements.width ?? "未知"} / 高 {spec.facts.packageMeasurements.height ?? "未知"}</dd></div>}
                      <div><dt>工艺底稿</dt><dd>{spec.processName || "未绑定工艺底稿"}</dd></div>
                      <div><dt>共用物料</dt><dd>{options.stockItems.find(item => item.id === spec.stockItemId)?.code ?? "未关联共用物料"}</dd></div>
                    </dl>
                    <div className="spu-spec-verification">
                      <h4>核验记录与依据</h4>
                      <dl className="spu-detail-facts">
                        <div className="spu-detail-wide"><dt>本版本填写的核验依据</dt><dd>{spec.facts.verificationReference || "未填写"}</dd></div>
                        {spec.factVerification && <div className="spu-detail-wide"><dt>商品资料确认</dt><dd><time dateTime={spec.factVerification.confirmedAt}>{new Date(spec.factVerification.confirmedAt).toLocaleString("zh-CN")}</time><p>依据：{spec.factVerification.reference}</p></dd></div>}
                        {spec.productionVerification && <div className="spu-detail-wide"><dt>本版本生产资料核对</dt><dd><time dateTime={spec.productionVerification.confirmedAt}>{new Date(spec.productionVerification.confirmedAt).toLocaleString("zh-CN")}</time><p>依据：{spec.productionVerification.reference}</p></dd></div>}
                      </dl>
                      {!!spec.facts.productionRuleReferences?.length && <div className="spu-spec-rules"><h4>本版本引用的制作规则 {spec.facts.productionRuleReferences.length} 条</h4><ul>{spec.facts.productionRuleReferences.map(reference => <li key={reference.ruleId}><Link href={workflowHref("/settings/rules?rule=" + reference.ruleId + "&version=" + reference.version, workflow.current)}>查看原规则 · V{reference.version}</Link></li>)}</ul></div>}
                    </div>
                  </div>
                </details>
              </td></tr>
            </tbody>;
          })}
        </table>
        {!specifications.length && <p className="pd-empty">{canWrite ? "此 SPU 尚无规格 点击绑定多个规格添加尺寸 形状 颜色等选项" : "此 SPU 尚无规格 当前账户只读 请联系可维护商品的成员补充"}</p>}
        {!!specifications.length && !visibleSpecifications.length && <p className="pd-empty" role="status">没有匹配的规格 请调整筛选条件</p>}
      </div>
    </section>
    {canWrite && <TaskDrawerActions><button className="oc-button spu-detail-button" disabled={busy || !spu.revision || spu.legacyPlanAmbiguous} onClick={onEdit}>编辑 SPU</button><button className="oc-button spu-detail-button primary" disabled={busy} onClick={onBind}>绑定多个规格</button></TaskDrawerActions>}
  </div>;
}
