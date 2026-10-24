"use client";

import {
  createContext,
  useContext,
  useEffect,
  useId,
  useLayoutEffect,
  useRef,
  useState,
  type ReactNode,
} from "react";
import { createPortal } from "react-dom";
import { ChevronLeft, ChevronRight, X } from "lucide-react";
import { useLeaveGuard } from "./use-leave-guard";
import "./task-drawer.css";

export type TaskDrawerState = { dirty: boolean; busy: boolean; loading: boolean };
const FooterContext = createContext<HTMLElement | null>(null);
const DrawerContext = createContext(false);
export const useInTaskDrawer = () => useContext(DrawerContext);

/** A form can keep its submit logic while placing its actions in the fixed footer. */
export function TaskDrawerActions({ children }: { children: ReactNode }) {
  const footer = useContext(FooterContext);
  return footer ? createPortal(children, footer) : children;
}

export function TaskDrawer({
  title,
  description,
  recordKey,
  state,
  children,
  onClose,
  closeLabel = "关闭详情",
  previous,
  next,
  footer,
  fullScreen = false,
  contentOwnsScroll = false,
  contentUnavailable = false,
  className = "",
}: {
  title: string;
  description?: string;
  recordKey?: string;
  state: TaskDrawerState;
  children: ReactNode;
  onClose: () => void;
  closeLabel?: string;
  previous?: { label: string; action?: () => void };
  next?: { label: string; action?: () => void };
  footer?: ReactNode;
  fullScreen?: boolean;
  contentOwnsScroll?: boolean;
  contentUnavailable?: boolean;
  className?: string;
}) {
  const dialog = useRef<HTMLDialogElement>(null);
  const heading = useRef<HTMLHeadingElement>(null);
  const body = useRef<HTMLDivElement>(null);
  const titleId = useId();
  const [actionHost, setActionHost] = useState<HTMLDivElement | null>(null);
  const mayLeave = useLeaveGuard(state.dirty, state.busy);
  const navigation = useRef({ mayLeave, href: "" });
  const fallbackEntry = useRef<{ token: string; href: string } | null>(null);
  useLayoutEffect(() => {
    navigation.current = { mayLeave, href: location.href };
  });
  useLayoutEffect(() => {
    if ((window as Window & { navigation?: EventTarget }).navigation || fullScreen) return;
    const entry = fallbackEntry.current;
    if (!state.dirty && !state.busy) {
      fallbackEntry.current = null;
      if (entry && history.state?.taskDrawerGuard === entry.token && location.href === entry.href)
        history.back();
      return;
    }
    if (entry?.href === location.href) return;
    const token = crypto.randomUUID();
    fallbackEntry.current = { token, href: location.href };
    // Without Navigation API, Back first traverses an identical URL. React keeps
    // the form mounted while its operator decides whether to discard the draft.
    history.pushState({ ...history.state, taskDrawerGuard: token }, "", location.href);
  }, [state.dirty, state.busy, recordKey, fullScreen]);
  useEffect(() => {
    const element = dialog.current;
    const trigger = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    const overflow = document.body.style.overflow;
    element?.showModal();
    document.body.style.overflow = "hidden";
    heading.current?.focus({ preventScroll: true });
    const browserNavigation = (window as Window & { navigation?: EventTarget }).navigation;
    let allowedTraversal = false;
    const navigate = (event: Event) => {
      if (
        (event as Event & { navigationType?: string }).navigationType !== "traverse" ||
        !event.cancelable
      )
        return;
      if (!navigation.current.mayLeave()) event.preventDefault();
      else allowedTraversal = true;
    };
    const pop = (event: PopStateEvent) => {
      if (allowedTraversal) {
        allowedTraversal = false;
        return;
      }
      const current = navigation.current;
      const entry = fallbackEntry.current;
      if (entry && history.state?.taskDrawerGuard === entry.token) return;
      if (!browserNavigation && entry && location.href === entry.href) {
        if (!current.mayLeave()) history.forward();
        else {
          fallbackEntry.current = null;
          allowedTraversal = true;
          history.back();
        }
        return;
      }
      if (current.mayLeave()) return;
      event.stopImmediatePropagation();
      history.pushState(null, "", current.href);
    };
    browserNavigation?.addEventListener("navigate", navigate);
    window.addEventListener("popstate", pop, true);
    return () => {
      browserNavigation?.removeEventListener("navigate", navigate);
      window.removeEventListener("popstate", pop, true);
      element?.close();
      document.body.style.overflow = overflow;
      if (trigger?.isConnected) trigger.focus({ preventScroll: true });
    };
  }, []);
  useEffect(() => {
    if (body.current) body.current.scrollTop = 0;
    heading.current?.focus({ preventScroll: true });
  }, [recordKey]);
  const leave = (action?: () => void) => {
    if (action && mayLeave()) action();
  };
  return (
    <dialog
      ref={dialog}
      className={`oc-page task-drawer ${className}`}
      data-fullscreen={fullScreen || undefined}
      data-editor={fullScreen || undefined}
      aria-labelledby={titleId}
      onCancel={(event) => {
        event.preventDefault();
        if (!fullScreen) leave(onClose);
      }}
    >
      <header className="task-drawer-header" hidden={fullScreen}>
        <div className="task-drawer-title">
          <h2 id={titleId} ref={heading} tabIndex={-1}>
            {title}
          </h2>
          {description && <span aria-live="polite">{description}</span>}
        </div>
        <div className="oc-actions">
          {previous && (
            <button
              className="oc-button"
              disabled={!previous.action || state.busy || state.loading}
              onClick={() => leave(previous.action)}
            >
              <ChevronLeft size={15} />
              {previous.label}
            </button>
          )}
          {next && (
            <button
              className="oc-button"
              disabled={!next.action || state.busy || state.loading}
              onClick={() => leave(next.action)}
            >
              {next.label}
              <ChevronRight size={15} />
            </button>
          )}
          <button
            className="oc-icon-button"
            aria-label={closeLabel}
            title="关闭详情，返回列表"
            disabled={state.busy}
            onClick={() => leave(onClose)}
          >
            <X size={18} />
          </button>
        </div>
      </header>
      <DrawerContext.Provider value={true}>
        <FooterContext.Provider value={actionHost}>
          {contentOwnsScroll ? (
            children
          ) : (
            <div
              className="task-drawer-body"
              ref={body}
              hidden={contentUnavailable}
              inert={contentUnavailable}
              style={contentUnavailable ? { display: "none" } : undefined}
            >
              {children}
            </div>
          )}
        </FooterContext.Provider>
      </DrawerContext.Provider>
      {!contentOwnsScroll && !fullScreen && (
        <footer className="task-drawer-footer">
          <span className="task-drawer-save-state" role="status">
            {state.busy ? "正在保存，请稍候…" : state.dirty ? "有未保存的修改" : ""}
          </span>
          {footer}
          <button className="oc-button" disabled={state.busy} onClick={() => leave(onClose)}>
            关闭
          </button>
          <div
            ref={setActionHost}
            className="oc-actions task-drawer-form-actions"
            hidden={contentUnavailable}
            inert={contentUnavailable}
            style={contentUnavailable ? { display: "none" } : undefined}
          />
        </footer>
      )}
    </dialog>
  );
}
