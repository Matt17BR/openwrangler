import { afterEach, describe, expect, it } from "vitest";
import {
  COMPARISON_TRIAL_REQUEST_PROTOCOL,
  COMPARISON_TRIAL_RESULT_PROTOCOL,
  boundedFailureMessage,
  comparisonAriaCountsMatch,
  clickComparisonPointerTarget,
  comparisonSetupExecutionOutcome,
  integerProfileTextReady,
  isComparisonKernelLabel,
  observePointerReady,
  observeVisibleFullShape,
  validateComparisonNotebookLayout,
  validateComparisonTrialRequest,
  validateComparisonTrialResult,
  type ComparisonTrialRequest,
  type ComparisonTrialResult
} from "./extensionHost/dataWranglerComparisonNotebookTrial";

const SHA = "a".repeat(64);
const originalDocument = Object.getOwnPropertyDescriptor(globalThis, "document");

afterEach(() => {
  if (originalDocument) Object.defineProperty(globalThis, "document", originalDocument);
  else Reflect.deleteProperty(globalThis, "document");
});

function request(overrides: Partial<ComparisonTrialRequest> = {}): ComparisonTrialRequest {
  return {
    protocol: COMPARISON_TRIAL_REQUEST_PROTOCOL,
    trialId: "pandas-csv-warm-00",
    product: "open-wrangler",
    kind: "warm",
    order: 0,
    isolatedRoot: "/tmp/openwrangler-comparison",
    notebookPath: "/tmp/openwrangler-comparison/study.ipynb",
    cell: {
      id: "pandas-csv",
      engine: "pandas",
      format: "csv",
      rows: 100_000,
      columns: 50,
      source: "/tmp/openwrangler-comparison/fixtures/source.csv",
      variableName: "study_frame"
    },
    candidate: { path: "/tmp/openwrangler.vsix", version: "1.2.1", sha256: SHA },
    dataWranglerVersion: "1.24.2",
    editor: { path: "/opt/code/code", version: "1.105.0", sha256: SHA },
    python: { path: "/opt/python/bin/python", version: "3.12.11", sha256: SHA },
    timeoutsMs: { inlinePreview: 45_000, workbenchOpen: 60_000, completeProfile: 135_000 },
    ...overrides
  };
}

const action = { accessibleName: "Open in Open Wrangler", unique: true, pointer: true } as const;

function result(overrides: Partial<ComparisonTrialResult> = {}): ComparisonTrialResult {
  return {
    protocol: COMPARISON_TRIAL_RESULT_PROTOCOL,
    trialId: "pandas-csv-warm-00",
    product: "open-wrangler",
    engine: "pandas",
    format: "csv",
    kind: "warm",
    order: 0,
    status: "success",
    failure: null,
    metrics: {
      inlinePreviewMs: 1,
      workbenchOpenMs: 2,
      firstProfileMs: 3,
      completeProfileMs: 4
    },
    milestones: [
      { name: "run-cell-click", monotonicNs: "1" },
      { name: "inline-ready", monotonicNs: "2" },
      { name: "launch-click", monotonicNs: "3" },
      { name: "workbench-ready", monotonicNs: "4" },
      { name: "profile-click", monotonicNs: "5" },
      { name: "first-profile-ready", monotonicNs: "6" },
      { name: "profiles-complete", monotonicNs: "7" }
    ],
    publicUi: {
      runCell: action,
      inline: { ...action, tableReady: true },
      workbench: {
        rootRole: "grid",
        fullShape: "aria-counts",
        ariaRowCount: 100_000,
        ariaColumnCount: 50,
        verticalOverflow: 10_000,
        horizontalOverflow: 5_000,
        pointerUsable: true
      },
      profiling: { ...action, accessibleName: "Column profiles and filters", expectedColumns: 50, completedColumns: 50 }
    },
    ...overrides
  };
}

describe("neutral comparison request", () => {
  it("accepts the exact Pandas/CSV smoke contract", () => {
    expect(validateComparisonTrialRequest(request())).toEqual(request());
  });

  it("rejects mismatched cell identities and paths outside the isolated root", () => {
    expect(() => validateComparisonTrialRequest(request({ cell: { ...request().cell, id: "polars-csv" } }))).toThrow(
      /identity does not match/u
    );
    expect(() => validateComparisonTrialRequest(request({ notebookPath: "/tmp/outside.ipynb" }))).toThrow(
      /below the isolated trial root/u
    );
  });

  it("rejects unknown fields and unbounded timeouts", () => {
    expect(() => validateComparisonTrialRequest({ ...request(), legacy: true })).toThrow(/unknown fields/u);
    expect(() =>
      validateComparisonTrialRequest(request({ timeoutsMs: { ...request().timeoutsMs, completeProfile: 1 } }))
    ).toThrow(/completeProfile timeout/u);
  });
});

describe("prepared notebook layout", () => {
  const setup = {
    kind: "code" as const,
    tags: ["ow-comparison-setup:pandas-csv"],
    source:
      'import pandas as pd\naaa_comparison_bootstrap = pd.DataFrame({"c00": [0], "c01": [1]})\n' +
      "study_frame = pd.read_csv(source)",
    outputCount: 0
  };
  const measured = {
    kind: "code" as const,
    tags: ["ow-comparison-cell:pandas-csv"],
    source: "study_frame",
    outputCount: 0
  };

  it("requires one fresh tagged warm setup immediately before the measured cell", () => {
    expect(
      validateComparisonNotebookLayout({
        kind: "warm",
        cellId: "pandas-csv",
        variableName: "study_frame",
        cells: [setup, measured]
      })
    ).toEqual({ setupIndex: 0, measuredIndex: 1 });
    expect(() =>
      validateComparisonNotebookLayout({
        kind: "warm",
        cellId: "pandas-csv",
        variableName: "study_frame",
        cells: [{ ...setup, tags: [] }, measured]
      })
    ).toThrow(/exactly one ow-comparison-setup/u);
  });

  it("keeps the cold source out of its untimed bootstrap cell", () => {
    const coldSetup = {
      ...setup,
      source: 'import pandas as pd\naaa_comparison_bootstrap = pd.DataFrame({"c00": [0], "c01": [1]})'
    };
    const cold = {
      ...measured,
      source: "import pandas as pd\nstudy_frame = pd.read_csv(source)\nstudy_frame"
    };
    expect(
      validateComparisonNotebookLayout({
        kind: "cold",
        cellId: "pandas-csv",
        variableName: "study_frame",
        cells: [coldSetup, cold]
      })
    ).toEqual({ setupIndex: 0, measuredIndex: 1 });
    expect(() =>
      validateComparisonNotebookLayout({
        kind: "cold",
        cellId: "pandas-csv",
        variableName: "study_frame",
        cells: [setup, cold]
      })
    ).toThrow(/assign the measured variable only for a warm trial/u);
  });

  it("rejects stale output and an extra comparison-tagged cell", () => {
    expect(() =>
      validateComparisonNotebookLayout({
        kind: "warm",
        cellId: "pandas-csv",
        variableName: "study_frame",
        cells: [setup, { ...measured, outputCount: 1 }]
      })
    ).toThrow(/fresh code cells/u);
    expect(() =>
      validateComparisonNotebookLayout({
        kind: "warm",
        cellId: "pandas-csv",
        variableName: "study_frame",
        cells: [{ ...setup, tags: [...setup.tags, "ow-comparison-legacy:pandas-csv"] }, measured]
      })
    ).toThrow(/exact comparison tags/u);
  });
});

describe("untimed setup completion", () => {
  it("accepts VS Code's completed timing when success is omitted", () => {
    expect(comparisonSetupExecutionOutcome({ timing: { startTime: 1, endTime: 2 } }, true)).toBe("success");
  });

  it("fails an explicit unsuccessful execution and ignores stale summaries", () => {
    expect(comparisonSetupExecutionOutcome({ success: false, timing: { startTime: 1, endTime: 2 } }, true)).toBe(
      "failure"
    );
    expect(comparisonSetupExecutionOutcome({ success: true, timing: { startTime: 1, endTime: 2 } }, false)).toBe(
      "pending"
    );
    expect(comparisonSetupExecutionOutcome({ success: undefined, timing: undefined }, true)).toBe("pending");
  });
});

describe("private comparison kernel label", () => {
  it("accepts the display name with or without VS Code's interpreter suffix", () => {
    expect(isComparisonKernelLabel("Python 3.12 (Comparison)")).toBe(true);
    expect(isComparisonKernelLabel("Python 3.12 (Comparison) (Python 3.12.13)")).toBe(true);
    expect(isComparisonKernelLabel("Python 3.13 (Comparison) (Python 3.13.0)")).toBe(false);
    expect(isComparisonKernelLabel("Python 3.12 (Comparison) copy")).toBe(false);
  });
});

describe("neutral comparison result", () => {
  it("accepts a complete, strictly ordered public-UI result", () => {
    expect(validateComparisonTrialResult(result())).toEqual(result());
  });

  it("accepts one ordered failure prefix without inventing later timings", () => {
    const failed = result({
      status: "timeout",
      failure: { stage: "inline-preview", kind: "timeout", message: "Inline preview timed out." },
      metrics: { inlinePreviewMs: null, workbenchOpenMs: null, firstProfileMs: null, completeProfileMs: null },
      milestones: [{ name: "run-cell-click", monotonicNs: "1" }],
      publicUi: { runCell: action, inline: null, workbench: null, profiling: null }
    });
    expect(validateComparisonTrialResult(failed)).toEqual(failed);
  });

  it("rejects reordered clocks and incomplete success evidence", () => {
    expect(() =>
      validateComparisonTrialResult(
        result({
          milestones: [
            { name: "run-cell-click", monotonicNs: "2" },
            { name: "inline-ready", monotonicNs: "1" }
          ]
        })
      )
    ).toThrow(/increase strictly/u);
    expect(() =>
      validateComparisonTrialResult(result({ publicUi: { ...result().publicUi, workbench: null } }))
    ).toThrow(/all metrics and public UI evidence/u);
  });
});

describe("comparison failure redaction", () => {
  it("removes the complete percent-encoded path instead of exposing its trailing text", () => {
    const message = boundedFailureMessage(
      new Error("Could not open file:%2Fhome%2Falice%2Fsecret.csv from $PRIVATE_SOURCE"),
      request()
    );

    expect(message).toBe("Could not open file encoded-path from environment");
    expect(message).not.toMatch(/alice|secret|%2F/iu);
  });
});

describe("public readiness oracles", () => {
  it("matches exact profile extrema and the UI's rounded suffix notation", () => {
    expect(
      integerProfileTextReady({
        column: "c00",
        minimum: 1_000,
        maximum: 1_999,
        text: "c00 Missing 0 Distinct 10 Min 1k Max 2k"
      })
    ).toBe(true);
    expect(
      integerProfileTextReady({
        column: "c00",
        minimum: 1_000,
        maximum: 1_999,
        text: "c00 Float64 Missing 0 Distinct 10 Min 2k Max 2k"
      })
    ).toBe(false);
  });

  it("recognizes a full-shape label without reading row values", () => {
    Object.defineProperty(globalThis, "document", {
      configurable: true,
      value: {
        querySelectorAll: () => [
          {
            isConnected: true,
            textContent: "Rows: 100,000 · Columns: 50",
            getAttribute: () => null,
            getBoundingClientRect: () => ({ width: 200, height: 20 })
          }
        ]
      }
    });
    expect(observeVisibleFullShape({ rows: 100_000, columns: 50 })).toBe(true);
  });

  it("accepts ARIA counts with grid headers without treating a renderer window as the full shape", () => {
    expect(comparisonAriaCountsMatch({ rows: 100_000, columns: 50, ariaRowCount: 100_001, ariaColumnCount: 51 })).toBe(
      true
    );
    expect(comparisonAriaCountsMatch({ rows: 100_000, columns: 50, ariaRowCount: 1006, ariaColumnCount: 51 })).toBe(
      false
    );
  });

  it("requires a stable unobstructed exact pointer target", async () => {
    const element = {
      isConnected: true,
      disabled: false,
      parentElement: null,
      textContent: "Run",
      getAttribute: () => null,
      contains: (value: unknown) => value === element,
      getBoundingClientRect: () => ({ left: 1, top: 2, width: 20, height: 10 }),
      ownerDocument: {
        defaultView: {
          clearTimeout,
          requestAnimationFrame: (callback: () => void) => {
            callback();
            return 1;
          },
          setTimeout,
          getComputedStyle: () => ({ display: "block", visibility: "visible", opacity: "1" })
        },
        elementFromPoint: () => element,
        getElementById: () => null
      }
    };
    await expect(observePointerReady(element, "Run")).resolves.toBe(true);
    await expect(observePointerReady(element, "Different")).resolves.toBe(false);
  });

  it("performs one real click after pointer readiness without an intermediate geometry read", async () => {
    let beforeClicks = 0;
    let clicks = 0;
    const evidence = await clickComparisonPointerTarget(
      {
        accessibleName: "Run",
        pointerReady: async () => true,
        click: async () => {
          clicks += 1;
        }
      },
      () => {
        beforeClicks += 1;
      }
    );

    expect(evidence).toEqual({ accessibleName: "Run", unique: true, pointer: true });
    expect(beforeClicks).toBe(1);
    expect(clicks).toBe(1);
  });
});
