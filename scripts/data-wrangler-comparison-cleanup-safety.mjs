export const DATA_WRANGLER_COMPARISON_CLEANUP_UNSETTLED = "openwrangler-comparison-cleanup-unsettled";

export function createDataWranglerComparisonCleanupUnsettledError(errors, message) {
  const failures = Array.isArray(errors) ? errors : [errors];
  if (failures.length === 0) throw new TypeError("An unsettled cleanup error requires at least one cause.");
  const error = new AggregateError(failures, message);
  Object.defineProperty(error, "code", {
    configurable: false,
    enumerable: true,
    value: DATA_WRANGLER_COMPARISON_CLEANUP_UNSETTLED,
    writable: false
  });
  return error;
}

export function dataWranglerComparisonCleanupMayBeUnsettled(error, seen = new Set()) {
  if ((typeof error !== "object" && typeof error !== "function") || error === null || seen.has(error)) return false;
  seen.add(error);
  if (error.code === DATA_WRANGLER_COMPARISON_CLEANUP_UNSETTLED) return true;
  if (Array.isArray(error.errors)) {
    for (const nested of error.errors) {
      if (dataWranglerComparisonCleanupMayBeUnsettled(nested, seen)) return true;
    }
  }
  return dataWranglerComparisonCleanupMayBeUnsettled(error.cause, seen);
}
