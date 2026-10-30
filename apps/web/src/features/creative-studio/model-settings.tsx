"use client";
import { useCallback, useLayoutEffect, useState } from "react";
import Link from "next/link";
import { Permission } from "@yummyai/authz/permissions";
import { ASSIST_INTENT_CLEAR_EVENT } from "@yummyai/contracts/ai/assist-recovery";
import { STUDIO_PERSONAL_CLEAR_EVENT } from "@yummyai/contracts/pod/studio-personal";
import { useErpAccess } from "../identity/erp-access";
import { WorkflowReturnLink } from "../navigation/use-workflow-return";
import { useLeaveGuard } from "../navigation/use-leave-guard";
import { ModelConfigurationFrame } from "./model-configuration-frame";
import { AnalysisModelSettings } from "./analysis-model-settings";
import { ModelSettingsWorkbench } from "./model-settings-workbench";
import { ModelBillingWorkbench } from "../model-billing/model-billing-workbench";
import "./studio.css";

export function ModelSettings({ runtimeUrl }: { runtimeUrl: string | null }) {
  const access = useErpAccess();
  if (!access.authority || !access.preferenceScope) return <section className="studio-workspace studio-settings"><h1>AI 模型配置</h1><p role="status">当前本人身份尚未核对 模型配置与填写已隐藏</p></section>;
  if (!access.can(Permission.ModelConfigure)) return <section className="studio-workspace studio-settings"><h1>AI 模型配置</h1><p role="status">当前账号没有模型配置权限 请由有权限的人员核对模型与费用设置</p></section>;
  return <ModelSettingsContent key={access.preferenceScope + ":" + access.authority} runtimeUrl={runtimeUrl} />;
}

function ModelSettingsContent({ runtimeUrl }: { runtimeUrl: string | null }) {
  const [state, setState] = useState({ dirty: false, busy: false }), [nativeState, setNativeState] = useState({ dirty: false, busy: false }), [revision, setRevision] = useState(0);
  const onNativeState = useCallback((value: { dirty: boolean; busy: boolean }) => setNativeState(value), []);
  const [cleared, setCleared] = useState(false);
  useLayoutEffect(() => {
    const clear = () => setCleared(true);
    window.addEventListener(ASSIST_INTENT_CLEAR_EVENT, clear);
    window.addEventListener(STUDIO_PERSONAL_CLEAR_EVENT, clear);
    return () => { window.removeEventListener(ASSIST_INTENT_CLEAR_EVENT, clear); window.removeEventListener(STUDIO_PERSONAL_CLEAR_EVENT, clear); };
  }, []);
  useLeaveGuard(!cleared && (state.dirty || nativeState.dirty), !cleared && (state.busy || nativeState.busy));
  if (cleared) return <section className="studio-workspace studio-settings"><h1>AI 模型配置</h1><p role="status">当前本人会话已清除 配置界面与填写已隐藏</p></section>;
  return <div className="studio-workspace studio-settings">
    <header className="studio-page-header"><div><h1>AI 模型配置</h1><p>渠道与模型统一管理 为订单 设计和 Agent 设置本人默认 费用在同一处核对</p></div><div className="studio-actions"><WorkflowReturnLink label="返回原任务" /><Link href="/creative-designs/studio/image">进入生图工作台</Link></div></header>
    <ModelSettingsWorkbench revision={revision} onState={onNativeState} billing={<ModelBillingWorkbench embedded />} advanced={<>
      <AnalysisModelSettings revision={revision} />
      <section className="studio-settings-runtime" aria-label="渠道与默认模型配置"><h2>画布兼容配置</h2><p>原画布配置保留 与本页读取同一份 ERP 渠道和模型</p>
        {runtimeUrl ? <ModelConfigurationFrame runtimeUrl={runtimeUrl} onState={setState} onSaved={() => setRevision(value => value + 1)} onView={() => undefined} /> : <p role="alert" className="studio-alert">画布兼容配置暂未就绪 可继续使用本页的渠道 模型和业务默认</p>}
      </section>
    </>} />
  </div>;
}
