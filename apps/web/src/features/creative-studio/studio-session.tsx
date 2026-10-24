"use client";
import { useState } from "react";
import dynamic from "next/dynamic";
import { usePathname, useSearchParams } from "next/navigation";
import { StudioScopeSchema, StudioToolSchema, type StudioTool } from "@yummyai/contracts/pod/creative-studio";
import { useStudioAccessFence } from "./studio-api";

const StudioWorkspace = dynamic(() => import("./studio-workspace").then(module => module.StudioWorkspace), {
  loading: () => <p role="status">正在读取创作项目…</p>,
});
type Selection = { tool: StudioTool; scope?: string };

export function StudioSession({ runtimeUrl }: { runtimeUrl: string | null }) {
  const access = useStudioAccessFence("session");
  const pathname = usePathname(), search = useSearchParams();
  const match = /^\/creative-designs\/studio\/([^/]+)\/?$/.exec(pathname);
  const tool = StudioToolSchema.safeParse(match?.[1]), scope = StudioScopeSchema.safeParse(search.get("brief"));
  const current: Selection | undefined = tool.success ? { tool: tool.data, scope: scope.success ? scope.data : undefined } : undefined;
  const [retained, setRetained] = useState<{ selection: Selection; identity: string } | undefined>(current ? { selection: current, identity: access.key } : undefined);
  if (current && (current.tool !== retained?.selection.tool || current.scope !== retained?.selection.scope || retained.identity !== access.key)) setRetained({ selection: current, identity: access.key });
  const selected = current ?? (retained?.identity === access.key ? retained.selection : undefined);
  // Mount only after visiting a creative tool, then keep the same DOM subtree
  // while other ERP routes render beside it. Hiding never disconnects the iframe.
  if (!selected || !access.available) return null;
  return <div data-studio-session hidden={!current}>
    <StudioWorkspace key={access.key} tool={selected.tool} initialScope={selected.scope} runtimeUrl={runtimeUrl} active={!!current} />
  </div>;
}
