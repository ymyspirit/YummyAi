"use client";

import { useEffect, useState } from "react";
import { flushSync } from "react-dom";
import Link from "next/link";
import { BookOpen, RefreshCw, ShieldCheck } from "lucide-react";
import { Permission } from "@yummyai/authz/permissions";
import { specificationProductionFactProblems } from "@yummyai/contracts/catalog/development";
import type { ProductionFactRuleReference } from "@yummyai/contracts/catalog/specification-facts";
import { RuleWorkspaceSchema, type RuleRow, type RuleWorkspace } from "@yummyai/contracts/rules";
import { useErpAccess } from "../identity/erp-access";
import { ruleRequest } from "../rules/rule-request";
import { cancelViewTransitions, observeViewTransition } from "../navigation/view-transition";
import { useWorkflowReturn } from "../navigation/use-workflow-return";
import { workflowHref } from "../navigation/workflow-href";
import {
  specificationFactsFromDraft,
  specificationProductionReferences,
  type SpecificationFactDraft,
} from "./specification-fact-fields";

export type ProductionRuleWorkspace = {
  status: "loading" | "ready" | "denied" | "failed";
  data: RuleWorkspace | null;
  error: string;
  reload(): void;
};

/** One read per form; batch rows share this source instead of starting their own requests. */
export function useProductionRuleWorkspace(): ProductionRuleWorkspace {
  const access = useErpAccess(), canRead = access.can(Permission.WorkflowRead);
  const [revision, setRevision] = useState(0);
  const [source, setSource] = useState<{
    authority: string | null; status: ProductionRuleWorkspace["status"]; data: RuleWorkspace | null; error: string;
  }>({ authority: null, status: "loading", data: null, error: "" });
  useEffect(() => {
    const controller = new AbortController(), authority = access.authority;
    if (!canRead) {
      setSource({ authority, status: "denied", data: null, error: "当前账号没有规则读取权限 可保留人工核验依据 原规则引用需由有权限的成员核对" });
      return () => controller.abort();
    }
    setSource({ authority, status: "loading", data: null, error: "" });
    void ruleRequest("workspace", undefined, controller.signal)
      .then(value => {
        if (!controller.signal.aborted) setSource({ authority, status: "ready", data: RuleWorkspaceSchema.parse(value), error: "" });
      })
      .catch(cause => {
        if (!controller.signal.aborted) setSource({ authority, status: "failed", data: null,
          error: cause instanceof Error ? cause.message : "当前规则暂时无法读取 请重新读取后核对原引用" });
      });
    return () => controller.abort();
  }, [access.authority, canRead, revision]);
  const current = source.authority === access.authority && canRead;
  return {
    status: !canRead ? "denied" : current ? source.status : "loading",
    data: current ? source.data : null,
    error: !canRead ? "当前账号没有规则读取权限 可保留人工核验依据 原规则引用需由有权限的成员核对" : current ? source.error : "",
    reload: () => setRevision(value => value + 1),
  };
}

export function applicableProductionRules(data: RuleWorkspace | null, spuId: string, productType: string | null) {
  return (data?.rules ?? []).filter(row => {
    const active = row.active;
    return active && active.ruleId === row.id && active.version === row.activeVersion && active.appliesTo === "order_design" &&
      (active.scopeKind === "all" || active.scopeKind === "spu" && active.spuId === spuId ||
        active.scopeKind === "product_type" && !!productType && active.productType === productType);
  });
}

export function sameProductionRule(left: ProductionFactRuleReference, right: ProductionFactRuleReference) {
  return left.ruleId === right.ruleId && left.versionId === right.versionId && left.version === right.version;
}

export function productionRuleReferenceProblems(
  references: ProductionFactRuleReference[], source: ProductionRuleWorkspace, spuId: string, productType: string | null,
) {
  if (!references.length) return [];
  if (source.status !== "ready") return ["原生产规则引用尚未核对 请读取当前规则或明确移除引用后重新核对"];
  const choices = applicableProductionRules(source.data, spuId, productType);
  return references.flatMap(reference => choices.some(row => row.active && sameProductionRule(reference, {
    ruleId: row.id, versionId: row.active.id, version: row.active.version,
  })) ? [] : [`原规则 V${reference.version} 当前未启用或不适用于本规格 请重新核对`]);
}

export function productionDraftProblems(draft: SpecificationFactDraft, processProfileVersionId: string) {
  try {
    const problems = specificationProductionFactProblems({ ...specificationFactsFromDraft(draft, false), productionConfirmed: true });
    if (!processProfileVersionId) problems.push("请选择已审核的通用工艺底稿");
    return problems;
  } catch (cause) { return [cause instanceof Error ? cause.message : "生产资料格式无法核对"]; }
}

export function factoryDimensionPatch(draft: SpecificationFactDraft): Partial<SpecificationFactDraft> {
  return { sizeBasis: "artwork_longest", sizeLength: draft.sizeBasis === "artwork_longest" ? draft.sizeLength : "",
    sizeWidth: "", sizeHeight: "", productionConfirmed: "" };
}

export function trustedPillowFactory(row: RuleRow, productType: string | null) {
  return productType === "shaped_pillow" && row.builtIn && row.code === "system:pillow-factory" && row.active?.binding === "pillow_factory";
}

export function SpecificationProductionFields({
  values, onChange, source, spuId, productType, processProfileVersionId, prefix = "", namePrefix = "", problems: suppliedProblems, disabled = false,
}: {
  values: SpecificationFactDraft;
  onChange(patch: Partial<SpecificationFactDraft>): void;
  source: ProductionRuleWorkspace;
  spuId: string;
  productType: string | null;
  processProfileVersionId: string;
  prefix?: string;
  namePrefix?: string;
  problems?: string[];
  disabled?: boolean;
}) {
  const workflow = useWorkflowReturn();
  const parsed = specificationProductionReferences(values), references = parsed.references;
  const choices = applicableProductionRules(source.data, spuId, productType);
  const referenceProblems = productionRuleReferenceProblems(references, source, spuId, productType);
  const problems = [...new Set([...(suppliedProblems ?? [...productionDraftProblems(values, processProfileVersionId), ...referenceProblems]),
    ...(parsed.error ? [parsed.error] : [])])];
  const confirmed = values.productionConfirmed === "1";
  function change(patch: Partial<SpecificationFactDraft>, animateLayout = false) {
    const update = () => onChange(patch);
    // Controlled inputs must commit in their input event. A view-transition
    // callback may run later, after React has restored the old checked state.
    if (animateLayout && document.startViewTransition && !window.matchMedia("(prefers-reduced-motion: reduce)").matches) {
      cancelViewTransitions(); observeViewTransition(document.startViewTransition(() => flushSync(update)));
    } else update();
  }
  function setReferences(next: ProductionFactRuleReference[], patch: Partial<SpecificationFactDraft> = {}, animateLayout = false) {
    change({ ...patch, productionRuleReferences: JSON.stringify(next), productionConfirmed: "" }, animateLayout);
  }
  return <section className="pd-production-fields pd-span" aria-label={prefix + "生产资料确认"}>
    <div className="pd-production-heading"><ShieldCheck size={16} aria-hidden="true" /><strong>{prefix}生产资料</strong>
      <span className={confirmed && !problems.length ? "pd-production-state ready" : "pd-production-state"}>
        {confirmed && !problems.length ? "已核对 待保存版本" : "待核对"}
      </span>
    </div>
    <p className="pd-form-hint">核对材质 结构 生产尺寸与口径 每份内容和件数 以及依据 使用已审核工艺 净重或包装测量未知可保留待补</p>
    <details className="pd-production-rules">
      <summary><BookOpen size={15} aria-hidden="true" />引用原制作规则 <span>{references.length} 条</span></summary>
      <div className="pd-production-rule-body">
        <p className="pd-form-hint">只显示本规格适用的已启用版本 按需明确选择 原文仅作核对依据 不会自动设置工艺或批准生产</p>
        {source.status === "loading" && <p role="status">正在读取当前制作规则</p>}
        {source.error && <p role="alert" className="oc-error">{source.error}</p>}
        {source.status !== "denied" && <button type="button" className="oc-button" disabled={disabled || source.status === "loading"} onClick={source.reload}>
          <RefreshCw size={14} aria-hidden="true" />重新读取规则
        </button>}
        {source.status === "ready" && !choices.length && <p className="pd-form-hint">当前范围没有已启用规则 可记录实际核验凭证后确认生产资料</p>}
        <div className="pd-production-rule-list">
          {choices.map(row => {
            const rule = row.active!, reference = { ruleId: row.id, versionId: rule.id, version: rule.version };
            const selected = references.some(item => sameProductionRule(item, reference));
            return <article className="pd-production-rule" key={rule.id}>
              <label className="oc-check"><input type="checkbox" name={namePrefix + "production-rule"} value={rule.id}
                checked={selected} disabled={disabled || !selected && references.length >= 12 && !references.some(item => item.ruleId === row.id)}
                onChange={event => setReferences(event.target.checked
                  ? [...references.filter(item => item.ruleId !== row.id), reference]
                  : references.filter(item => !sameProductionRule(item, reference)))} />
                <span>{rule.name} <small>V{rule.version} · 当前启用</small></span>
              </label>
              <p className="pd-production-rule-copy">{rule.instructions}</p>
              <p className="pd-production-rule-source">依据 {rule.source}</p>
              <div className="oc-actions"><Link data-task-draft-link href={workflowHref(`/settings/rules?rule=${row.id}&version=${rule.version}`, workflow.current)}>查看原规则</Link>
                {trustedPillowFactory(row, productType) && <button type="button" className="oc-button"
                  disabled={disabled || references.length >= 12 && !references.some(item => item.ruleId === row.id)}
                  onClick={() => setReferences([...references.filter(item => item.ruleId !== row.id), reference], factoryDimensionPatch(values), true)}>
                  采用工厂尺寸口径
                </button>}
              </div>
              {trustedPillowFactory(row, productType) && <small>只采用图案主体最长边口径 数值请按真实依据填写 不从规格名称推测</small>}
            </article>;
          })}
        </div>
      </div>
    </details>
    {!!references.length && <ul className="pd-production-pins" aria-label={prefix + "已选原规则版本"}>
      {references.map(reference => {
        const current = choices.find(row => row.active && sameProductionRule(reference, { ruleId: row.id, versionId: row.active.id, version: row.active.version }));
        return <li key={reference.ruleId}>
          <Link data-task-draft-link href={workflowHref(`/settings/rules?rule=${reference.ruleId}&version=${reference.version}`, workflow.current)}>{current?.active?.name ?? "原制作规则"} · V{reference.version}</Link>
          {!current && <span>当前版本需重新核对</span>}
          <button type="button" className="oc-button" disabled={disabled} onClick={() => setReferences(references.filter(item => item.ruleId !== reference.ruleId))}>移除引用</button>
        </li>;
      })}
    </ul>}
    {parsed.error && <p role="alert" className="oc-error">{parsed.error} <button type="button" className="oc-button" disabled={disabled} onClick={() => setReferences([])}>清除无法核对的引用</button></p>}
    <input type="hidden" name={namePrefix + "productionRuleReferences"} value={values.productionRuleReferences || "[]"} />
    <label className="oc-check pd-production-confirm"><input type="checkbox" name={namePrefix + "productionConfirmed"} value="1"
      checked={confirmed} disabled={disabled || !confirmed && problems.length > 0}
      onChange={event => change({ productionConfirmed: event.target.checked ? "1" : "" })} />
      {prefix}生产资料已核对
    </label>
    {!!problems.length && <details className="pd-production-problems"><summary>生产资料待补 {problems.length} 项</summary><ul>{problems.map(problem => <li key={problem}>{problem}</li>)}</ul></details>}
    <p className="pd-form-hint">这项确认用于订单制作 完整商品资料仍需补齐重量和包装测量后单独核实</p>
  </section>;
}
