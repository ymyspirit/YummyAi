"use client";
import { useCallback, useEffect, useRef, useState } from "react";
import { WorkflowRunDetailSchema, type WorkflowRunDetail } from "@yummyai/contracts/workflow";
import { readWorkflow, WorkflowReadError } from "./workflow-operator-client";

export function useWorkflowRun(initial: WorkflowRunDetail, paused: boolean) {
  const [run, setRun] = useState(initial),
    [notice, setNotice] = useState<string>(),
    [locked, setLocked] = useState(false),
    [refreshKey, setRefreshKey] = useState(0);
  const inflight = useRef<{ signal: AbortSignal; promise: Promise<void> } | null>(null);
  useEffect(() => {
    setRun((current) => (initial.revision >= current.revision ? initial : current));
  }, [initial]);
  const refresh = useCallback(
    async (signal?: AbortSignal) => {
      if (inflight.current && !inflight.current.signal.aborted) return inflight.current.promise;
      const requestSignal = signal ?? AbortSignal.timeout(60_000);
      const promise = (async () => {
        try {
          const value = await readWorkflow(initial.id, WorkflowRunDetailSchema, requestSignal);
          if (!requestSignal.aborted) {
            setRun((current) => (value.revision >= current.revision ? value : current));
            setNotice(undefined);
            setLocked(false);
            setRefreshKey((value) => value + 1);
          }
        } catch (error) {
          if (signal?.aborted) return;
          setNotice(error instanceof Error ? error.message : "读取任务未完成");
          if (error instanceof WorkflowReadError && [401, 403, 404].includes(error.status))
            setLocked(true);
        }
      })();
      const current = { signal: requestSignal, promise };
      inflight.current = current;
      try {
        await promise;
      } finally {
        if (inflight.current === current) inflight.current = null;
      }
    },
    [initial.id],
  );
  useEffect(() => {
    if (run.status !== "active" || paused || locked) return;
    const controller = new AbortController();
    let timer: ReturnType<typeof setTimeout>;
    let ticking = false;
    const tick = async () => {
      if (ticking || controller.signal.aborted) return;
      ticking = true;
      try {
        if (document.visibilityState === "visible") await refresh(controller.signal);
      } finally {
        ticking = false;
        if (!controller.signal.aborted) timer = setTimeout(tick, 5000);
      }
    };
    timer = setTimeout(tick, 5000);
    const visible = () => {
      if (document.visibilityState === "visible") {
        clearTimeout(timer);
        void tick();
      }
    };
    document.addEventListener("visibilitychange", visible);
    return () => {
      controller.abort();
      clearTimeout(timer);
      document.removeEventListener("visibilitychange", visible);
    };
  }, [run.status, paused, locked, refresh]);
  return { run, refresh, refreshKey, notice, locked };
}
