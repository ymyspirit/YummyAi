// Only the reviewed order workflow is included. General AI, publishing, media
// backlogs and retention queues are not enabled by the daily order profile.
export const orderWorkerQueues = Object.freeze([
  "amazon-order-report-processing", "customization-file-scan", "production-editor-render",
  "order-design", "logistics", "shipment-writeback",
]);
export const orderWorkerSchedulers = Object.freeze(["productionRenderDispatcher", "orderDesignDispatcher"]);
export const orderWorkerProfile = "order-fulfillment-v1";

export function orderWorkerReady(value, pid) {
  const equal = (actual, expected) => Array.isArray(actual) && actual.length === expected.length
    && [...actual].sort().join() === [...expected].sort().join();
  return value?.state === "ready" && Number.isSafeInteger(pid) && value.pid === pid
    && equal(value.queues, orderWorkerQueues) && equal(value.schedulers, orderWorkerSchedulers);
}
