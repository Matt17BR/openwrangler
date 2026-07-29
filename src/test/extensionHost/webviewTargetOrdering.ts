export interface RendererTargetOrderCandidate {
  pageIndex: number;
  frameIndex: number;
  isWebview: boolean;
  isOpenWranglerWebview: boolean;
}

/**
 * Prioritize the newest Open Wrangler renderer targets before applying the
 * probe bound. Editors may retain detached or hidden webview targets after a
 * panel closes, so truncating discovery order can otherwise starve the current
 * panel behind older targets.
 */
export function prioritizeNewestRendererTargets<T extends RendererTargetOrderCandidate>(
  candidates: readonly T[],
  limit: number
): T[] {
  if (!Number.isSafeInteger(limit) || limit < 0) {
    throw new RangeError("The renderer target limit must be a non-negative safe integer.");
  }

  return candidates
    .map((candidate, discoveryIndex) => ({ candidate, discoveryIndex }))
    .sort((left, right) => {
      const classification = rendererTargetPriority(left.candidate) - rendererTargetPriority(right.candidate);
      if (classification !== 0) return classification;

      const pageRecency = right.candidate.pageIndex - left.candidate.pageIndex;
      if (pageRecency !== 0) return pageRecency;

      const frameRecency = right.candidate.frameIndex - left.candidate.frameIndex;
      if (frameRecency !== 0) return frameRecency;

      return right.discoveryIndex - left.discoveryIndex;
    })
    .slice(0, limit)
    .map(({ candidate }) => candidate);
}

function rendererTargetPriority(candidate: { isWebview: boolean; isOpenWranglerWebview: boolean }): number {
  if (candidate.isOpenWranglerWebview) return 0;
  if (candidate.isWebview) return 1;
  return 2;
}
