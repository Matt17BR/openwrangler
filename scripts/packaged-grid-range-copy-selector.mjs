export const PACKAGED_GRID_RANGE_COPY_SELECTOR = "grid-range-copy";

export function resolvePackagedGridRangeCopySelector({ acceptanceMode, selector }) {
  if (selector === undefined) return undefined;
  if (selector !== PACKAGED_GRID_RANGE_COPY_SELECTOR || acceptanceMode !== "platform-smoke") {
    throw new Error(
      'OPEN_WRANGLER_TEST_SELECTOR may be "grid-range-copy" only when OPEN_WRANGLER_PACKAGED_MODE is "platform-smoke".'
    );
  }
  return PACKAGED_GRID_RANGE_COPY_SELECTOR;
}

export async function runPackagedPlatformSmokePhase(runPhase, input, selector) {
  if (input.phase !== "platform-smoke") {
    throw new Error("The packaged grid range-copy selector may be forwarded only to the platform-smoke phase.");
  }
  const resolvedSelector = resolvePackagedGridRangeCopySelector({
    acceptanceMode: input.phase,
    selector
  });
  await runPhase(resolvedSelector === undefined ? input : { ...input, testSelector: resolvedSelector });
}
