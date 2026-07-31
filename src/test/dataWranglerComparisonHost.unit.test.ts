import { execFileSync } from "node:child_process";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import {
  buildComparisonWorkbenchReadinessEvidence,
  comparisonExplorerItemMatches,
  comparisonRuntimeProbeSource,
  comparisonWarmCacheArguments,
  isPostClickComparisonSurface,
  prepareComparisonAction,
  requireUniqueComparisonMatch,
  runBoundedComparisonFrameProbe,
  runComparisonFrameProbeWithRetry
} from "./extensionHost/dataWranglerComparison";

describe("clean-room comparison host contracts", () => {
  it("uses the source-cache helper's warm mode and retains its resident-proof semantics", () => {
    expect(comparisonWarmCacheArguments("/private/source_cache_control.py", "/private/fixture.parquet")).toEqual([
      "/private/source_cache_control.py",
      "--source",
      "/private/fixture.parquet",
      "--mode",
      "warm"
    ]);
  });

  it("builds valid statement boundaries for the isolated Python provenance probe", () => {
    const source = comparisonRuntimeProbeSource();
    const bootstrap = [
      "import sys, types",
      "for _name in ('ipykernel', 'jupyter_core', 'pandas', 'pyarrow'):",
      "    _module = types.ModuleType(_name)",
      "    _module.__version__ = '1.2.3'",
      "    sys.modules[_name] = _module"
    ].join("\n");
    const output = execFileSync(
      process.execPath,
      [resolve(process.cwd(), "scripts", "run-python.mjs"), "-c", `${bootstrap}\n${source}`],
      {
        cwd: process.cwd(),
        encoding: "utf8",
        timeout: 10_000,
        windowsHide: true
      }
    );
    const parsed = JSON.parse(output) as Record<string, unknown>;

    expect(Object.keys(parsed).sort()).toEqual([
      "installedIpykernelVersion",
      "installedJupyterCoreVersion",
      "installedPandasVersion",
      "installedPyarrowVersion",
      "pythonImplementation",
      "pythonVersion"
    ]);
    expect(parsed).toMatchObject({
      pythonImplementation: "CPython",
      installedPandasVersion: "1.2.3",
      installedPyarrowVersion: "1.2.3",
      installedJupyterCoreVersion: "1.2.3",
      installedIpykernelVersion: "1.2.3"
    });
  });

  it("requires a selected, unobstructed, pointer-usable target editor", () => {
    expect(
      buildComparisonWorkbenchReadinessEvidence({
        targetEditorSelected: true,
        visibleQuickInputs: 0,
        visibleDialogs: 0,
        visibleModals: 0,
        rendererFramePointerUsable: true
      })
    ).toEqual({
      targetEditorSelected: true,
      noVisibleQuickInput: true,
      noVisibleDialog: true,
      noVisibleModal: true,
      rendererFramePointerUsable: true
    });

    for (const input of [
      { targetEditorSelected: false },
      { visibleQuickInputs: 1 },
      { visibleDialogs: 1 },
      { visibleModals: 1 },
      { rendererFramePointerUsable: false }
    ]) {
      expect(() =>
        buildComparisonWorkbenchReadinessEvidence({
          targetEditorSelected: true,
          visibleQuickInputs: 0,
          visibleDialogs: 0,
          visibleModals: 0,
          rendererFramePointerUsable: true,
          ...input
        })
      ).toThrow(/selected|unobstructed|pointer-usable/u);
    }
    expect(() =>
      buildComparisonWorkbenchReadinessEvidence({
        targetEditorSelected: true,
        visibleQuickInputs: 65,
        visibleDialogs: 0,
        visibleModals: 0,
        rendererFramePointerUsable: true
      })
    ).toThrow(/between zero and 64/u);
  });

  it("matches one exact Files Explorer basename and rejects ambiguity or substrings", () => {
    expect(comparisonExplorerItemMatches("fixture.csv", "fixture.csv", "")).toBe(true);
    expect(comparisonExplorerItemMatches("fixture.csv", "", "fixture.csv")).toBe(true);
    expect(comparisonExplorerItemMatches("fixture.csv", "fixture.csv.backup", "")).toBe(false);
    expect(comparisonExplorerItemMatches("fixture.csv", "Open Editors fixture.csv", "")).toBe(false);
    expect(requireUniqueComparisonMatch(["exact"], "fixture.csv")).toBe("exact");
    expect(requireUniqueComparisonMatch([], "fixture.csv")).toBeUndefined();
    expect(() => requireUniqueComparisonMatch(["first", "second"], "fixture.csv")).toThrow(/more than one match/u);
  });

  it("accepts only a child frame or top-level Page created after the complete action-click baseline", () => {
    const existing = { id: "existing" };
    const created = { id: "created" };
    const baselineFrames = new Set([existing]);
    const existingPage = { id: "existing-page" };
    const createdPage = { id: "created-page" };
    const baselinePages = new Set([existingPage]);

    expect(isPostClickComparisonSurface(existing, baselineFrames, created, existingPage, baselinePages)).toBe(false);
    expect(isPostClickComparisonSurface(created, baselineFrames, existing, existingPage, baselinePages)).toBe(true);
    expect(isPostClickComparisonSurface(created, baselineFrames, null, createdPage, baselinePages)).toBe(true);
    expect(isPostClickComparisonSurface(created, baselineFrames, null, existingPage, baselinePages)).toBe(false);
  });

  it("prepares and proves resident cache only after source verification and the menu delay", async () => {
    const events: string[] = [];
    const existing = { id: "existing" };
    const lateStale = { id: "late-stale" };
    let frameCapture = 0;
    const prepared = await prepareComparisonAction({
      beforeAction: async () => {
        events.push("source-verified");
      },
      captureFrames: () => {
        frameCapture += 1;
        events.push("frames-snapshotted-final");
        return frameCapture === 1 ? [existing, lateStale] : [existing];
      },
      waitForActivationDelay: async () => {
        events.push("menu-delay-complete");
      },
      prepareCache: () => {
        events.push("cache-prepared");
        return { requestedState: "resident" as const };
      }
    });

    expect(events).toEqual(["source-verified", "menu-delay-complete", "cache-prepared", "frames-snapshotted-final"]);
    expect(frameCapture).toBe(1);
    expect(prepared.baselineFrames).toEqual(new Set([existing, lateStale]));
    expect(prepared.cacheProof).toEqual({ requestedState: "resident" });
  });

  it("bounds a stalled frame probe and handles a retired-frame rejection", async () => {
    await expect(runBoundedComparisonFrameProbe(() => Promise.reject(new Error("frame retired")), 25)).resolves.toEqual(
      { status: "rejected" }
    );
    await expect(runBoundedComparisonFrameProbe(() => new Promise(() => undefined), 5)).resolves.toEqual({
      status: "timed-out"
    });
    await expect(runBoundedComparisonFrameProbe(async () => "ready", 25)).resolves.toEqual({
      status: "completed",
      value: "ready"
    });
  });

  it("retries one briefly throttled frame after a bounded cooldown", async () => {
    let attempts = 0;
    const waits: string[] = [];
    const outcome = await runComparisonFrameProbeWithRetry(
      () => {
        attempts += 1;
        return attempts === 1 ? new Promise(() => undefined) : Promise.resolve("ready");
      },
      5,
      1,
      async () => {
        waits.push("cooldown");
      }
    );

    expect(attempts).toBe(2);
    expect(waits).toEqual(["cooldown"]);
    expect(outcome).toEqual({ status: "completed", value: "ready" });
  });
});
