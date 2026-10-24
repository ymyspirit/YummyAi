type AccessChecks<T> = {
  signal: AbortSignal;
  isCurrent: () => boolean;
  read: (signal: AbortSignal) => Promise<T>;
  onValue: (value: T) => void;
  onError: (cause: unknown) => void;
};

/** One captured owner has one read in flight. Repeated triggers retain one
 * trailing check without cancelling a completed response or its current read. */
export function createStudioAccessChecks<T>(options: AccessChecks<T>) {
  let stopped = false, trailing = false, active: AbortController | undefined;
  let deadline: ReturnType<typeof setTimeout> | undefined;
  const current = () => !stopped && !options.signal.aborted && options.isCurrent();
  const stop = () => {
    stopped = true; trailing = false;
    const pending = active; active = undefined; pending?.abort();
    if (deadline !== undefined) clearTimeout(deadline); deadline = undefined;
    options.signal.removeEventListener("abort", stop);
  };
  const request = () => {
    if (!current()) return;
    if (active) { trailing = true; return; }
    const controller = new AbortController(); active = controller;
    let timedOut = false;
    const timer = setTimeout(() => { timedOut = true; controller.abort(new DOMException("创作访问核对超时", "TimeoutError")); }, 20_000); deadline = timer;
    void (async () => {
      try {
        const value = await options.read(controller.signal);
        if (current() && active === controller && !controller.signal.aborted) options.onValue(value);
      } catch (cause) {
        if (current() && active === controller && (!controller.signal.aborted || timedOut)) options.onError(cause);
      } finally {
        clearTimeout(timer);
        if (deadline === timer) deadline = undefined;
        if (active === controller) active = undefined;
        const repeat = trailing; trailing = false;
        if (repeat && current()) request();
      }
    })();
  };
  if (options.signal.aborted) stop(); else options.signal.addEventListener("abort", stop, { once: true });
  return { request, stop };
}
