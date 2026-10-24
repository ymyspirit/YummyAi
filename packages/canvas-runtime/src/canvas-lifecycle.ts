type Viewport = { x: number; y: number; k: number };
export function createCanvasIfAllowed(writable: () => boolean, create: () => void) { if (writable()) create(); }
export function restoredViewport(value: unknown): Viewport {
  if (value && typeof value === "object" && "x" in value && "y" in value && "k" in value &&
    typeof value.x === "number" && Number.isFinite(value.x) && Math.abs(value.x) <= 1e9 &&
    typeof value.y === "number" && Number.isFinite(value.y) && Math.abs(value.y) <= 1e9 &&
    typeof value.k === "number" && Number.isFinite(value.k) && value.k >= .05 && value.k <= 5) return { x: value.x, y: value.y, k: value.k };
  return { x: 0, y: 0, k: 1 };
}
export function fitCanvasBounds(bounds: { left: number; top: number; right: number; bottom: number }, size: { width: number; height: number }): Viewport | null {
  const { left, top, right, bottom } = bounds;
  if (![left, top, right, bottom, size.width, size.height].every(Number.isFinite) || right <= left || bottom <= top || size.width < 100 || size.height < 100) return null;
  const k = Math.min(1, Math.max(.05, Math.min((size.width - 64) / (right - left), (size.height - 120) / (bottom - top))));
  return { x: size.width / 2 - (left + right) / 2 * k, y: (size.height - 56) / 2 - (top + bottom) / 2 * k, k };
}

export function createCanvasLifecycles() {
  let active: ReturnType<typeof create> | undefined;
  function create(id: string) {
    let mounted = false, restored = false, epoch = 0, controller = new AbortController();
    const lease = { id,
      activate() { if (active && active !== lease) active.release(); mounted = true; active = lease; },
      release() { mounted = false; restored = false; epoch++; controller.abort(); if (active === lease) active = undefined; },
      beginRestore() { restored = false; const attempt = ++epoch; controller.abort(); controller = new AbortController(); return () => mounted && active === lease && attempt === epoch && !controller.signal.aborted; },
      cancelRestore() { epoch++; restored = false; controller.abort(); },
      markRestored() { if (mounted && active === lease) restored = true; },
      current() { return mounted && active === lease && !controller.signal.aborted; },
      canSave() { return lease.current() && restored; },
      stamp() { return epoch; },
      get signal() { return controller.signal; },
    };
    return lease;
  }
  const captureWrite = () => { const captured = active, stamp = captured?.stamp(); return () => !!captured && captured === active && captured.stamp() === stamp && captured.canSave(); };
  return { create, canWrite: (id: string) => active?.id === id && active.canSave(), captureWrite,
    captureOperation() { return { current: captureWrite(), signal: active?.signal }; },
  };
}
export const canvasLifecycles = createCanvasLifecycles();
