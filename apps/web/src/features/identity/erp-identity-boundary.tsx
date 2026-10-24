"use client";
import { useCallback, useContext, useEffect, useRef, useState } from "react";
import { LogOut, RefreshCw, UserRound } from "lucide-react";
import {
  ErpSessionViewSchema,
  erpSessionAuthority,
  type ErpSessionView,
} from "@yummyai/contracts/auth/session";
import { cancelViewTransitions } from "../navigation/view-transition";
import { clearSessionTaskDrafts } from "../navigation/task-draft";
import { ErpIdentityContext } from "./erp-access";
import { confirmErpLogout } from "./erp-logout";
import "./identity.css";
export function ErpIdentityBoundary({
  session,
  localDevelopment = false,
  children,
}: {
  session: ErpSessionView | null;
  localDevelopment?: boolean;
  children: React.ReactNode;
}) {
  const [blocked, setBlocked] = useState<string | null>(null),
    [lost, setLost] = useState(false),
    [busy, setBusy] = useState(false),
    frame = useRef<HTMLDivElement | null>(null),
    generation = useRef(0),
    active = useRef<AbortController | null>(null),
    leaving = useRef(false);
  const hide = useCallback(() => {
    cancelViewTransitions();
    if (frame.current) {
      frame.current.hidden = true;
      frame.current.inert = true;
    }
  }, []);
  const replaceLogin = useCallback(() => {
    if (leaving.current) return;
    leaving.current = true;
    generation.current++;
    active.current?.abort();
    clearSessionTaskDrafts();
    hide();
    setLost(true);
    window.location.replace("/login");
  }, [hide]);
  const check = useCallback(async () => {
    if (!session || leaving.current) return;
    if (frame.current?.hidden) setBlocked("正在核对当前身份");
    const version = ++generation.current;
    active.current?.abort();
    const abort = new AbortController();
    active.current = abort;
    try {
      const response = await fetch("/api/erp-auth/session", {
        cache: "no-store",
        signal: abort.signal,
      });
      if (version !== generation.current) return;
      if ([401, 403].includes(response.status)) {
        replaceLogin();
        return;
      }
      if (!response.ok) throw Error();
      const current = ErpSessionViewSchema.parse(await response.json());
      if (version !== generation.current) return;
      if (!current.canUseErp || erpSessionAuthority(current) !== erpSessionAuthority(session)) {
        leaving.current = true;
        generation.current++;
        active.current?.abort();
        clearSessionTaskDrafts({ preserveAssistIntents: current.tenantId === session.tenantId && current.userId === session.userId });
        hide();
        setLost(true);
        window.location.replace(window.location.href);
        return;
      }
      setBlocked(null);
      if (frame.current) {
        frame.current.hidden = false;
        frame.current.inert = false;
      }
    } catch {
      if (abort.signal.aborted || version !== generation.current) return;
      hide();
      setBlocked("当前身份暂时无法核对 内容已暂时隐藏 请重试");
    }
  }, [hide, replaceLogin, session]);
  useEffect(() => {
    if (!session) return;
    const shown = () => {
        if (document.visibilityState !== "hidden") void check();
      },
      pageHide = () => hide();
    const timer = window.setInterval(shown, 30000);
    window.addEventListener("focus", shown);
    window.addEventListener("pageshow", shown);
    window.addEventListener("pagehide", pageHide);
    document.addEventListener("visibilitychange", shown);
    return () => {
      generation.current++;
      active.current?.abort();
      window.clearInterval(timer);
      window.removeEventListener("focus", shown);
      window.removeEventListener("pageshow", shown);
      window.removeEventListener("pagehide", pageHide);
      document.removeEventListener("visibilitychange", shown);
    };
  }, [check, hide, session]);
  async function logout() {
    if (busy) return;
    leaving.current = true;
    generation.current++;
    active.current?.abort();
    clearSessionTaskDrafts();
    hide();
    setBusy(true);
    setBlocked("正在退出登录");
    try {
      await confirmErpLogout();
      setLost(true);
      window.location.replace("/login");
    } catch {
      setBlocked("退出状态尚未确认 请重试退出");
    } finally {
      setBusy(false);
    }
  }
  return (
    <ErpIdentityContext.Provider value={{ session, localDevelopment, logout: () => void logout() }}>
      <div ref={frame} hidden={lost} aria-label="运营工作台内容">
        {!lost && children}
      </div>
      {blocked && (
        <div className="erp-identity-blocked" role="alert">
          <p>{blocked}</p>
          <button disabled={busy} onClick={() => (leaving.current ? void logout() : void check())}>
            <RefreshCw size={16} />
            {leaving.current ? "重试退出" : "重新核对"}
          </button>
        </div>
      )}
    </ErpIdentityContext.Provider>
  );
}
export function ErpSessionControl() {
  const identity = useContext(ErpIdentityContext);
  if (!identity) return null;
  const { session, logout, localDevelopment } = identity;
  return (
    <div className="erp-session-control" data-personal={session ? "true" : undefined}>
      {session ? (
        <>
          <span title={`${session.organizationName} · ${session.displayName}`}>
            <UserRound size={14} />
            {session.displayName}
          </span>
          <button type="button" onClick={logout} aria-label="退出登录">
            <LogOut size={15} />
            <span>退出</span>
          </button>
        </>
      ) : (
        <span>{localDevelopment ? "本地开发身份" : "身份待核对"}</span>
      )}
    </div>
  );
}
