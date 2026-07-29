import { describe, expect, it } from "vitest";
import { prioritizeNewestRendererTargets } from "./extensionHost/webviewTargetOrdering";

describe("extension-host webview target ordering", () => {
  it("keeps the newest Open Wrangler frame ahead of more than 64 retained targets", () => {
    const retained = Array.from({ length: 72 }, (_, index) => ({
      id: `retained-${index}`,
      pageIndex: 0,
      frameIndex: index + 1,
      isWebview: true,
      isOpenWranglerWebview: true
    }));
    const current = {
      id: "current",
      pageIndex: 0,
      frameIndex: retained.length + 1,
      isWebview: true,
      isOpenWranglerWebview: true
    };

    const selected = prioritizeNewestRendererTargets([...retained, current], 64);

    expect(selected).toHaveLength(64);
    expect(selected[0]).toBe(current);
    expect(selected).toContain(current);
    expect(selected).not.toContain(retained[0]);
  });
});
