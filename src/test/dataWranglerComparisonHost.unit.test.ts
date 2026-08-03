import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import {
  buildComparisonWorkbenchReadinessEvidence,
  comparisonDialogLabelIsNonBlockingNotification,
  comparisonExplorerItemMatches,
  comparisonRuntimeOptionNamePattern,
  comparisonRuntimeOptionMatches,
  comparisonRuntimeSelectorMatches,
  comparisonRuntimeProbeSource,
  comparisonTabsOpenedAfter,
  comparisonWarmCacheArguments,
  dataWranglerComparisonKernelLabel,
  isPostClickComparisonSurface,
  prepareComparisonAction,
  prepareComparisonHostPhase,
  prioritizeDataWranglerRuntimeSelectors,
  requireUniqueComparisonMatch,
  runBoundedComparisonFrameProbe,
  runComparisonFrameProbeWithRetry,
  runDataWranglerRuntimeSelectionTopology
} from "./extensionHost/dataWranglerComparison";

describe("clean-room comparison host contracts", () => {
  it("runs either setup-only product without requiring a diagnostic fixture manifest", async () => {
    const root = mkdtempSync(resolve(tmpdir(), "ow-comparison-setup-only-"));
    const runId = "12345678-1234-4234-9234-123456789abc";
    try {
      for (const [phase, productKey] of [
        ["comparison-open-wrangler-setup", "open-wrangler"],
        ["comparison-data-wrangler-setup", "data-wrangler"]
      ] as const) {
        const workspace = resolve(root, productKey);
        const warmup = resolve(workspace, "warmup.csv");
        mkdirSync(workspace, { mode: 0o700 });
        writeFileSync(warmup, "c00,c01\n0,1\n1,2\n", { mode: 0o600 });
        expect(existsSync(resolve(workspace, "performance-fixtures.json"))).toBe(false);

        const setups: unknown[] = [];
        const prepared = await prepareComparisonHostPhase(
          {
            phase,
            productKey,
            runId,
            workspace,
            workbench: { page: {} } as never
          },
          {
            async runFirstUseSetup(input) {
              setups.push(input);
              expect(readFileSync(input.source, "utf8")).toBe("c00,c01\n0,1\n1,2\n");
            }
          }
        );

        expect(prepared).toEqual({ kind: "setup-only" });
        expect(setups).toEqual([
          {
            productKey,
            workbench: { page: {} },
            source: warmup,
            ...(productKey === "data-wrangler" ? { kernelLabel: `Open Wrangler comparison runtime ${runId}` } : {})
          }
        ]);
      }
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("allows non-modal VS Code notification toasts without weakening real dialog checks", () => {
    expect(
      comparisonDialogLabelIsNonBlockingNotification(
        "Warning: Unable to watch for file changes., notification, Inspect the response in the accessible view",
        null
      )
    ).toBe(true);
    expect(comparisonDialogLabelIsNonBlockingNotification("Select a Python runtime", null)).toBe(false);
    expect(comparisonDialogLabelIsNonBlockingNotification("Dependency warning, notification", "true")).toBe(false);
  });

  it("identifies only the exact source and target tabs created by a comparison launch", () => {
    const anchorSource = { id: "anchor-source" };
    const anchorTarget = { id: "anchor-target" };
    const source = { id: "source" };
    const target = { id: "target" };
    expect(
      comparisonTabsOpenedAfter([anchorSource, anchorTarget], [anchorSource, anchorTarget, source, target])
    ).toEqual([source, target]);
    expect(() => comparisonTabsOpenedAfter([anchorSource, anchorTarget], [anchorSource, target])).toThrow(
      /pre-existing comparison tab disappeared/u
    );
    expect(() => comparisonTabsOpenedAfter([anchorSource, anchorSource], [anchorSource])).toThrow(/identity-unique/u);
  });

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

  it("matches only the documented public first-use runtime roles and the correlated private kernel label", () => {
    const runId = "12345678-1234-4234-9234-123456789abc";
    const label = dataWranglerComparisonKernelLabel(runId);
    expect(label).toBe(`Open Wrangler comparison runtime ${runId}`);
    expect(comparisonRuntimeSelectorMatches("Select Python kernel")).toBe(true);
    expect(comparisonRuntimeSelectorMatches("Choose a runtime")).toBe(true);
    expect(comparisonRuntimeSelectorMatches("Python environment")).toBe(true);
    expect(comparisonRuntimeSelectorMatches("Install dependencies")).toBe(false);
    expect(comparisonRuntimeSelectorMatches("Filter columns")).toBe(false);
    expect(comparisonRuntimeOptionNamePattern(label).test(`${label} Python 3.12`)).toBe(true);
    expect(comparisonRuntimeOptionMatches(label, `${label} Python 3.12`)).toBe(true);
    expect(comparisonRuntimeOptionMatches(label, "unrelated runtime")).toBe(false);
    expect(comparisonRuntimeOptionMatches("Open Wrangler comparison runtime invalid", label)).toBe(false);
    expect(() => dataWranglerComparisonKernelLabel("not-a-run-id")).toThrow(/correlated v4 run ID/u);
  });

  it("selects one exact configured runtime directly from an existing native Quick Input", async () => {
    const nativeOption = { id: "native-quick-input-option" };
    const events: string[] = [];
    const topology = await runDataWranglerRuntimeSelectionTopology({
      discoverOptions: async () => {
        events.push("discover-option");
        return [nativeOption];
      },
      discoverSelectors: async () => {
        throw new Error("a direct native option must not require a selector");
      },
      activate: async (candidate) => {
        events.push(`activate:${candidate.id}`);
      },
      waitForRetry: async () => {
        throw new Error("a direct native option must not retry");
      },
      isWithinDeadline: () => true
    });

    expect(topology).toBe("direct-option");
    expect(events).toEqual(["discover-option", "activate:native-quick-input-option"]);
  });

  it("activates one existing or webview selector before selecting its exact runtime option", async () => {
    const selector = { id: "webview-selector" };
    const option = { id: "webview-option" };
    const events: string[] = [];
    let optionPoll = 0;
    const topology = await runDataWranglerRuntimeSelectionTopology({
      discoverOptions: async () => {
        optionPoll += 1;
        events.push(`discover-option:${optionPoll}`);
        return optionPoll === 1 ? [] : [option];
      },
      discoverSelectors: async () => {
        events.push("discover-selector");
        return [selector];
      },
      activate: async (candidate) => {
        events.push(`activate:${candidate.id}`);
      },
      waitForRetry: async () => {
        events.push("retry");
      },
      isWithinDeadline: () => true
    });

    expect(topology).toBe("selector-option");
    expect(events).toEqual([
      "discover-option:1",
      "discover-selector",
      "activate:webview-selector",
      "retry",
      "discover-option:2",
      "activate:webview-option"
    ]);
  });

  it("follows Data Wrangler's public local-interpreter connection step before the exact runtime", async () => {
    const selector = { id: "editor-runtime-selector" };
    const connection = { id: "local-interpreter-connection" };
    const option = { id: "configured-runtime-option" };
    const events: string[] = [];
    let optionPoll = 0;
    const topology = await runDataWranglerRuntimeSelectionTopology({
      discoverOptions: async () => {
        optionPoll += 1;
        return optionPoll < 3 ? [] : [option];
      },
      discoverSelectors: async () => [selector],
      discoverLocalInterpreterConnections: async () => [connection],
      activate: async (candidate) => {
        events.push(candidate.id);
      },
      waitForRetry: async () => undefined,
      isWithinDeadline: () => true
    });

    expect(topology).toBe("selector-option");
    expect(events).toEqual(["editor-runtime-selector", "local-interpreter-connection", "configured-runtime-option"]);
  });

  it("prefers the unique post-click editor selector over the global workbench runtime control", () => {
    const workbench = { id: "global-workbench-runtime" };
    const editor = { id: "post-click-editor-runtime" };
    const retained = { id: "retained-surface-runtime" };
    expect(
      prioritizeDataWranglerRuntimeSelectors([workbench, editor, retained], (candidate) => {
        if (candidate === editor) return "post-click";
        if (candidate === workbench) return "workbench-main";
        return "other";
      })
    ).toEqual([editor]);
    expect(
      prioritizeDataWranglerRuntimeSelectors([workbench, retained], (candidate) =>
        candidate === workbench ? "workbench-main" : "other"
      )
    ).toEqual([]);
    expect(
      prioritizeDataWranglerRuntimeSelectors(
        [workbench, retained],
        (candidate) => (candidate === workbench ? "workbench-main" : "other"),
        { allowWorkbenchMainFallback: true }
      )
    ).toEqual([workbench]);
    expect(
      prioritizeDataWranglerRuntimeSelectors([editor, { id: "second-editor-runtime" }], () => "post-click")
    ).toHaveLength(2);
  });

  it("fails closed for ambiguous or absent runtime-selection topology", async () => {
    const activations: unknown[] = [];
    const callbacks = {
      activate: async (candidate: unknown) => {
        activations.push(candidate);
      },
      waitForRetry: async () => undefined
    };
    let optionDeadlineChecks = 0;
    await expect(
      runDataWranglerRuntimeSelectionTopology({
        ...callbacks,
        discoverOptions: async () => [{ id: "first" }, { id: "second" }],
        discoverSelectors: async () => [],
        isWithinDeadline: () => optionDeadlineChecks++ < 2
      })
    ).rejects.toThrow(/retained an ambiguous configured runtime control set/u);
    let selectorDeadlineChecks = 0;
    await expect(
      runDataWranglerRuntimeSelectionTopology({
        ...callbacks,
        discoverOptions: async () => [],
        discoverSelectors: async () => [{ id: "first" }, { id: "second" }],
        isWithinDeadline: () => selectorDeadlineChecks++ < 2
      })
    ).rejects.toThrow(/retained an ambiguous runtime selector control set/u);

    let deadlineChecks = 0;
    await expect(
      runDataWranglerRuntimeSelectionTopology({
        ...callbacks,
        discoverOptions: async () => [],
        discoverSelectors: async () => [],
        isWithinDeadline: () => deadlineChecks++ === 0
      })
    ).rejects.toThrow(/direct configured option|public runtime selector/u);
    expect(activations).toEqual([]);
  });

  it("rejects a malformed optional local-interpreter discovery callback before polling", async () => {
    await expect(
      runDataWranglerRuntimeSelectionTopology({
        discoverOptions: async () => [],
        discoverSelectors: async () => [],
        discoverLocalInterpreterConnections: "not-a-callback" as never,
        activate: async () => undefined,
        waitForRetry: async () => undefined,
        isWithinDeadline: () => true
      })
    ).rejects.toThrow(/bounded public-role discovery callbacks/u);
  });

  it("waits through transient runtime-control ambiguity without activating a candidate", async () => {
    const selector = { id: "editor-runtime-selector" };
    const option = { id: "configured-runtime-option" };
    const events: string[] = [];
    let selectorPolls = 0;
    const topology = await runDataWranglerRuntimeSelectionTopology({
      discoverOptions: async () => (events.includes(selector.id) ? [option] : []),
      discoverSelectors: async () => {
        selectorPolls += 1;
        return selectorPolls === 1 ? [{ id: "transient-first" }, { id: "transient-second" }] : [selector];
      },
      activate: async (candidate) => {
        events.push(candidate.id);
      },
      waitForRetry: async () => undefined,
      isWithinDeadline: () => true
    });

    expect(topology).toBe("selector-option");
    expect(selectorPolls).toBe(2);
    expect(events).toEqual(["editor-runtime-selector", "configured-runtime-option"]);
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
