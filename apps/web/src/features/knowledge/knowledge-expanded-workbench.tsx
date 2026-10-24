"use client";
import { useEffect, useLayoutEffect, useRef, useState } from "react";
import { useSearchParams } from "next/navigation";
import { Permission } from "@yummyai/authz/permissions";
import {
  KnowledgeGovernanceViewSchema,
  type KnowledgeGovernanceView,
} from "@yummyai/contracts/knowledge/governance";
import type { KnowledgeWorkspace } from "@yummyai/contracts/knowledge";
import { governanceApi, knowledgeReadDenied } from "./knowledge-api";
import { useErpAccess } from "../identity/erp-access";
import { clearEvaluationIntents } from "./knowledge-evaluation-recovery";
import { KnowledgeImports } from "./knowledge-imports";
import { KnowledgeGovernance } from "./knowledge-governance";
import { KnowledgeChat } from "./knowledge-chat";
export function KnowledgeExpandedWorkbench({
  view,
  library,
  onChanged,
}: {
  view: "imports" | "governance" | "chat";
  library: KnowledgeWorkspace;
  onChanged: () => void;
}) {
  const access = useErpAccess(), owner = useRef({ preference: access.preferenceScope, authority: access.authority });
  const matches = owner.current.preference === access.preferenceScope && owner.current.authority === access.authority;
  const allowed = access.authority !== null && access.can(Permission.WorkflowRead);
  useLayoutEffect(() => { if (!matches || !allowed) clearEvaluationIntents(); }, [matches, allowed]);
  if (!matches || !allowed) return <p className="kb-error" role="status">当前身份或知识读取范围已变化 原资料和填写已隐藏 请重新核对当前身份权限</p>;
  return <ExpandedSession key={access.authority} view={view} library={library} onChanged={onChanged} />;
}
function ExpandedSession({ view, library, onChanged }: {
  view: "imports" | "governance" | "chat"; library: KnowledgeWorkspace; onChanged(): void;
}) {
  const access = useErpAccess(), alive = useRef(true), generation = useRef(0), current = useRef(access.authority);
  current.current = access.authority;
  const params = useSearchParams(),
    [data, setData] = useState<KnowledgeGovernanceView | null>(null),
    [error, setError] = useState(""),
    [refresh, setRefresh] = useState(0);
  useEffect(() => { alive.current = true; return () => { alive.current = false; generation.current++; }; }, []);
  useEffect(() => {
    const controller = new AbortController(), token = ++generation.current, authority = current.current;
    const valid = () => alive.current && !controller.signal.aborted && generation.current === token && current.current === authority;
    setData(null); setError("");
    governanceApi("workspace", undefined, controller.signal)
      .then((value) => {
        if (!valid()) return;
        setData(KnowledgeGovernanceViewSchema.parse(value));
        setError("");
      })
      .catch((e) => {
        if (valid()) {
          setData(null);
          if (knowledgeReadDenied(e)) { clearEvaluationIntents(); window.dispatchEvent(new Event("focus")); }
          setError(e instanceof Error ? e.message : "治理资料读取失败");
        }
      });
    return () => controller.abort();
  }, [refresh]);
  const changed = () => {
    setRefresh((v) => v + 1);
    onChanged();
  };
  if (error)
    return (
      <p className="kb-error" role="alert">
        {error}
        <button className="oc-button" onClick={() => setRefresh((v) => v + 1)}>
          重试
        </button>
      </p>
    );
  if (!data) return <p role="status">正在读取知识治理资料…</p>;
  return view === "imports" ? (
    <KnowledgeImports
      data={data}
      library={library}
      onChanged={changed}
      initialId={params.get("document") ?? ""}
    />
  ) : view === "governance" ? (
    <KnowledgeGovernance data={data} library={library} onChanged={changed} />
  ) : (
    <KnowledgeChat data={data} library={library} />
  );
}
