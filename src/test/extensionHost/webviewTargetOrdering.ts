export interface RendererTargetOrderCandidate {
  pageIndex: number;
  frameIndex: number;
  isWebview: boolean;
  isOpenWranglerWebview: boolean;
}

/**
 * Prioritize attached webviews by recency before applying the probe bound.
 * Editors may retain old extension-labelled frames after replacing a webview,
 * while the replacement initially has only a generic vscode-webview URL.
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
      const webview = Number(!left.candidate.isWebview) - Number(!right.candidate.isWebview);
      if (webview !== 0) return webview;

      const pageRecency = right.candidate.pageIndex - left.candidate.pageIndex;
      if (pageRecency !== 0) return pageRecency;

      const frameRecency = right.candidate.frameIndex - left.candidate.frameIndex;
      if (frameRecency !== 0) return frameRecency;

      const classification =
        Number(!left.candidate.isOpenWranglerWebview) - Number(!right.candidate.isOpenWranglerWebview);
      if (classification !== 0) return classification;

      return right.discoveryIndex - left.discoveryIndex;
    })
    .slice(0, limit)
    .map(({ candidate }) => candidate);
}

export function classifyRendererUrl(url: string): {
  protocol: string;
  isWebview: boolean;
  isOpenWranglerWebview: boolean;
} {
  let protocol = "other";
  try {
    const candidate = new URL(url).protocol.toLowerCase();
    if (
      candidate === "about:" ||
      candidate === "file:" ||
      candidate === "http:" ||
      candidate === "https:" ||
      candidate === "vscode-file:" ||
      candidate === "vscode-webview:"
    ) {
      protocol = candidate;
    }
  } catch {
    // Diagnostics retain only an allowlisted protocol classification.
  }
  const normalized = url.toLowerCase();
  const isWebview = protocol === "vscode-webview:" || normalized.includes("vscode-webview");
  return {
    protocol,
    isWebview,
    isOpenWranglerWebview:
      isWebview &&
      (normalized.includes("matt17br.openwrangler") ||
        normalized.includes("openwrangler") ||
        normalized.includes("open-wrangler"))
  };
}
