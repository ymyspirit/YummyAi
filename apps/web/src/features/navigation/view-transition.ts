/** Animation readiness can reject when a native transition is skipped. Observe
 * each lifecycle promise; actual DOM-update failures must still reach error QA. */
const activeTransitions = new Set<ViewTransition>();
export function cancelViewTransitions() {
  for (const transition of activeTransitions) transition.skipTransition();
  activeTransitions.clear();
}
export function observeViewTransition(transition: ViewTransition) {
  activeTransitions.add(transition);
  void transition.finished.then(
    () => activeTransitions.delete(transition),
    () => activeTransitions.delete(transition),
  );
  void transition.ready.catch(() => undefined);
  void transition.finished.catch(() => undefined);
  void transition.updateCallbackDone.catch((error: unknown) => {
    if (typeof globalThis.reportError === "function") globalThis.reportError(error);
    else
      setTimeout(() => {
        throw error;
      }, 0);
  });
  return transition;
}
