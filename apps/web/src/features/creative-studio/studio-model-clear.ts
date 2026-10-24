import { ASSIST_INTENT_CLEAR_EVENT } from "@yummyai/contracts/ai/assist-recovery";
import { STUDIO_PERSONAL_CLEAR_EVENT } from "@yummyai/contracts/pod/studio-personal";

/** Cancellation must still reach the old frame after the authority epoch changed. */
export function bindStudioModelClear(events: EventTarget, frame: () => Pick<Window, "postMessage"> | null,
  origin: string, channel: () => string) {
  const clear = () => {
    const selected = channel(); if (!selected) return;
    try { frame()?.postMessage({ type: "studio.clear", channel: selected }, origin); }
    catch { /* Local clearing and iframe disposal remain independent of delivery. */ }
  };
  let active = true;
  events.addEventListener(ASSIST_INTENT_CLEAR_EVENT, clear);
  events.addEventListener(STUDIO_PERSONAL_CLEAR_EVENT, clear);
  return () => {
    if (!active) return; active = false;
    clear();
    events.removeEventListener(ASSIST_INTENT_CLEAR_EVENT, clear);
    events.removeEventListener(STUDIO_PERSONAL_CLEAR_EVENT, clear);
  };
}
