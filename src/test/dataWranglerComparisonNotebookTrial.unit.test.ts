import { afterEach, describe, expect, it, vi } from "vitest";
import {
  DATA_WRANGLER_NOTEBOOK_TRIAL_PHASE_PROTOCOL,
  DATA_WRANGLER_STUDY_INLINE_ACTION_WINDOW_MS,
  executeDataWranglerNotebookTrialFlow,
  observeNotebookTrialGridScrollState,
  observeNotebookTrialEngineLabel,
  observeNotebookTrialInlineAction,
  observeNotebookTrialIntegerProfile,
  observeNotebookTrialPointerAction,
  observeNotebookTrialVisibleShape,
  validateDataWranglerNotebookTrialPhaseReceipt,
  type DataWranglerNotebookTrialPhaseReceipt,
  type NotebookTrialActionEvidence,
  type NotebookTrialDefinition,
  type NotebookTrialFlowDependencies,
  type NotebookTrialVerificationEvidence
} from "./extensionHost/dataWranglerComparisonNotebookTrial";

type Mutable<T> = T extends readonly (infer Item)[]
  ? Mutable<Item>[]
  : T extends object
    ? { -readonly [Key in keyof T]: Mutable<T[Key]> }
    : T extends string
      ? string
      : T extends number
        ? number
        : T extends boolean
          ? boolean
          : T;

const STUDY: NotebookTrialDefinition = {
  engine: "pandas",
  format: "csv",
  kind: "warm",
  fixture: {
    id: "csv-100k-50",
    sha256: "a".repeat(64),
    rows: 100_000,
    columns: 50
  },
  kernel: {
    name: "openwrangler-study-cpython-312-trial",
    displayName: "Open Wrangler study CPython 3.12 (private trial)"
  }
};

const OPEN_ACTION: NotebookTrialActionEvidence = {
  role: "button",
  accessibleName: "Open in Open Wrangler",
  exactNameMatched: true,
  visible: true,
  enabled: true,
  pointerUsable: true,
  stableFrames: 2
};

const RUN_CELL_ACTION: NotebookTrialActionEvidence = {
  role: "button",
  accessibleName: "Execute Cell",
  exactNameMatched: true,
  visible: true,
  enabled: true,
  pointerUsable: true,
  stableFrames: 2
};

const PROFILE_ACTION: NotebookTrialActionEvidence = {
  role: "button",
  accessibleName: "Column profiles and filters",
  exactNameMatched: true,
  visible: true,
  enabled: true,
  pointerUsable: true,
  stableFrames: 2
};

function verification(
  phase: NotebookTrialVerificationEvidence["phase"],
  kind: NotebookTrialDefinition["kind"] = "warm"
): NotebookTrialVerificationEvidence {
  return {
    phase,
    pythonImplementation: "CPython",
    pythonVersion: "3.12.11",
    classMatched: true,
    shapeMatched: true,
    columnsMatched: true,
    integerDtypeMatched: true,
    sentinelsMatched: true,
    objectTokenContinuous: kind === "warm" ? true : null,
    rowDataIncluded: false
  };
}

function successDependencies(events: string[]): NotebookTrialFlowDependencies & {
  readonly currentClock: () => number;
  readonly setClock: (value: number) => void;
} {
  let clock = 0;
  return {
    product: "open-wrangler",
    study: STUDY,
    now: () => clock,
    timeOriginUnixMs: 1_750_000_000_000,
    currentClock: () => clock,
    setClock: (value) => {
      clock = value;
    },
    assertExactNotebook(checkpoint) {
      events.push(`exact:${checkpoint}`);
    },
    async selectKernel() {
      events.push("kernel");
    },
    async executeSetup() {
      events.push("setup");
      clock = 5;
    },
    async executeVerification(phase) {
      events.push(`verify:${phase}`);
      return verification(phase);
    },
    async countExactInlineActions() {
      events.push("baseline-action-count");
      clock = 10;
      return 0;
    },
    async prepareMeasuredAction() {
      events.push("prepare-run-cell");
      return RUN_CELL_ACTION;
    },
    async executeMeasured(immediatelyBeforePointerClick, immediatelyAfterCellCompletion) {
      events.push("run-cell-center-owned");
      clock = 12;
      events.push("run-cell-boundary-callback");
      immediatelyBeforePointerClick();
      events.push("run-cell-pointer-click");
      events.push("measured-start");
      clock = 18;
      events.push("measured-completion-boundary");
      immediatelyAfterCellCompletion();
      events.push("measured-complete");
    },
    async waitForInlineAction(immediatelyAfterReady) {
      events.push("inline-wait-start");
      clock = 20;
      events.push("inline-ready-boundary");
      immediatelyAfterReady();
      events.push("inline-ready");
      return {
        evidence: OPEN_ACTION,
        surfaceKind: "open-wrangler-renderer",
        sentinelsVisibleWithAction: true
      };
    },
    async clickInlineAction(immediatelyBeforePointerClick) {
      events.push("open-center-owned");
      clock = 30;
      events.push("open-boundary-callback");
      immediatelyBeforePointerClick();
      events.push("open-pointer-click");
      return OPEN_ACTION;
    },
    async waitForWorkbenchAndScroll(immediatelyAfterReady) {
      events.push("workbench-grid-ready");
      clock = 40;
      events.push("workbench-ready-boundary");
      immediatelyAfterReady();
      events.push("workbench-scroll-correctness");
      return {
        newlySelectedProductEditor: true,
        grid: {
          rootRole: "grid",
          busy: "false",
          visible: true,
          pointerUsable: true,
          geometryStableFrames: 2,
          headers: ["c00", "c01"],
          sentinelsMatched: true,
          ariaRowCount: 100_000,
          ariaColumnCount: 50
        },
        workbench: {
          targetEditorSelected: true,
          noVisibleQuickInput: true,
          noVisibleDialog: true,
          noVisibleModal: true,
          rendererFramePointerUsable: true
        },
        fullShape: "aria-counts",
        engineLabel: "pandas",
        scroll: {
          input: "pointer-wheel",
          verticalWindowChanged: true,
          horizontalWindowChanged: true,
          beforeC00: 0,
          afterC00: 80,
          stableFrames: 2,
          pointerUsableAfterScroll: true
        }
      };
    },
    async restoreFirstRows() {
      events.push("restore-first-rows");
      return 0;
    },
    async activateProfiles(immediatelyBeforePointerClick) {
      events.push("profile-center-owned");
      clock = 50;
      events.push("profile-boundary-callback");
      immediatelyBeforePointerClick();
      events.push("profile-pointer-click");
      return PROFILE_ACTION;
    },
    async profileColumn(index, immediatelyAfterReady) {
      events.push(`profile:c${String(index).padStart(2, "0")}`);
      clock = 60 + index;
      events.push(`profile-ready-boundary:c${String(index).padStart(2, "0")}`);
      immediatelyAfterReady();
      return {
        column: `c${String(index).padStart(2, "0")}`,
        type: "signed-64-bit",
        missingCount: 0,
        minimumMatched: true,
        maximumMatched: true,
        distinct: { semantics: "exact", count: 100_000, percent: null },
        rowValuesIncluded: false
      };
    },
    async closeProductEditorAndRestoreNotebook() {
      events.push("close-product-restore-notebook");
    }
  };
}

afterEach(() => {
  vi.restoreAllMocks();
  document.body.replaceChildren();
});

describe("one-trial notebook comparison flow", () => {
  it("orders exact notebook work, pointer boundaries, real workbench proof, canonical profiles, and the after-check", async () => {
    const events: string[] = [];
    const receipt = await executeDataWranglerNotebookTrialFlow(successDependencies(events));

    expect(receipt.protocol).toBe(DATA_WRANGLER_NOTEBOOK_TRIAL_PHASE_PROTOCOL);
    expect(receipt.status).toBe("success");
    expect(receipt.inline!.evidenceWindowMs).toBe(DATA_WRANGLER_STUDY_INLINE_ACTION_WINDOW_MS);
    expect(receipt.inline).toMatchObject({
      baselineExactActionCount: 0,
      genericHostHtmlAcceptedAsProductPreview: false,
      runCellAction: RUN_CELL_ACTION,
      surfaceKind: "open-wrangler-renderer",
      sentinelsVisibleWithAction: true
    });
    expect(receipt.workbench).toMatchObject({
      newlySelectedProductEditor: true,
      fullShape: "aria-counts",
      engineLabel: "pandas",
      scroll: {
        input: "pointer-wheel",
        verticalWindowChanged: true,
        horizontalWindowChanged: true,
        beforeC00: 0,
        afterC00: 80,
        restoredC00: 0,
        firstRowsRestoredAfterTiming: true
      }
    });
    expect(receipt.sourceLoad).toEqual({
      status: "measured",
      durationMs: 5,
      includedInInlineTiming: false,
      measurementBoundary: "setup-cell-start-to-completion"
    });
    expect(receipt.clock.timeOriginUnixMs).toBe(1_750_000_000_010);
    expect(receipt.clock).toMatchObject({
      kind: "driver-local-performance-time-origin",
      authoritativeForStudy: false
    });
    expect(receipt.finalization).toEqual({
      closeAttempted: true,
      closeStatus: "succeeded",
      afterVerification: "matched"
    });
    expect(receipt.profiles?.columns).toHaveLength(50);
    expect(receipt.profiles?.columns.map(({ column }) => column)).toEqual(
      Array.from({ length: 50 }, (_, index) => `c${String(index).padStart(2, "0")}`)
    );
    expect(events.slice(events.indexOf("run-cell-center-owned"), events.indexOf("run-cell-pointer-click") + 1)).toEqual(
      ["run-cell-center-owned", "run-cell-boundary-callback", "run-cell-pointer-click"]
    );
    expect(events.indexOf("run-cell-pointer-click")).toBeLessThan(events.indexOf("inline-wait-start"));
    expect(events.slice(events.indexOf("open-center-owned"), events.indexOf("open-pointer-click") + 1)).toEqual([
      "open-center-owned",
      "open-boundary-callback",
      "open-pointer-click"
    ]);
    expect(events.slice(events.indexOf("profile-center-owned"), events.indexOf("profile-pointer-click") + 1)).toEqual([
      "profile-center-owned",
      "profile-boundary-callback",
      "profile-pointer-click"
    ]);
    expect(events.indexOf("workbench-ready-boundary")).toBeLessThan(events.indexOf("workbench-scroll-correctness"));
    expect(events.indexOf("restore-first-rows")).toBeLessThan(events.indexOf("profile-center-owned"));
    expect(events.at(-2)).toBe("verify:after-workbench");
    expect(events.at(-1)).toBe("exact:after after-workbench verification");
    expect(() => validateDataWranglerNotebookTrialPhaseReceipt(receipt)).not.toThrow();
  });

  it("rejects a manifest-declared unavailable trial before kernel selection", async () => {
    const events: string[] = [];
    const base = successDependencies(events);
    const dependencies: NotebookTrialFlowDependencies = {
      ...base,
      product: "data-wrangler",
      study: { ...STUDY, engine: "polars" },
      publicSurfaceAvailability: "unavailable",
      async executeVerification(phase) {
        events.push(`verify:${phase}`);
        return verification(phase);
      },
      async prepareMeasuredAction() {
        throw new Error("unsupported must not prepare a measured action");
      },
      async clickInlineAction() {
        throw new Error("unsupported must not click");
      },
      async waitForWorkbenchAndScroll() {
        throw new Error("unsupported must not open a workbench");
      },
      async activateProfiles() {
        throw new Error("unsupported must not profile");
      }
    };

    await expect(executeDataWranglerNotebookTrialFlow(dependencies)).rejects.toThrow(/skipped before/u);
    expect(events).toEqual([]);
    expect(events).not.toContain("close-product-restore-notebook");
    expect(events).not.toContain("verify:after-workbench");
    expect(events.some((event) => event.startsWith("profile:"))).toBe(false);
  });

  it("stops inline readiness only after both the stable surface and fresh cell completion", async () => {
    const base = successDependencies([]);
    let completeMeasured!: () => void;
    const receipt = await executeDataWranglerNotebookTrialFlow({
      ...base,
      executeMeasured(immediatelyBeforePointerClick, immediatelyAfterCellCompletion) {
        base.setClock(12);
        immediatelyBeforePointerClick();
        return new Promise<void>((resolve) => {
          completeMeasured = () => {
            base.setClock(22);
            immediatelyAfterCellCompletion();
            resolve();
          };
        });
      },
      async waitForInlineAction(immediatelyAfterReady) {
        base.setClock(15);
        immediatelyAfterReady();
        completeMeasured();
        return {
          evidence: OPEN_ACTION,
          surfaceKind: "open-wrangler-renderer",
          sentinelsVisibleWithAction: true
        };
      }
    });

    expect(receipt.milestones.inlineActionMs).toBe(2);
    expect(receipt.milestones.inlineReadyMs).toBe(12);
  });

  it("measures a cold source load inside the inline timing boundary", async () => {
    const base = successDependencies([]);
    const receipt = await executeDataWranglerNotebookTrialFlow({
      ...base,
      study: { ...STUDY, kind: "cold" },
      async executeVerification(phase) {
        return verification(phase, "cold");
      }
    });

    expect(receipt.status).toBe("success");
    expect(receipt.sourceLoad).toEqual({
      status: "measured",
      durationMs: 6,
      includedInInlineTiming: true,
      measurementBoundary: "run-cell-pointer-to-cell-completion"
    });
    expect(receipt.sourceLoad.durationMs).toBeLessThanOrEqual(
      receipt.milestones.inlineReadyMs! - receipt.milestones.inlineActionMs!
    );
  });

  it("returns a bounded partial receipt when an available inline action times out", async () => {
    const dependencies = successDependencies([]);
    const receipt = await executeDataWranglerNotebookTrialFlow({
      ...dependencies,
      waitForInlineAction: async () => {
        throw new Error("The measured output did not expose one action within 45000 ms.");
      }
    });

    expect(receipt).toMatchObject({
      status: "failed",
      failure: { stage: "inline", kind: "timeout" },
      sourceLoad: {
        status: "measured",
        durationMs: 5,
        includedInInlineTiming: false,
        measurementBoundary: "setup-cell-start-to-completion"
      },
      milestones: { inlineActionMs: 2, inlineReadyMs: null },
      workbench: null,
      profiles: null,
      finalization: { closeAttempted: true, closeStatus: "succeeded", afterVerification: "matched" }
    });
    expect(receipt.inline).toMatchObject({ runCellAction: RUN_CELL_ACTION, action: null });
    expect(() => validateDataWranglerNotebookTrialPhaseReceipt(receipt)).not.toThrow();
  });

  it("keeps the original timeout when failure cleanup also fails", async () => {
    const base = successDependencies([]);
    const receipt = await executeDataWranglerNotebookTrialFlow({
      ...base,
      waitForInlineAction: async () => {
        throw new Error("The measured output did not expose one action within 45000 ms.");
      },
      async closeProductEditorAndRestoreNotebook() {
        throw new Error("close failed");
      }
    });

    expect(receipt.failure).toEqual({ stage: "inline", kind: "timeout" });
    expect(receipt.finalization).toEqual({
      closeAttempted: true,
      closeStatus: "failed",
      afterVerification: "matched"
    });
    expect(() => validateDataWranglerNotebookTrialPhaseReceipt(receipt)).not.toThrow();
  });

  it("keeps completed profile columns when a later profile times out", async () => {
    const base = successDependencies([]);
    const receipt = await executeDataWranglerNotebookTrialFlow({
      ...base,
      async profileColumn(index, immediatelyAfterReady) {
        if (index === 3) throw new Error("The public profile did not finish within 135000 ms.");
        return base.profileColumn(index, immediatelyAfterReady);
      }
    });

    expect(receipt).toMatchObject({
      status: "failed",
      failure: { stage: "profiles", kind: "timeout" },
      milestones: { inlineActionMs: 2, workbenchActionMs: 20, workbenchReadyMs: 30, profileActionMs: 40 },
      profiles: { completedColumnCount: 3 }
    });
    expect(receipt.profiles?.columns.map(({ column }) => column)).toEqual(["c00", "c01", "c02"]);
    expect(() => validateDataWranglerNotebookTrialPhaseReceipt(receipt)).not.toThrow();
  });

  it("rejects structurally valid-looking no-op and row-bearing receipt substitutions", async () => {
    const receipt = await executeDataWranglerNotebookTrialFlow(successDependencies([]));
    const mutate = (callback: (value: Mutable<DataWranglerNotebookTrialPhaseReceipt>) => void): unknown => {
      const value = structuredClone(receipt) as Mutable<DataWranglerNotebookTrialPhaseReceipt>;
      callback(value);
      return value;
    };

    expect(() =>
      validateDataWranglerNotebookTrialPhaseReceipt(
        mutate((value) => {
          value.inline!.runCellAction.accessibleName = "Run Cell";
        })
      )
    ).toThrow(/exact stable public Execute Cell/u);
    expect(() =>
      validateDataWranglerNotebookTrialPhaseReceipt(
        mutate((value) => {
          value.inline!.action!.pointerUsable = false;
        })
      )
    ).toThrow(/pointer-usable/u);
    expect(() =>
      validateDataWranglerNotebookTrialPhaseReceipt(
        mutate((value) => {
          value.workbench!.scroll.horizontalWindowChanged = false;
        })
      )
    ).toThrow(/two-axis pointer-wheel/u);
    expect(() =>
      validateDataWranglerNotebookTrialPhaseReceipt(
        mutate((value) => {
          value.profiles!.columns.pop();
          value.profiles!.completedColumnCount -= 1;
        })
      )
    ).toThrow(/incomplete/u);
    expect(() =>
      validateDataWranglerNotebookTrialPhaseReceipt(
        mutate((value) => {
          Object.assign(value.profiles!.columns[0]!, { rowData: [0, 1] });
        })
      )
    ).toThrow(/missing or unknown fields/u);
    expect(() =>
      validateDataWranglerNotebookTrialPhaseReceipt(
        mutate((value) => {
          value.inline!.action!.accessibleName = "Open 'study_frame' in Open Wrangler";
          value.workbench!.action.accessibleName = "Open 'study_frame' in Open Wrangler";
        })
      )
    ).toThrow(/name does not match/u);
    expect(() =>
      validateDataWranglerNotebookTrialPhaseReceipt(
        mutate((value) => {
          value.workbench!.engineLabel = "polars";
        })
      )
    ).toThrow(/engine label/u);
    expect(() =>
      validateDataWranglerNotebookTrialPhaseReceipt(
        mutate((value) => {
          value.profiles!.columns[0]!.distinct = {
            semantics: "approximate",
            lowerBound: 99_000,
            upperBound: 101_000
          };
        })
      )
    ).not.toThrow();
    expect(() =>
      validateDataWranglerNotebookTrialPhaseReceipt(
        mutate((value) => {
          value.study.kernel.displayName = "Open Wrangler study CPython 3.12 /tmp/private-kernel";
        })
      )
    ).toThrow(/path-free/u);
  });
});

describe("notebook public-surface semantic probes", () => {
  function installVisibleGeometry(hit: Element): void {
    vi.spyOn(Element.prototype, "getBoundingClientRect").mockReturnValue({
      x: 10,
      y: 10,
      top: 10,
      right: 210,
      bottom: 110,
      left: 10,
      width: 200,
      height: 100,
      toJSON: () => ({})
    });
    Object.defineProperty(document, "elementFromPoint", {
      configurable: true,
      value: vi.fn(() => hit)
    });
    Object.defineProperty(window, "requestAnimationFrame", {
      configurable: true,
      value: (callback: FrameRequestCallback) => {
        callback(performance.now());
        return 1;
      }
    });
  }

  const sentinelTable = `
    <table>
      <thead><tr><th>c00</th><th>c01</th></tr></thead>
      <tbody><tr><td>0</td><td>1</td></tr><tr><td>1</td><td>2</td></tr></tbody>
    </table>`;

  it("accepts the actual Open Wrangler renderer label only inside its product-owned sentinel preview", async () => {
    document.body.innerHTML = `
      <section class="openwrangler-notebook">
        <h2>Open Wrangler preview: study_frame</h2>
        <button title="Open the complete current value of study_frame">Open in Open Wrangler</button>
        ${sentinelTable}
      </section>`;
    const button = document.querySelector("button")!;
    installVisibleGeometry(button);

    await expect(
      observeNotebookTrialInlineAction(button, {
        product: "open-wrangler",
        expectedName: "Open in Open Wrangler"
      })
    ).resolves.toMatchObject({
      sentinelsVisibleWithAction: true,
      openWranglerRendererOwned: true,
      evidence: {
        accessibleName: "Open in Open Wrangler",
        pointerUsable: true,
        stableFrames: 2
      }
    });
    await expect(
      observeNotebookTrialPointerAction(button, {
        role: "button",
        expectedName: "Open in Open Wrangler"
      })
    ).resolves.toMatchObject({
      accessibleName: "Open in Open Wrangler",
      pointerUsable: true,
      stableFrames: 2
    });

    document.body.innerHTML = `<button title="Open the complete current value of study_frame">Open in Open Wrangler</button>${sentinelTable}`;
    const genericButton = document.querySelector("button")!;
    installVisibleGeometry(genericButton);
    await expect(
      observeNotebookTrialInlineAction(genericButton, {
        product: "open-wrangler",
        expectedName: "Open in Open Wrangler"
      })
    ).resolves.toBeNull();
  });

  it("records the exact variable-specific Data Wrangler host-output action and rejects a guessed generic label", async () => {
    document.body.innerHTML = `
      <div>
        <button aria-label="Open 'study_frame' in Data Wrangler">Open</button>
        ${sentinelTable}
      </div>`;
    const button = document.querySelector("button")!;
    installVisibleGeometry(button);

    await expect(
      observeNotebookTrialInlineAction(button, {
        product: "data-wrangler",
        expectedName: "Open 'study_frame' in Data Wrangler"
      })
    ).resolves.toMatchObject({
      sentinelsVisibleWithAction: true,
      openWranglerRendererOwned: false,
      evidence: { accessibleName: "Open 'study_frame' in Data Wrangler" }
    });
    await expect(
      observeNotebookTrialInlineAction(button, {
        product: "data-wrangler",
        expectedName: "Open in Data Wrangler"
      })
    ).resolves.toBeNull();
  });

  it("accepts only final signed-integer profile semantics and never returns profile text or rows", () => {
    document.body.innerHTML = `
      <aside aria-label="c00 profile">
        <h2>c00</h2>
        <p>Int64 · Missing 0 · Minimum 0 · Maximum 99999 · Distinct 100000</p>
      </aside>`;
    installVisibleGeometry(document.querySelector("aside")!);

    expect(observeNotebookTrialIntegerProfile({ column: "c00", minimum: 0, maximum: 99_999, rows: 100_000 })).toEqual({
      distinct: { semantics: "exact", count: 100_000, percent: null }
    });

    document.querySelector("p")!.textContent =
      "Int64 · Missing 0 · Minimum 0 · Maximum 99999 · Distinct approximately 99000-101000";
    expect(observeNotebookTrialIntegerProfile({ column: "c00", minimum: 0, maximum: 99_999, rows: 100_000 })).toEqual({
      distinct: { semantics: "approximate", lowerBound: 99_000, upperBound: 101_000 }
    });

    document.querySelector("p")!.textContent = "Int64 · Missing 0 · Minimum 0 · Maximum 99999 · Distinct ~99.8k";
    expect(observeNotebookTrialIntegerProfile({ column: "c00", minimum: 0, maximum: 99_999, rows: 100_000 })).toEqual({
      distinct: { semantics: "approximate-unqualified", displayedPoint: 99_800, displayedUnit: "count" }
    });

    document.querySelector("p")!.textContent = "Int64 · Missing 0 · Loading · Minimum 0 · Maximum 99999";
    expect(
      observeNotebookTrialIntegerProfile({ column: "c00", minimum: 0, maximum: 99_999, rows: 100_000 })
    ).toBeNull();
  });

  it("reads the engine word from a visible public product label", () => {
    document.body.innerHTML = `<header><span aria-label="Backend: Polars">Polars</span></header>`;
    installVisibleGeometry(document.querySelector("span")!);
    expect(observeNotebookTrialEngineLabel()).toBe("polars");

    document.body.innerHTML = `<header>Dataframe</header>`;
    installVisibleGeometry(document.querySelector("header")!);
    expect(observeNotebookTrialEngineLabel()).toBe("not-shown");
  });

  it("recognizes formatted full-shape labels and keeps tracking a horizontally virtualized canonical grid", async () => {
    document.body.innerHTML = `
      <div role="status" aria-label="100,000 rows × 50 columns"></div>
      <div role="grid" aria-busy="false">
        <div role="row"><div role="columnheader">c10</div><div role="columnheader">c11</div></div>
        <div role="row"><div role="gridcell">10</div><div role="gridcell">11</div></div>
      </div>`;
    const root = document.querySelector('[role="grid"]')!;
    installVisibleGeometry(root);
    for (const [name, value] of [
      ["clientHeight", 100],
      ["scrollHeight", 1_000],
      ["clientWidth", 100],
      ["scrollWidth", 500],
      ["scrollTop", 200],
      ["scrollLeft", 100]
    ] as const) {
      Object.defineProperty(root, name, { configurable: true, value });
    }

    expect(observeNotebookTrialVisibleShape({ rows: 100_000, columns: 50 })).toBe(true);
    await expect(observeNotebookTrialGridScrollState()).resolves.toMatchObject({
      rootOrdinal: 0,
      verticalOffset: 200,
      horizontalOffset: 100,
      verticalOverflow: 900,
      horizontalOverflow: 400,
      stableFrames: 2,
      pointerUsable: true
    });
  });

  it("reports the first visible c00 value without retaining any other row data", async () => {
    document.body.innerHTML = `
      <div role="grid" aria-busy="false">
        <div role="row"><div role="columnheader">c00</div><div role="columnheader">c01</div></div>
        <div role="row"><div role="gridcell">0</div><div role="gridcell">1</div></div>
        <div role="row"><div role="gridcell">1</div><div role="gridcell">2</div></div>
      </div>`;
    const root = document.querySelector('[role="grid"]')!;
    installVisibleGeometry(root);
    for (const [name, value] of [
      ["clientHeight", 100],
      ["scrollHeight", 1_000],
      ["clientWidth", 100],
      ["scrollWidth", 500],
      ["scrollTop", 0],
      ["scrollLeft", 0]
    ] as const) {
      Object.defineProperty(root, name, { configurable: true, value });
    }

    await expect(observeNotebookTrialGridScrollState()).resolves.toMatchObject({
      firstVisibleC00: 0,
      visibleRowSignature: "01|12"
    });
  });
});
