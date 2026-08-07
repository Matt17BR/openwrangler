import { describe, expect, it } from "vitest";
import { classifyRendererUrl, prioritizeNewestRendererTargets } from "./extensionHost/webviewTargetOrdering";

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

  it("checks a newly attached generic webview before retained labelled frames and the workbench", () => {
    const retained = {
      id: "retained",
      pageIndex: 0,
      frameIndex: 1,
      isWebview: true,
      isOpenWranglerWebview: true
    };
    const workbench = {
      id: "workbench",
      pageIndex: 0,
      frameIndex: 0,
      isWebview: false,
      isOpenWranglerWebview: false
    };
    const current = {
      id: "current",
      pageIndex: 0,
      frameIndex: 2,
      isWebview: true,
      isOpenWranglerWebview: false
    };

    expect(prioritizeNewestRendererTargets([retained, workbench, current], 3)).toEqual([current, retained, workbench]);
  });

  it("does not identify a non-webview path containing the repository name as an Open Wrangler renderer", () => {
    expect(classifyRendererUrl("vscode-file://vscode-app/workbench/openwrangler/index.html")).toEqual({
      protocol: "vscode-file:",
      isWebview: false,
      isOpenWranglerWebview: false
    });
    expect(classifyRendererUrl("vscode-webview://panel/matt17br.openwrangler/index.html")).toEqual({
      protocol: "vscode-webview:",
      isWebview: true,
      isOpenWranglerWebview: true
    });
  });
});
