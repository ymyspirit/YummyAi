"use client";
import Link from "next/link";
import { Check, Circle, CircleAlert, Clock3, LoaderCircle } from "lucide-react";
import type { BusinessTaskView } from "@yummyai/contracts/operations/business-task";
import "./business-tasks.css";

export const businessTaskLabels = { pending: "待准备", working: "处理中", blocked: "待处理", waiting: "待确认", done: "已完成", unavailable: "暂不可读", cancelled: "已停止" };
export function BusinessTaskPanel({ task, planLabel = "业务任务阶段", disabled = false }: { task: BusinessTaskView; planLabel?: string; disabled?: boolean }) {
  return <div className="business-task" aria-label={`${task.kind === "order" ? "订单" : "上架"}任务依据`}>
    <div className="business-task-heading"><strong>{task.title}</strong><span>{task.kind === "sales_plan" && task.state === "done" ? "可提交审核" : businessTaskLabels[task.state]}</span></div>
    <p className="business-task-goal">{task.goal}</p>
    {task.notices.map((notice, index) => <p className="business-task-notice" key={index}>{notice}</p>)}
    <ol className="business-task-stages" aria-label={planLabel}>{task.stages.map(stage => {
      const Icon = stage.state === "done" ? Check : stage.state === "working" ? LoaderCircle : stage.state === "blocked" || stage.state === "unavailable" ? CircleAlert : stage.state === "waiting" ? Clock3 : Circle;
      return <li key={stage.key} data-stage={stage.key} data-state={stage.state}>
        <Icon size={15} aria-hidden="true" />
        <div className="business-task-stage"><div><strong>{stage.label}</strong><span>{businessTaskLabels[stage.state]}</span></div><p>{stage.detail}</p>
          {!!stage.evidence.length && <details><summary>查看固定依据（{stage.evidence.length}）</summary><dl>{stage.evidence.map((item, index) => <div key={index}><dt>{item.label}</dt><dd>{item.value}</dd></div>)}</dl></details>}
        </div>
        {disabled ? <span className="business-task-disabled">先完成当前操作</span> : <Link href={stage.href}>{stage.action}</Link>}
      </li>;
    })}</ol>
    {!!task.metrics.length && <details className="business-task-metrics"><summary>执行效果与费用</summary>
      <dl>{task.metrics.map(metric => <div key={metric.key}><dt>{metric.label}</dt><dd>{metric.value ?? "尚无完整记录"}</dd><p>{metric.note}</p></div>)}</dl>
    </details>}
  </div>;
}
