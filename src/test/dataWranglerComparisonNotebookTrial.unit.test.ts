import { afterEach, describe, expect, it } from "vitest";
import {
  COMPARISON_TRIAL_REQUEST_PROTOCOL,
  COMPARISON_TRIAL_RESULT_PROTOCOL,
  isComparisonKernelLabel,
  observeIntegerProfileReady,
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
    source: "import pandas as pd\nstudy_frame = pd.read_csv(source)",
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

  it("requires a cold notebook to contain only its measured load-and-display cell", () => {
    const cold = {
      ...measured,
      source: "import pandas as pd\nstudy_frame = pd.read_csv(source)\nstudy_frame"
    };
    expect(
      validateComparisonNotebookLayout({
        kind: "cold",
        cellId: "pandas-csv",
        variableName: "study_frame",
        cells: [cold]
      })
    ).toEqual({ setupIndex: null, measuredIndex: 0 });
    expect(() =>
      validateComparisonNotebookLayout({
        kind: "cold",
        cellId: "pandas-csv",
        variableName: "study_frame",
        cells: [setup, cold]
      })
    ).toThrow(/exactly 1 code cell/u);
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

describe("public readiness oracles", () => {
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

  it("requires a completed integer profile rather than loading text", () => {
    const candidate = {
      isConnected: true,
      parentElement: null,
      textContent: "c00 Int64 Missing 0% Distinct 100% Min 0 Max 99999",
      getBoundingClientRect: () => ({ width: 180, height: 80 })
    };
    Object.defineProperty(globalThis, "document", {
      configurable: true,
      value: { querySelectorAll: () => [candidate] }
    });
    expect(observeIntegerProfileReady({ column: "c00", minimum: 0, maximum: 99_999 })).toBe(true);
    candidate.textContent = "c00 Int64 Profiling… Missing 0% Distinct 100% Min 0 Max 99999";
    expect(observeIntegerProfileReady({ column: "c00", minimum: 0, maximum: 99_999 })).toBe(false);
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
          requestAnimationFrame: (callback: () => void) => {
            callback();
            return 1;
          },
          getComputedStyle: () => ({ display: "block", visibility: "visible", opacity: "1" })
        },
        elementFromPoint: () => element,
        getElementById: () => null
      }
    };
    await expect(observePointerReady(element, "Run")).resolves.toBe(true);
    await expect(observePointerReady(element, "Different")).resolves.toBe(false);
  });
});
