export const PACKAGED_DAILY_CORE_SELECTOR = "daily-core";
export const PACKAGED_GRID_RANGE_COPY_SELECTOR = "grid-range-copy";

const supportedSelectors = new Set([PACKAGED_DAILY_CORE_SELECTOR, PACKAGED_GRID_RANGE_COPY_SELECTOR]);

export function resolvePackagedPlatformSmokeSelector({ acceptanceMode, selector }) {
  if (selector === undefined) return undefined;
  if (!supportedSelectors.has(selector) || acceptanceMode !== "platform-smoke") {
    throw new Error(
      'OPEN_WRANGLER_TEST_SELECTOR may be "daily-core" or "grid-range-copy" only when OPEN_WRANGLER_PACKAGED_MODE is "platform-smoke".'
    );
  }
  return selector;
}

export async function runPackagedPlatformSmokePhase(runPhase, input, selector) {
  if (input.phase !== "platform-smoke") {
    throw new Error("A packaged platform-smoke selector may be forwarded only to the platform-smoke phase.");
  }
  const resolvedSelector = resolvePackagedPlatformSmokeSelector({ acceptanceMode: input.phase, selector });
  await runPhase(resolvedSelector === undefined ? input : { ...input, testSelector: resolvedSelector });
}
