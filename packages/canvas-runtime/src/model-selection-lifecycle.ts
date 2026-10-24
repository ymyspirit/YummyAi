import { StudioWorkspaceSchema, type StudioWorkspace } from "@yummyai/contracts/pod/studio-personal";

/** Bind catalogue ownership to the same authenticated parent as the RPC bridge. */
export function bindStudioModelLifecycle(options: {
  target: EventTarget; source: MessageEventSource; origin: string; channel: string; scope: string;
  onWorkspace: (workspace: StudioWorkspace) => void; onClear: () => void;
}) {
  let live = true;
  const clear = () => { if (live) { live = false; options.onClear(); } };
  const message = (event: Event) => {
    const received = event as MessageEvent;
    if (!live || received.source !== options.source || received.origin !== options.origin || received.data?.channel !== options.channel) return;
    if (received.data.type === "studio.clear") { clear(); return; }
    if (received.data.type !== "studio.workspace") return;
    const parsed = StudioWorkspaceSchema.safeParse(received.data.workspace);
    if (!parsed.success) return;
    if (parsed.data.scope !== options.scope) { clear(); return; }
    options.onWorkspace(parsed.data);
  };
  options.target.addEventListener("message", message);
  options.target.addEventListener("pagehide", clear);
  return () => { clear(); options.target.removeEventListener("message", message); options.target.removeEventListener("pagehide", clear); };
}
