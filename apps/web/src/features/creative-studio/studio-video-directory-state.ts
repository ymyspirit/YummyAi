import { StudioVideoDirectorySchema, StudioVideoPreflightSchema, type StudioVideoDirectory, type StudioVideoPreflight } from "@yummyai/contracts/pod/studio-video-directory";
import type { StudioTool } from "@yummyai/contracts/pod/creative-studio";

/** A late denied-route notice cannot pull an operator away from another tool. */
export function createStudioVideoRequiredNavigation(options: {
  current: () => { active: boolean; tool: StudioTool; scope: string; authority?: string };
  navigate: (scope: string) => void;
}) {
  return (message: unknown) => {
    if (!message || typeof message !== "object") return;
    const value = message as Record<string, unknown>, owner = options.current();
    if (owner.active && owner.tool === "video" && owner.authority && value.type === "studio.video-required" && value.scope === owner.scope && value.contextAuthority === owner.authority) options.navigate(owner.scope);
  };
}

export type VideoDirectoryState = { phase: "idle" | "reading" | "ready" | "opening" | "opened" | "blocked" | "error"; directory?: StudioVideoDirectory; preflight?: StudioVideoPreflight; error?: string };
export function createStudioVideoDirectory(options: {
  current: () => void;
  call: (input: Record<string, unknown>, signal: AbortSignal) => Promise<unknown>;
  admission: (value: StudioVideoPreflight | null) => void;
  failure: (cause: unknown) => void;
}) {
  let state: VideoDirectoryState = { phase: "idle" }, epoch = 0, stopped = false, active: AbortController | undefined;
  const listeners = new Set<() => void>();
  const publish = (value: VideoDirectoryState) => { state = value; for (const listener of listeners) listener(); };
  const current = (captured: number, controller: AbortController) => { if (stopped || captured !== epoch || controller.signal.aborted) throw new DOMException("视频历史读取已结束", "AbortError"); options.current(); };
  const fail = (cause: unknown, captured: number, controller: AbortController) => {
    try { current(captured, controller); } catch { return; }
    options.admission(null); options.failure(cause);
    try { current(captured, controller); } catch { return; }
    publish({ phase: "error", error: cause instanceof Error ? cause.message : "视频历史暂时无法读取 原记录保持" });
  };
  return {
    activate() { if (stopped) { stopped = false; state = { phase: "idle" }; } },
    snapshot: () => state,
    subscribe: (listener: () => void) => { listeners.add(listener); return () => { listeners.delete(listener); }; },
    async read() {
      if (stopped) return;
      active?.abort(); const controller = new AbortController(), captured = ++epoch; active = controller;
      options.admission(null); publish({ phase: "reading" });
      try {
        current(captured, controller); const raw = await options.call({ operation: "video.directory" }, controller.signal); current(captured, controller);
        const parsed = StudioVideoDirectorySchema.safeParse(raw);
        if (!parsed.success) throw new Error("视频历史目录不完整或格式无效 原记录保持 请重新读取");
        publish({ phase: "ready", directory: parsed.data });
      } catch (cause) { fail(cause, captured, controller); }
      finally { if (active === controller) active = undefined; }
    },
    async open() {
      if (stopped || !state.directory || !["ready", "blocked"].includes(state.phase)) return;
      const captured = ++epoch, directory = state.directory, controller = new AbortController(); active = controller;
      options.admission(null); publish({ phase: "opening", directory });
      try {
        current(captured, controller); const raw = await options.call({ operation: "video.preflight", snapshotHash: directory.snapshotHash }, controller.signal); current(captured, controller);
        const parsed = StudioVideoPreflightSchema.safeParse(raw), ids = new Set(directory.items.map(item => item.entryId));
        if (!parsed.success || parsed.data.snapshotHash !== directory.snapshotHash || parsed.data.total !== directory.total || parsed.data.blockedEntryIds.some(id => !ids.has(id)))
          throw new Error("视频历史预检与原目录不一致 请重新读取 原记录保持");
        const preflight = parsed.data;
        if (!preflight.canOpen) { publish({ phase: "blocked", directory, preflight }); return; }
        current(captured, controller); options.admission(preflight); publish({ phase: "opened", directory, preflight });
      } catch (cause) { fail(cause, captured, controller); }
      finally { if (active === controller) active = undefined; }
    },
    stop() { stopped = true; epoch++; active?.abort(); active = undefined; options.admission(null); publish({ phase: "idle" }); },
  };
}
