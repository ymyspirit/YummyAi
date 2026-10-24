"use client";
import { useLayoutEffect, useState } from "react";
import Link from "next/link";
import { Permission } from "@yummyai/authz/permissions";
import { ASSIST_INTENT_CLEAR_EVENT } from "@yummyai/contracts/ai/assist-recovery";
import { useErpAccess } from "../identity/erp-access";
import { WorkflowReturnLink } from "../navigation/use-workflow-return";
import { useLeaveGuard } from "../navigation/use-leave-guard";
import { ModelConfigurationFrame } from "./model-configuration-frame";
import { AnalysisModelSettings } from "./analysis-model-settings";
import "./studio.css";

export function ModelSettings({ runtimeUrl }: { runtimeUrl: string | null }) {
  const access = useErpAccess();
  if (!access.authority || !access.preferenceScope) return <section className="studio-workspace studio-settings"><h1>AI 模型配置</h1><p role="status">当前本人身份尚未核对 模型配置与填写已隐藏</p></section>;
  if (!access.can(Permission.ModelConfigure)) return <section className="studio-workspace studio-settings"><h1>AI 模型配置</h1><p role="status">当前账号没有模型配置权限 请由有权限的人员核对模型与费用设置</p></section>;
  return <ModelSettingsContent key={access.preferenceScope + ":" + access.authority} runtimeUrl={runtimeUrl} />;
}

function ModelSettingsContent({ runtimeUrl }: { runtimeUrl: string | null }) {
  const [state, setState] = useState({ dirty: false, busy: false }), [revision, setRevision] = useState(0);
  const [cleared, setCleared] = useState(false);
  useLayoutEffect(() => {
    const clear = () => setCleared(true);
    window.addEventListener(ASSIST_INTENT_CLEAR_EVENT, clear);
    return () => window.removeEventListener(ASSIST_INTENT_CLEAR_EVENT, clear);
  }, []);
  useLeaveGuard(!cleared && state.dirty, !cleared && state.busy);
  if (cleared) return <section className="studio-workspace studio-settings"><h1>AI 模型配置</h1><p role="status">当前本人会话已清除 配置界面与填写已隐藏</p></section>;
  return <div className="studio-workspace studio-settings">
    <header className="studio-page-header"><div><h1>AI 模型配置</h1><p>画布、生图、视频和各业务 AI 助手共用渠道与模型。业务分析默认使用文本模型，密钥加密保存在 ERP 服务端。</p></div><div className="studio-actions"><WorkflowReturnLink label="返回原任务" /><Link href="/creative-designs/studio/image">进入生图工作台</Link></div></header>
    <AnalysisModelSettings revision={revision} />
    <section className="studio-settings-runtime" aria-label="渠道与默认模型配置"><h2>渠道与默认模型配置</h2><p>下方画布配置界面用于管理渠道与默认模型 连接失败时仍可在上方核对已配置渠道的分析模型与费用 不会自动启动配置服务</p>
      {runtimeUrl ? <ModelConfigurationFrame runtimeUrl={runtimeUrl} onState={setState} onSaved={() => setRevision(value => value + 1)} onView={() => undefined} /> : <p role="alert" className="studio-alert">渠道与默认模型配置界面尚未就绪 分析费用区可独立读取 完全没有已启用渠道时仍需先完成渠道配置</p>}
    </section>
    <p>获取目录和保存配置不会发起生成。生成与分析会使用渠道额度，费用以渠道账单为准。</p>
  </div>;
}
