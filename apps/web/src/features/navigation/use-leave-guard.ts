"use client";
import { useCallback, useEffect } from "react";

export function useLeaveGuard(dirty: boolean, busy: boolean, enabled = true) {
  const mayLeave = useCallback(
    () => !busy && (!dirty || window.confirm("有未保存的修改，确定放弃修改并离开？")),
    [busy, dirty],
  );
  useEffect(() => {
    if (!enabled || (!dirty && !busy)) return;
    const unload = (event: BeforeUnloadEvent) => {
      event.preventDefault();
      event.returnValue = "";
    };
    const click = (event: MouseEvent) => {
      if (event.defaultPrevented) return;
      const link = event.target instanceof Element ? event.target.closest("a[href]") : null;
      if (!busy && link?.hasAttribute("data-task-draft-link")) return;
      if (link && !link.hasAttribute("download") && !mayLeave()) {
        event.preventDefault();
        event.stopPropagation();
      }
    };
    window.addEventListener("beforeunload", unload);
    document.addEventListener("click", click, true);
    return () => {
      window.removeEventListener("beforeunload", unload);
      document.removeEventListener("click", click, true);
    };
  }, [dirty, busy, mayLeave, enabled]);
  return mayLeave;
}
