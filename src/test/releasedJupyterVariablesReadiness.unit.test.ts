import { describe, expect, it } from "vitest";
import {
  RELEASED_JUPYTER_VARIABLE_DIAGNOSTIC_FRAME_LIMIT,
  boundedReleasedJupyterVariableReadinessState,
  releasedJupyterVariableFrameKind,
  releasedJupyterVariableReadinessCheckpoint,
  releasedJupyterVariableViewIsReady,
  shouldRefocusReleasedJupyterVariableNotebook,
  type ReleasedJupyterVariableFrameProbe
} from "./extensionHost/releasedJupyterVariablesReadiness";

const readyJupyterFrame = (overrides: Partial<ReleasedJupyterVariableFrameProbe> = {}) => ({
  kind: "jupyter",
  readyState: "complete",
  bodyChildren: 1,
  mainPanels: 1,
  tables: 1,
  tableVisible: true,
  variableCells: 1,
  emptyState: "none",
  ...overrides
});

describe("released Jupyter Variables readiness", () => {
  it("classifies frames without retaining their URL", () => {
    expect(releasedJupyterVariableFrameKind("https://example.invalid/private?token=secret", true)).toBe("workbench");
    expect(
      releasedJupyterVariableFrameKind(
        "vscode-webview://host/index.html?id=private&extensionId=ms-toolsai.jupyter&token=secret",
        false
      )
    ).toBe("jupyter");
    expect(releasedJupyterVariableFrameKind("vscode-webview://host/fake.html?id=private", false)).toBe("webview");
    expect(releasedJupyterVariableFrameKind("https://example.invalid/private?token=secret", false)).toBe("other");
  });

  it("bounds structural diagnostics and drops unrecognized DOM state", () => {
    const frames = Array.from({ length: RELEASED_JUPYTER_VARIABLE_DIAGNOSTIC_FRAME_LIMIT + 3 }, (_, index) =>
      readyJupyterFrame({
        kind: index === 0 ? "untrusted-frame-kind" : "jupyter",
        readyState: index === 0 ? "secret-ready-state" : "complete",
        bodyChildren: index === 0 ? Number.MAX_SAFE_INTEGER : 1,
        mainPanels: index === 0 ? -1 : 1,
        emptyState: index === 0 ? "secret-empty-text" : "none"
      })
    );
    const state = boundedReleasedJupyterVariableReadinessState("exact", frames.length, frames);

    expect(state.frameCount).toBe(frames.length);
    expect(state.framesTruncated).toBe(true);
    expect(state.frames).toHaveLength(RELEASED_JUPYTER_VARIABLE_DIAGNOSTIC_FRAME_LIMIT);
    expect(state.frames[0]).toEqual({
      kind: "other",
      readyState: "unknown",
      bodyChildren: 999,
      mainPanels: 0,
      tables: 1,
      tableVisible: true,
      variableCells: 1,
      emptyState: "other"
    });
    expect(JSON.stringify(state)).not.toContain("secret");
  });

  it("refocuses only the Cursor remote phase when exact notebook identity drifted", () => {
    expect(shouldRefocusReleasedJupyterVariableNotebook("cursor", "jupyter-remote", "none")).toBe(true);
    expect(shouldRefocusReleasedJupyterVariableNotebook("cursor", "jupyter-remote", "other")).toBe(true);
    expect(shouldRefocusReleasedJupyterVariableNotebook("cursor", "jupyter-remote", "exact")).toBe(false);
    expect(shouldRefocusReleasedJupyterVariableNotebook("cursor", "jupyter-allow", "other")).toBe(false);
    expect(shouldRefocusReleasedJupyterVariableNotebook("vscode", "jupyter-remote", "other")).toBe(false);
  });

  it("does not wait for the Variables webview before reporting focus drift", () => {
    const state = boundedReleasedJupyterVariableReadinessState("other", 1, [
      readyJupyterFrame({ readyState: "loading", bodyChildren: 0, tables: 0, emptyState: "loading" })
    ]);

    expect(releasedJupyterVariableViewIsReady(state)).toBe(false);
    expect(shouldRefocusReleasedJupyterVariableNotebook("cursor", "jupyter-remote", state.activeNotebook)).toBe(true);
  });

  it("requires a complete Jupyter document with rendered content before focus inspection", () => {
    expect(
      releasedJupyterVariableViewIsReady(
        boundedReleasedJupyterVariableReadinessState("exact", 1, [readyJupyterFrame()])
      )
    ).toBe(true);
    expect(
      releasedJupyterVariableViewIsReady(
        boundedReleasedJupyterVariableReadinessState("exact", 1, [readyJupyterFrame({ readyState: "loading" })])
      )
    ).toBe(false);
    expect(
      releasedJupyterVariableViewIsReady(
        boundedReleasedJupyterVariableReadinessState("exact", 1, [readyJupyterFrame({ bodyChildren: 0 })])
      )
    ).toBe(false);
  });

  it("formats a short state-only progress checkpoint", () => {
    const state = boundedReleasedJupyterVariableReadinessState("other", 4, [
      readyJupyterFrame({ tables: 0, tableVisible: false, variableCells: 0, emptyState: "loading" })
    ]);
    const checkpoint = releasedJupyterVariableReadinessCheckpoint(state);

    expect(checkpoint).toBe("a=other;f=4;j=complete;b=1;p=1;t=0;v=0;c=0;e=loading");
    expect(Buffer.byteLength(checkpoint, "utf8")).toBeLessThan(128);
  });
});
