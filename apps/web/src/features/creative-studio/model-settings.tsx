"use client";
import { useState } from "react";
import Link from "next/link";
import { WorkflowReturnLink } from "../navigation/use-workflow-return";
import { useLeaveGuard } from "../navigation/use-leave-guard";
import { ModelConfigurationFrame } from "./model-configuration-frame";
import { AnalysisModelSettings } from "./analysis-model-settings";
import "./studio.css";

export function ModelSettings({ runtimeUrl }: { runtimeUrl: string | null }) {
  const [state, setState] = useState({ dirty: false, busy: false }), [revision, setRevision] = useState(0);
  const [tab, setTab] = useState<"channels" | "models" | "defaults">("channels");
  useLeaveGuard(state.dirty, state.busy);
  return <div className="studio-workspace studio-settings">
    <header className="studio-page-header"><div><h1>AI 模型配置</h1><p>画布、生图、视频和各业务 AI 助手共用渠道与模型。业务分析默认使用文本模型，密钥加密保存在 ERP 服务端。</p></div><div className="studio-actions"><WorkflowReturnLink label="返回原任务" /><Link href="/creative-designs/studio/image">进入生图工作台</Link></div></header>
    {runtimeUrl ? <ModelConfigurationFrame runtimeUrl={runtimeUrl} onState={setState} onSaved={() => setRevision(value => value + 1)} onView={setTab} /> : <p role="alert" className="studio-alert">创作配置服务尚未就绪。</p>}
    <div hidden={tab !== "models"}><AnalysisModelSettings revision={revision} /></div>
    <p>获取目录和保存配置不会发起生成。生成与分析会使用渠道额度，费用以渠道账单为准。</p>
  </div>;
}
