// Preserve the original profile when an older daily manifest is restored.
export const orderWorkerQueues = Object.freeze([
  "amazon-order-report-processing", "customization-file-scan", "production-editor-render",
  "order-design", "logistics", "shipment-writeback",
]);
export const orderWorkerSchedulers = Object.freeze(["productionRenderDispatcher", "orderDesignDispatcher"]);
export const orderWorkerProfile = "order-fulfillment-v1";
export const orderWorkerProfiles = Object.freeze({
  [orderWorkerProfile]: Object.freeze({ queues: orderWorkerQueues, schedulers: orderWorkerSchedulers }),
  "order-fulfillment-v2": Object.freeze({
    queues: Object.freeze([...orderWorkerQueues, "amazon-order-report-retention"]), schedulers: orderWorkerSchedulers,
  }),
});

export function orderWorkerReady(value, pid, profile = orderWorkerProfile) {
  if (!Object.hasOwn(orderWorkerProfiles, profile)) return false;
  const expected = orderWorkerProfiles[profile];
  const equal = (actual, expected) => Array.isArray(actual) && actual.length === expected.length
    && [...actual].sort().join() === [...expected].sort().join();
  return value?.state === "ready" && Number.isSafeInteger(pid) && value.pid === pid
    && equal(value.queues, expected.queues) && equal(value.schedulers, expected.schedulers);
}
