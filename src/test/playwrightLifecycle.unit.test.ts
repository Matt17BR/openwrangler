import { describe, expect, it, vi } from "vitest";
import {
  AcceptanceActionNotDispatchedError,
  acquirePreparedAcceptanceAction,
  activateExactAcceptanceElementOnce,
  activateReplaceableAcceptanceLocator,
  activateWithOnePreDispatchReacquisition,
  assertCodePreviewDocumentChecks,
  type CategoricalUndoAcceptanceSnapshot,
  codePreviewDocumentReceipt,
  codePreviewReceiptDiagnostic,
  computeCodePreviewScrollPlan,
  diagnoseThenReacquireAcceptanceAction,
  IndeterminateAcceptanceActionError,
  ignoreRetiredRendererProbeFailure,
  invokeAcceptanceActionOnce,
  invokeAcceptanceActionOnceWithAuthoritativeReceipt,
  isRetiredRendererTarget,
  observeExactRendererRetirement,
  pollAcceptanceCondition,
  probeAcceptanceBeforeDeadline,
  pressKeyboardKeyPairWithoutTransitionGap,
  probeRendererButtonReadiness,
  runFailClosedCategoricalUndo,
  runReplaceableCodePreviewGeneration,
  selectUniqueCodePreviewLogicalLine,
  type ExactCodePreviewLayoutSample,
  waitForStableExactCodePreviewLayout,
  withAcceptanceOperationDeadline
} from "./extensionHost/playwrightLifecycle";

interface FakeFrame {
  isDetached(): boolean;
}

interface FakePage {
  isClosed(): boolean;
  mainFrame(): FakeFrame;
}

function frame(detached = false): FakeFrame {
  return { isDetached: () => detached };
}

function page(mainFrame: FakeFrame, closed = false): FakePage {
  return {
    isClosed: () => closed,
    mainFrame: () => mainFrame
  };
}

const connectedBrowser = { isConnected: () => true };

const categoricalUndoSnapshot = (
  overrides: Partial<CategoricalUndoAcceptanceSnapshot> = {}
): CategoricalUndoAcceptanceSnapshot => {
  const revision = overrides.revision ?? 41;
  return {
    sessionId: "session-r",
    revision,
    panelReceipt: {
      syncId: `sync-r-${revision}`,
      sessionId: "session-r",
      revision,
      layoutTransitionPending: false
    },
    scheduler: {
      sessionId: "session-r",
      quiescent: true,
      activeForegroundOperation: false,
      activeBackgroundOperation: false,
      interactiveQueueLength: 0,
      backgroundQueueLength: 0,
      terminalOperation: false
    },
    restored: false,
    ...overrides
  };
};

const codePreviewGeometry = (
  overrides: Partial<Parameters<typeof computeCodePreviewScrollPlan>[0]> = {}
): Parameters<typeof computeCodePreviewScrollPlan>[0] => ({
  lineBounds: { left: 120, top: 130, width: 280, height: 20 },
  scrollerBounds: { left: 100, top: 100, width: 400, height: 100 },
  scrollTop: 200,
  scrollHeight: 1_000,
  clientHeight: 100,
  rendererViewport: { width: 800, height: 600 },
  tolerance: 1,
  ...overrides
});

const exactCodePreviewLayoutSample = (
  code: string,
  overrides: Partial<ExactCodePreviewLayoutSample> = {}
): ExactCodePreviewLayoutSample => ({
  codeReceipt: codePreviewDocumentReceipt(code),
  contentIsExact: true,
  previewBounds: { left: 112, top: 100, width: 376, height: 120 },
  previewConnected: true,
  previewOwnsScroller: true,
  sameDocument: true,
  scrollerBounds: { left: 100, top: 100, width: 400, height: 120 },
  scrollerClass: "cm-editor cm-scroller",
  scrollerConnected: true,
  scrollerIsExact: true,
  scrollTop: 0,
  scrollHeight: 400,
  clientHeight: 120,
  rendererViewport: { width: 800, height: 600 },
  ...overrides
});

interface FakeExactAcceptanceElement {
  readonly isConnected: boolean;
  readonly disabled: boolean;
  readonly ownerDocument: {
    elementFromPoint(x: number, y: number): FakeExactAcceptanceElement | null;
  };
  readonly dataset: Record<string, string | undefined>;
  addEventListener(
    type: "click",
    listener: (event: { readonly isTrusted: boolean }) => void,
    options: { readonly once: boolean }
  ): void;
  contains(node: FakeExactAcceptanceElement | null): boolean;
  getAttribute(name: string): string | null;
  getBoundingClientRect(): {
    readonly left: number;
    readonly top: number;
    readonly width: number;
    readonly height: number;
  };
}

function exactAcceptanceTarget(
  options: {
    readonly covered?: boolean;
    readonly disconnected?: boolean;
    readonly disabled?: boolean;
    readonly ariaDisabled?: boolean;
    readonly geometry?: boolean;
    readonly readinessReceiptOverride?: unknown;
    readonly readinessSequence?: readonly (
      "aria-disabled" | "covered" | "disabled" | "disconnected" | "geometry" | "ready"
    )[];
    readonly trusted?: boolean;
    readonly clickError?: Error;
    readonly evaluationError?: Readonly<{ readonly call: number; readonly error: Error }>;
    readonly scrollError?: Error;
    readonly stalledScroll?: boolean;
    readonly stalledEvaluation?: 1 | 2;
  } = {}
) {
  let listener: ((event: { readonly isTrusted: boolean }) => void) | undefined;
  let evaluateCalls = 0;
  let readinessChecks = 0;
  const initialReadiness = options.disconnected
    ? "disconnected"
    : options.disabled
      ? "disabled"
      : options.ariaDisabled
        ? "aria-disabled"
        : options.geometry
          ? "geometry"
          : options.covered
            ? "covered"
            : "ready";
  const readinessSequence = options.readinessSequence ?? [initialReadiness];
  let currentReadiness = readinessSequence[0] ?? "ready";
  const occluder = {} as FakeExactAcceptanceElement;
  const element: FakeExactAcceptanceElement = {
    get isConnected() {
      return currentReadiness !== "disconnected";
    },
    get disabled() {
      return currentReadiness === "disabled";
    },
    ownerDocument: {
      elementFromPoint: () => (currentReadiness === "covered" ? occluder : element)
    },
    dataset: {},
    addEventListener: (_type, nextListener) => {
      listener = nextListener;
    },
    contains: () => false,
    getAttribute: (name) => (name === "aria-disabled" && currentReadiness === "aria-disabled" ? "true" : null),
    getBoundingClientRect: () => ({
      left: 10,
      top: 20,
      width: currentReadiness === "geometry" ? 0 : 80,
      height: 30
    })
  };
  const target = {
    scrollIntoViewIfNeeded: vi.fn(async (_scrollOptions: { readonly timeout: number }) => {
      if (options.stalledScroll) return new Promise<void>(() => undefined);
      if (options.scrollError) throw options.scrollError;
    }),
    click: vi.fn(async (_clickOptions: { readonly force: true; readonly timeout: number }) => {
      if (options.clickError) throw options.clickError;
      listener?.({ isTrusted: options.trusted ?? true });
    }),
    async evaluate<Result>(pageFunction: (candidate: unknown) => Result | Promise<Result>): Promise<Result> {
      evaluateCalls += 1;
      if (evaluateCalls === options.stalledEvaluation) return new Promise<Result>(() => undefined);
      if (evaluateCalls === options.evaluationError?.call) throw options.evaluationError.error;
      if (evaluateCalls === 1 && "readinessReceiptOverride" in options) {
        return options.readinessReceiptOverride as Result;
      }
      if (element.dataset.openWranglerAcceptanceActivation === undefined) {
        currentReadiness = readinessSequence[Math.min(readinessChecks, readinessSequence.length - 1)] ?? "ready";
        readinessChecks += 1;
      }
      return pageFunction(element);
    }
  };
  return { element, evaluateCalls: () => evaluateCalls, readinessChecks: () => readinessChecks, target };
}

describe("extension-host Playwright lifecycle", () => {
  it("reduces a multi-megabyte Code Preview document to a bounded non-leaking receipt", () => {
    const sentinel = "DO-NOT-LEAK-CODE-PREVIEW-SENTINEL";
    const code = `${sentinel}\n${"x".repeat(2 * 1024 * 1024)}`;
    const diagnostic = codePreviewReceiptDiagnostic(codePreviewDocumentReceipt(code));
    expect(Buffer.byteLength(diagnostic, "utf8")).toBeLessThan(16 * 1024);
    expect(diagnostic).not.toContain(sentinel);
    expect(JSON.parse(diagnostic)).toEqual({
      utf8Length: Buffer.byteLength(code, "utf8"),
      sha256: expect.stringMatching(/^[0-9a-f]{64}$/u)
    });
  });

  it("fails a multi-megabyte Code Preview document check with only a bounded receipt", () => {
    const sentinel = "DO-NOT-LEAK-CODE-PREVIEW-ASSERTION-SENTINEL";
    const code = `${sentinel}\n${"x".repeat(2 * 1024 * 1024)}`;
    const receipt = codePreviewDocumentReceipt(code);
    let failure: Error | undefined;
    try {
      assertCodePreviewDocumentChecks(code, [{ stage: "released-r:drop:source-boundary", passed: false }]);
    } catch (error) {
      expect(error).toBeInstanceOf(Error);
      failure = error as Error;
    }
    expect(failure).toBeDefined();
    if (!failure) throw new Error("The bounded Code Preview assertion must fail closed.");
    const exactMessage = `Code Preview document assertion failed: ${JSON.stringify({
      stage: "released-r:drop:source-boundary",
      ...receipt
    })}.`;
    expect(failure.message === exactMessage).toBe(true);
    expect(failure.cause === undefined).toBe(true);
    const propertyNames = Object.getOwnPropertyNames(failure).sort();
    expect(propertyNames).toEqual(["message", "stack"]);
    const propertyDiagnostics = propertyNames.map((propertyName) => {
      const value = String((failure as unknown as Record<string, unknown>)[propertyName]);
      return {
        propertyName,
        utf8Length: Buffer.byteLength(value, "utf8"),
        containsSentinel: value.includes(sentinel),
        containsFullSource: value.includes(code)
      };
    });
    expect(propertyDiagnostics.every((property) => property.utf8Length < 16 * 1024)).toBe(true);
    expect(propertyDiagnostics.every((property) => !property.containsSentinel && !property.containsFullSource)).toBe(
      true
    );
    const completeDiagnostic = [failure.name, failure.message, failure.stack, String(failure.cause)].join("\n");
    expect(Buffer.byteLength(completeDiagnostic, "utf8")).toBeLessThan(16 * 1024);
    expect(completeDiagnostic.includes(sentinel)).toBe(false);
    expect(completeDiagnostic.includes(code)).toBe(false);
  });

  it("waits on one connected exact Code Preview generation from zero layout through two stable frame samples", async () => {
    const code = "orders_frame <- orders_frame";
    const zero = exactCodePreviewLayoutSample(code, {
      previewBounds: { left: 0, top: 0, width: 16.44, height: 45_539.81 },
      scrollerBounds: { left: 0, top: 0, width: 0, height: 0 },
      scrollHeight: 0,
      clientHeight: 0,
      rendererViewport: { width: 0, height: 0 }
    });
    const positive = exactCodePreviewLayoutSample(code);
    const samples = [zero, positive, positive];
    let sampleIndex = 0;
    let now = 0;
    const sample = vi.fn(async () => samples[Math.min(sampleIndex++, samples.length - 1)]!);
    const waitForAnimationFrames = vi.fn(async () => {
      now += 16;
    });

    await expect(
      waitForStableExactCodePreviewLayout({
        expectedCodeReceipt: codePreviewDocumentReceipt(code),
        sample,
        waitForAnimationFrames,
        timeoutMs: 100,
        now: () => now
      })
    ).resolves.toEqual(positive);
    expect(sample).toHaveBeenCalledTimes(3);
    expect(waitForAnimationFrames).toHaveBeenCalledTimes(2);
  });

  it("keeps sampling one exact Code Preview generation until changing offscreen geometry stabilizes onscreen", async () => {
    const code = "orders_frame <- transform(orders_frame)";
    const first = exactCodePreviewLayoutSample(code, {
      previewBounds: { left: 112, top: 100, width: 376, height: 100 },
      scrollerBounds: { left: 900, top: 100, width: 400, height: 100 },
      clientHeight: 100
    });
    const settled = exactCodePreviewLayoutSample(code);
    const samples = [first, settled, settled];
    let sampleIndex = 0;
    let now = 0;
    const waitForAnimationFrames = vi.fn(async () => {
      now += 16;
    });

    await expect(
      waitForStableExactCodePreviewLayout({
        expectedCodeReceipt: codePreviewDocumentReceipt(code),
        sample: vi.fn(async () => samples[Math.min(sampleIndex++, samples.length - 1)]!),
        waitForAnimationFrames,
        timeoutMs: 100,
        now: () => now
      })
    ).resolves.toEqual(settled);
    expect(waitForAnimationFrames).toHaveBeenCalledTimes(2);
  });

  it("fails a permanently zero exact Code Preview layout with only its bounded receipt and last geometry", async () => {
    const sentinel = "DO-NOT-LEAK-ZERO-LAYOUT";
    const code = `${sentinel}\n${"x".repeat(2 * 1024 * 1024)}`;
    const zero = exactCodePreviewLayoutSample(code, {
      previewBounds: { left: 0, top: 0, width: 16.44, height: 45_539.81 },
      scrollerBounds: { left: 0, top: 0, width: 0, height: 0 },
      scrollHeight: 0,
      clientHeight: 0,
      rendererViewport: { width: 0, height: 0 }
    });
    let now = 0;
    const waitForAnimationFrames = vi.fn(async () => {
      now += 25;
    });
    let failure: Error | undefined;

    try {
      await waitForStableExactCodePreviewLayout({
        expectedCodeReceipt: codePreviewDocumentReceipt(code),
        sample: vi.fn(async () => zero),
        waitForAnimationFrames,
        timeoutMs: 100,
        now: () => now
      });
    } catch (error) {
      failure = error as Error;
    }
    expect(failure).toBeDefined();
    if (!failure) throw new Error("A permanently zero Code Preview layout must fail closed.");
    expect(failure.message).toContain("did not materialize within 100 ms");
    expect(failure.message).toContain('"clientHeight":0');
    expect(failure.message).toContain(codePreviewDocumentReceipt(code).sha256);
    expect(failure.message).not.toContain(sentinel);
    expect(failure.message).not.toContain(code);
    expect(Buffer.byteLength(failure.message, "utf8")).toBeLessThan(16 * 1024);
    expect(waitForAnimationFrames).toHaveBeenCalledTimes(4);
  });

  it("fails immediately when an exact Code Preview layout sample changes document receipt", async () => {
    const expectedCode = "orders_frame <- orders_frame";
    const waitForAnimationFrames = vi.fn(async () => undefined);

    await expect(
      waitForStableExactCodePreviewLayout({
        expectedCodeReceipt: codePreviewDocumentReceipt(expectedCode),
        sample: vi.fn(async () => exactCodePreviewLayoutSample("replacement <- orders_frame")),
        waitForAnimationFrames,
        timeoutMs: 100
      })
    ).rejects.toThrow("The exact Code Preview layout changed from document");
    expect(waitForAnimationFrames).not.toHaveBeenCalled();
  });

  it("fails immediately when the pinned CodeMirror generation disconnects during layout", async () => {
    const code = "orders_frame <- orders_frame";
    const waitForAnimationFrames = vi.fn(async () => undefined);

    await expect(
      waitForStableExactCodePreviewLayout({
        expectedCodeReceipt: codePreviewDocumentReceipt(code),
        sample: vi.fn(async () => exactCodePreviewLayoutSample(code, { previewConnected: false })),
        waitForAnimationFrames,
        timeoutMs: 100
      })
    ).rejects.toThrow("lost its connected CodeMirror generation");
    expect(waitForAnimationFrames).not.toHaveBeenCalled();
  });

  it("selects one complete logical line past an artifact-shaped substring decoy", () => {
    const expectedLine = '  .ow_drop_names <- c("label")';
    const artifactDecoy = `# open-wrangler-artifact={stage=drop-preview, detail=${expectedLine}, bytes=384}`;
    const code = [artifactDecoy, "  .ow_drop_positions <- c(4L)", expectedLine, "  .ow_result"].join("\n");
    const selection = selectUniqueCodePreviewLogicalLine(code, expectedLine);
    expect(selection).toEqual({
      position: artifactDecoy.length + "\n  .ow_drop_positions <- c(4L)\n".length,
      documentReceipt: codePreviewDocumentReceipt(code),
      lineReceipt: codePreviewDocumentReceipt(expectedLine)
    });
    expect(code.indexOf(expectedLine)).toBeLessThan(selection.position);
  });

  it.each([
    ["empty", "prefix\nbody", ""],
    ["multiline", "prefix\nbody", "DO-NOT-LEAK-LINE\nbody"],
    ["missing", "prefix\nbody", "DO-NOT-LEAK-MISSING-LINE"],
    ["duplicate", "DO-NOT-LEAK-DUPLICATE\nbody\nDO-NOT-LEAK-DUPLICATE", "DO-NOT-LEAK-DUPLICATE"]
  ] as const)("rejects a %s logical-line selector without leaking source", (stage, code, expectedLine) => {
    let failure: Error | undefined;
    try {
      selectUniqueCodePreviewLogicalLine(code, expectedLine);
    } catch (error) {
      expect(error).toBeInstanceOf(Error);
      failure = error as Error;
    }
    expect(failure).toBeDefined();
    if (!failure) throw new Error("The exact logical-line selector must fail closed.");
    expect(failure.message).toBe(
      `Code Preview logical-line selection failed: ${JSON.stringify({
        stage,
        documentReceipt: codePreviewDocumentReceipt(code),
        lineReceipt: codePreviewDocumentReceipt(expectedLine)
      })}.`
    );
    const diagnostic = [failure.name, failure.message, failure.stack, String(failure.cause)].join("\n");
    expect(Buffer.byteLength(diagnostic, "utf8")).toBeLessThan(16 * 1024);
    expect(diagnostic).not.toContain("DO-NOT-LEAK");
    expect(diagnostic).not.toContain(code);
    if (expectedLine.length > 0) expect(diagnostic).not.toContain(expectedLine);
  });

  it("restarts stable Code Preview sampling only after a proven retired generation", async () => {
    const generations = [{ id: 1 }, { id: 2 }];
    const samples: number[] = [];
    const disposed: number[] = [];
    const result = await runReplaceableCodePreviewGeneration({
      initial: generations[0]!,
      operate: vi.fn(async (generation, generationNumber) => {
        samples.push(generation.id);
        if (generation.id === 1) throw new Error("detached generation");
        samples.push(generation.id);
        return { generationNumber, stableSamples: 2 };
      }),
      proveRetired: vi.fn(async (generation) => generation.id === 1),
      acquireReplacement: vi.fn(async () => generations[1]!),
      dispose: vi.fn(async (generation) => {
        disposed.push(generation.id);
      }),
      maximumGenerations: 3,
      timeoutMs: 1_000,
      description: "the generated-code line"
    });
    expect(result).toEqual({ generationNumber: 2, stableSamples: 2 });
    expect(samples).toEqual([1, 2, 2]);
    expect(disposed).toEqual([1, 2]);
  });

  it.each(["live geometry failure", "code receipt mismatch"])(
    "never reacquires a Code Preview generation for %s",
    async (message) => {
      const failure = new Error(message);
      const acquireReplacement = vi.fn();
      await expect(
        runReplaceableCodePreviewGeneration({
          initial: { id: 1 },
          operate: vi.fn(async () => {
            throw failure;
          }),
          proveRetired: vi.fn(async () => false),
          acquireReplacement,
          dispose: vi.fn(async () => undefined),
          maximumGenerations: 3,
          timeoutMs: 1_000,
          description: "the generated-code line"
        })
      ).rejects.toBe(failure);
      expect(acquireReplacement).not.toHaveBeenCalled();
    }
  );

  it("retains both a Code Preview failure and exact-generation cleanup fault", async () => {
    const failure = new Error("live Code Preview failure");
    const cleanup = new Error("handle cleanup failed");
    await expect(
      runReplaceableCodePreviewGeneration({
        initial: { id: 1 },
        operate: vi.fn(async () => {
          throw failure;
        }),
        proveRetired: vi.fn(async () => false),
        acquireReplacement: vi.fn(),
        dispose: vi.fn(async () => {
          throw cleanup;
        }),
        maximumGenerations: 2,
        timeoutMs: 1_000,
        description: "the generated-code line"
      })
    ).rejects.toMatchObject({ errors: [failure, cleanup] });
  });

  it.each([
    ["top", { lineBounds: { left: 120, top: 80, width: 280, height: 20 } }, 140],
    ["bottom", { lineBounds: { left: 120, top: 190, width: 280, height: 20 } }, 250]
  ] as const)("centers a valid line clipped at the %s of the exact scroller", (_edge, overrides, expected) => {
    expect(computeCodePreviewScrollPlan(codePreviewGeometry(overrides))).toEqual({
      currentFullyVisible: false,
      maximumScrollTop: 900,
      targetScrollTop: expected
    });
  });

  it("keeps an exact logical-line anchor subject to the bounded scroller geometry plan", () => {
    const expectedLine = '  .ow_drop_names <- c("label")';
    const artifactDecoy = `# artifact detail=${expectedLine}`;
    const code = `${artifactDecoy}\n${"helper <- 1\n".repeat(24)}${expectedLine}\n`;
    const selection = selectUniqueCodePreviewLogicalLine(code, expectedLine);
    expect(selection.position).toBeGreaterThan(code.indexOf(expectedLine));
    expect(
      computeCodePreviewScrollPlan(codePreviewGeometry({ lineBounds: { left: 120, top: 190, width: 280, height: 20 } }))
    ).toEqual({ currentFullyVisible: false, maximumScrollTop: 900, targetScrollTop: 250 });
  });

  it("accepts only tolerance-bounded exposure and scroll-range overshoot", () => {
    expect(
      computeCodePreviewScrollPlan(
        codePreviewGeometry({
          lineBounds: { left: 120, top: 100.5, width: 280, height: 100 },
          scrollTop: 900.5
        })
      )
    ).toEqual({ currentFullyVisible: true, maximumScrollTop: 900, targetScrollTop: 900 });
  });

  it.each([
    ["top", { lineBounds: { left: 120, top: 105, width: 280, height: 20 }, scrollTop: 0 }, 0],
    ["bottom", { lineBounds: { left: 120, top: 175, width: 280, height: 20 }, scrollTop: 900 }, 900]
  ] as const)("clamps a centered %s target to the exact scroll range", (_edge, overrides, expected) => {
    expect(computeCodePreviewScrollPlan(codePreviewGeometry(overrides)).targetScrollTop).toBe(expected);
  });

  it("rejects scroll-range overshoot beyond tolerance", () => {
    expect(() => computeCodePreviewScrollPlan(codePreviewGeometry({ scrollTop: 901.01 }))).toThrow(
      "Code Preview scrollTop exceeds the exact scroller range."
    );
  });

  it.each([
    ["missing line", { lineBounds: undefined }, "line geometry is required"],
    [
      "non-finite line",
      { lineBounds: { left: 120, top: 130, width: 280, height: Number.NaN } },
      "line height must be finite"
    ],
    [
      "negative line size",
      { lineBounds: { left: 120, top: 130, width: -1, height: 20 } },
      "line dimensions must be positive"
    ],
    [
      "non-finite viewport",
      { rendererViewport: { width: 800, height: Number.POSITIVE_INFINITY } },
      "renderer viewport height must be finite"
    ],
    ["negative scroll", { scrollTop: -1 }, "scrollTop must be non-negative"],
    ["negative tolerance", { tolerance: -1 }, "geometry tolerance must be non-negative"]
  ] as const)("rejects %s geometry", (_case, overrides, expected) => {
    expect(() => computeCodePreviewScrollPlan(codePreviewGeometry(overrides))).toThrow(expected);
  });

  it("rejects a line taller than the exact scroller viewport", () => {
    expect(() =>
      computeCodePreviewScrollPlan(
        codePreviewGeometry({ lineBounds: { left: 120, top: 100, width: 280, height: 100.01 } })
      )
    ).toThrow("The Code Preview line is too tall to reveal fully in the exact scroller.");
  });

  it.each([
    ["top", { left: 100, top: -1.01, width: 400, height: 100 }],
    ["right", { left: 401.01, top: 100, width: 400, height: 100 }],
    ["bottom", { left: 100, top: 501.01, width: 400, height: 100 }]
  ] as const)("rejects an exact scroller outside the renderer %s edge", (_edge, scrollerBounds) => {
    expect(() => computeCodePreviewScrollPlan(codePreviewGeometry({ scrollerBounds }))).toThrow(
      "The exact Code Preview scroller is not fully exposed in its renderer viewport."
    );
  });

  it("invokes an acceptance action once and treats its receipt as completion", async () => {
    const events: string[] = [];
    const result = await invokeAcceptanceActionOnce({
      description: "the notebook action",
      activate: vi.fn(async () => {
        events.push("activate");
      }),
      receipt: vi.fn(async () => {
        events.push("receipt");
        return "input";
      })
    });

    expect(result).toBe("input");
    expect(events).toEqual(["activate", "receipt"]);
  });

  it("observes natural launch-surface dismissal without issuing cleanup input", async () => {
    const events: string[] = [];
    let resolveReceipt!: (value: string) => void;
    let resolveDismissal!: () => void;
    const receipt = new Promise<string>((resolve) => {
      resolveReceipt = resolve;
    });
    const dismissal = new Promise<void>((resolve) => {
      resolveDismissal = resolve;
    });
    const outcome = invokeAcceptanceActionOnce({
      description: "the notebook overflow action",
      activate: vi.fn(async () => {
        events.push("activate");
      }),
      receipt: vi.fn(() => {
        events.push("receipt-started");
        return receipt;
      }),
      naturalDismissal: vi.fn(() => {
        events.push("dismissal-observed");
        return dismissal;
      })
    });

    await vi.waitFor(() => expect(events).toEqual(["activate", "receipt-started", "dismissal-observed"]));
    resolveDismissal();
    resolveReceipt("input");
    await expect(outcome).resolves.toBe("input");
  });

  it("classifies a one-shot user-activation failure as indeterminate without requesting a receipt", async () => {
    const failure = new Error("CDP response was lost");
    const activate = vi.fn().mockRejectedValue(failure);
    const receipt = vi.fn().mockResolvedValue("input");
    const naturalDismissal = vi.fn().mockResolvedValue(undefined);

    await expect(
      invokeAcceptanceActionOnce({
        description: "the notebook overflow action",
        activate,
        receipt,
        naturalDismissal
      })
    ).rejects.toEqual(
      expect.objectContaining<Partial<IndeterminateAcceptanceActionError>>({
        name: "IndeterminateAcceptanceActionError",
        cause: failure
      })
    );
    expect(activate).toHaveBeenCalledOnce();
    expect(receipt).not.toHaveBeenCalled();
    expect(naturalDismissal).not.toHaveBeenCalled();
  });

  it("accepts an authoritative receipt after an indeterminate activation without retrying the action", async () => {
    const events: string[] = [];
    const activationFailure = new Error("CDP response was lost");
    const activate = vi.fn(async () => {
      events.push("activate");
      throw activationFailure;
    });
    const receipt = vi.fn(async () => {
      events.push("ordinary receipt");
      return "ordinary receipt";
    });
    const authoritativeReceiptAfterActivationFailure = vi.fn(async () => {
      events.push("authoritative receipt");
      return "opened session";
    });
    const naturalDismissal = vi.fn(async () => {
      events.push("natural dismissal");
    });

    await expect(
      invokeAcceptanceActionOnceWithAuthoritativeReceipt({
        description: "the notebook variable action",
        activate,
        receipt,
        authoritativeReceiptAfterActivationFailure,
        naturalDismissal
      })
    ).resolves.toBe("opened session");
    expect(events).toEqual(["activate", "authoritative receipt"]);
    expect(activate).toHaveBeenCalledOnce();
    expect(receipt).not.toHaveBeenCalled();
    expect(authoritativeReceiptAfterActivationFailure).toHaveBeenCalledOnce();
    expect(naturalDismissal).not.toHaveBeenCalled();
  });

  it("skips the authoritative receipt when activation never reaches its click boundary", async () => {
    const preparationFailure = new AcceptanceActionNotDispatchedError(
      "The exact acceptance element",
      new Error("The element was disconnected.")
    );
    const activate = vi.fn().mockRejectedValue(preparationFailure);
    const receipt = vi.fn().mockResolvedValue("ordinary receipt");
    const authoritativeReceiptAfterActivationFailure = vi.fn().mockResolvedValue("opened session");

    await expect(
      invokeAcceptanceActionOnceWithAuthoritativeReceipt({
        description: "the notebook variable action",
        activate,
        receipt,
        authoritativeReceiptAfterActivationFailure
      })
    ).rejects.toBe(preparationFailure);
    expect(activate).toHaveBeenCalledOnce();
    expect(receipt).not.toHaveBeenCalled();
    expect(authoritativeReceiptAfterActivationFailure).not.toHaveBeenCalled();
  });

  it("retains an indeterminate activation and a missing authoritative receipt without retrying the action", async () => {
    const activationFailure = new Error("CDP response was lost");
    const receiptFailure = new Error("the session did not open");
    const activate = vi.fn().mockRejectedValue(activationFailure);
    const receipt = vi.fn().mockResolvedValue("ordinary receipt");
    const authoritativeReceiptAfterActivationFailure = vi.fn().mockRejectedValue(receiptFailure);

    await expect(
      invokeAcceptanceActionOnceWithAuthoritativeReceipt({
        description: "the notebook variable action",
        activate,
        receipt,
        authoritativeReceiptAfterActivationFailure
      })
    ).rejects.toMatchObject({
      message: "the notebook variable action did not settle and its authoritative receipt could not prove dispatch.",
      errors: [
        expect.objectContaining({
          name: "IndeterminateAcceptanceActionError",
          cause: activationFailure
        }),
        receiptFailure
      ]
    });
    expect(activate).toHaveBeenCalledOnce();
    expect(receipt).not.toHaveBeenCalled();
    expect(authoritativeReceiptAfterActivationFailure).toHaveBeenCalledOnce();
  });

  it("uses the ordinary receipt after a settled activation and does not request authoritative recovery", async () => {
    const activate = vi.fn().mockResolvedValue(undefined);
    const receipt = vi.fn().mockResolvedValue("ordinary receipt");
    const authoritativeReceiptAfterActivationFailure = vi.fn().mockResolvedValue("opened session");

    await expect(
      invokeAcceptanceActionOnceWithAuthoritativeReceipt({
        description: "the notebook variable action",
        activate,
        receipt,
        authoritativeReceiptAfterActivationFailure
      })
    ).resolves.toBe("ordinary receipt");
    expect(activate).toHaveBeenCalledOnce();
    expect(receipt).toHaveBeenCalledOnce();
    expect(authoritativeReceiptAfterActivationFailure).not.toHaveBeenCalled();
  });

  it("does not treat an ordinary receipt failure as an indeterminate activation", async () => {
    const receiptFailure = new Error("the ordinary receipt is missing");
    const activate = vi.fn().mockResolvedValue(undefined);
    const receipt = vi.fn().mockRejectedValue(receiptFailure);
    const authoritativeReceiptAfterActivationFailure = vi.fn().mockResolvedValue("opened session");

    await expect(
      invokeAcceptanceActionOnceWithAuthoritativeReceipt({
        description: "the notebook variable action",
        activate,
        receipt,
        authoritativeReceiptAfterActivationFailure
      })
    ).rejects.toBe(receiptFailure);
    expect(activate).toHaveBeenCalledOnce();
    expect(receipt).toHaveBeenCalledOnce();
    expect(authoritativeReceiptAfterActivationFailure).not.toHaveBeenCalled();
  });

  it("reacquires an acceptance action replaced during discovery or pre-click preparation", async () => {
    const replaced = new Error("element was detached");
    const staleAction = { id: "stale" };
    const readyAction = { id: "ready" };
    const acquire = vi
      .fn()
      .mockRejectedValueOnce(replaced)
      .mockResolvedValueOnce(staleAction)
      .mockResolvedValueOnce(readyAction);
    const prepare = vi.fn(async (action: { id: string }) => {
      if (action === staleAction) throw replaced;
    });
    const dispose = vi.fn().mockResolvedValue(undefined);
    let currentTime = 0;
    const wait = vi.fn(async (durationMs: number) => {
      currentTime += durationMs;
    });

    await expect(
      acquirePreparedAcceptanceAction({
        acquire,
        prepare,
        dispose,
        isRetryablePreparationError: (error) => error === replaced,
        timeoutMs: 100,
        intervalMs: 10,
        now: () => currentTime,
        wait
      })
    ).resolves.toBe(readyAction);
    expect(acquire).toHaveBeenCalledTimes(3);
    expect(prepare).toHaveBeenCalledTimes(2);
    expect(dispose).toHaveBeenCalledOnce();
    expect(dispose).toHaveBeenCalledWith(staleAction);
    expect(wait).toHaveBeenCalledTimes(2);
  });

  it("never reacquires after a prepared acceptance action enters its one-shot activation", async () => {
    const action = { id: "ready" };
    const acquire = vi.fn().mockResolvedValue(action);
    const prepared = await acquirePreparedAcceptanceAction({
      acquire,
      prepare: vi.fn().mockResolvedValue(undefined),
      dispose: vi.fn().mockResolvedValue(undefined),
      isRetryablePreparationError: () => true,
      timeoutMs: 100,
      intervalMs: 10
    });
    expect(prepared).toBe(action);

    const activationFailure = new Error("the user activation did not settle");
    const activate = vi.fn().mockRejectedValue(activationFailure);
    await expect(
      invokeAcceptanceActionOnce({
        description: "the prepared variable action",
        activate,
        receipt: vi.fn().mockResolvedValue("opened")
      })
    ).rejects.toMatchObject({
      name: "IndeterminateAcceptanceActionError",
      cause: activationFailure
    });
    expect(acquire).toHaveBeenCalledOnce();
    expect(activate).toHaveBeenCalledOnce();
  });

  it("receipts categorical Undo through background-to-interactive-queue-to-commit", async () => {
    let state = categoricalUndoSnapshot();
    let now = 0;
    const checkpoints: string[] = [];
    const action = { id: "undo" };
    const activate = vi.fn(async () => {
      state = categoricalUndoSnapshot({
        scheduler: {
          ...state.scheduler!,
          quiescent: false,
          activeBackgroundOperation: true,
          interactiveQueueLength: 1
        }
      });
    });
    const wait = vi.fn(async (durationMs: number) => {
      now += durationMs;
      state = categoricalUndoSnapshot({ revision: 42, restored: true });
    });

    await runFailClosedCategoricalUndo({
      sessionId: "session-r",
      appliedRevision: 41,
      snapshot: () => state,
      acquire: vi.fn(async () => action),
      activate,
      dispose: vi.fn(async () => undefined),
      checkpoint: (stage) => checkpoints.push(stage),
      readyTimeoutMs: 100,
      dispatchTimeoutMs: 100,
      confirmationTimeoutMs: 100,
      intervalMs: 10,
      now: () => now,
      wait,
      description: "the categorical Undo"
    });

    expect(activate).toHaveBeenCalledOnce();
    expect(checkpoints).toEqual(["undo-ready", "undo-dispatched", "undo-confirmed"]);
  });

  it("accepts a revision-first categorical Undo dispatch receipt", async () => {
    let state = categoricalUndoSnapshot();
    const checkpoints: string[] = [];
    await runFailClosedCategoricalUndo({
      sessionId: "session-r",
      appliedRevision: 41,
      snapshot: () => state,
      acquire: vi.fn(async () => ({ id: "undo" })),
      activate: vi.fn(async () => {
        state = categoricalUndoSnapshot({ revision: 42, restored: true });
      }),
      dispose: vi.fn(async () => undefined),
      checkpoint: (stage) => checkpoints.push(stage),
      readyTimeoutMs: 100,
      dispatchTimeoutMs: 100,
      confirmationTimeoutMs: 100,
      description: "the categorical Undo"
    });
    expect(checkpoints).toEqual(["undo-ready", "undo-dispatched", "undo-confirmed"]);
  });

  it("allows one safe categorical Undo reacquisition before the click boundary", async () => {
    let state = categoricalUndoSnapshot();
    const first = { id: "retired" };
    const second = { id: "current" };
    const acquire = vi.fn().mockResolvedValueOnce(first).mockResolvedValueOnce(second);
    const activate = vi.fn(async (action: { id: string }) => {
      if (action === first) {
        throw new AcceptanceActionNotDispatchedError("the retired Undo", new Error("disconnected"));
      }
      state = categoricalUndoSnapshot({ revision: 42, restored: true });
    });
    const dispose = vi.fn(async () => undefined);

    await runFailClosedCategoricalUndo({
      sessionId: "session-r",
      appliedRevision: 41,
      snapshot: () => state,
      acquire,
      activate,
      dispose,
      checkpoint: vi.fn(),
      readyTimeoutMs: 100,
      dispatchTimeoutMs: 100,
      confirmationTimeoutMs: 100,
      description: "the categorical Undo"
    });

    expect(acquire).toHaveBeenCalledTimes(2);
    expect(activate).toHaveBeenCalledTimes(2);
    expect(dispose).toHaveBeenCalledTimes(2);
  });

  it("never reacquires categorical Undo after its click boundary", async () => {
    let state = categoricalUndoSnapshot();
    const clickFailure = new Error("trusted click response was lost");
    const acquire = vi.fn(async () => ({ id: "undo" }));
    const activate = vi.fn(async () => {
      state = categoricalUndoSnapshot({ revision: 42, restored: true });
      throw clickFailure;
    });

    await runFailClosedCategoricalUndo({
      sessionId: "session-r",
      appliedRevision: 41,
      snapshot: () => state,
      acquire,
      activate,
      dispose: vi.fn(async () => undefined),
      checkpoint: vi.fn(),
      readyTimeoutMs: 100,
      dispatchTimeoutMs: 100,
      confirmationTimeoutMs: 100,
      description: "the categorical Undo"
    });

    expect(acquire).toHaveBeenCalledOnce();
    expect(activate).toHaveBeenCalledOnce();
  });

  it.each(["missing dispatch receipt", "missing confirmation receipt"])(
    "fails closed on %s after exactly one categorical Undo click",
    async (failure) => {
      let state = categoricalUndoSnapshot();
      let now = 0;
      const acquire = vi.fn(async () => ({ id: "undo" }));
      const activate = vi.fn(async () => {
        if (failure === "missing confirmation receipt") {
          state = categoricalUndoSnapshot({ revision: 42, restored: false });
        }
      });
      const outcome = runFailClosedCategoricalUndo({
        sessionId: "session-r",
        appliedRevision: 41,
        snapshot: () => state,
        acquire,
        activate,
        dispose: vi.fn(async () => undefined),
        checkpoint: vi.fn(),
        readyTimeoutMs: 20,
        dispatchTimeoutMs: 20,
        confirmationTimeoutMs: 20,
        intervalMs: 10,
        now: () => now,
        wait: async (durationMs) => {
          now += durationMs;
        },
        description: "the categorical Undo"
      });

      await expect(outcome).rejects.toThrow(
        failure === "missing dispatch receipt" ? "dispatch receipt" : "confirmation receipt"
      );
      expect(acquire).toHaveBeenCalledOnce();
      expect(activate).toHaveBeenCalledOnce();
    }
  );

  it("clicks the locator's replacement target exactly once when the prepared DOM node is retired", async () => {
    const originalClick = vi.fn();
    const replacementClick = vi.fn();
    let currentTarget = { click: originalClick };
    let continueResolution!: () => void;
    const resolutionGate = new Promise<void>((resolve) => {
      continueResolution = resolve;
    });
    const locator = {
      click: vi.fn(async () => {
        await resolutionGate;
        currentTarget.click();
      })
    };

    const activation = activateReplaceableAcceptanceLocator(locator, 10_000);
    currentTarget = { click: replacementClick };
    continueResolution();
    await activation;

    expect(locator.click).toHaveBeenCalledOnce();
    expect(locator.click).toHaveBeenCalledWith({ timeout: 10_000 });
    expect(originalClick).not.toHaveBeenCalled();
    expect(replacementClick).toHaveBeenCalledOnce();
  });

  it("sends one trusted click to the exact ready element", async () => {
    const { element, evaluateCalls, target } = exactAcceptanceTarget();
    const boundary = vi.fn(() => {
      expect(target.click).not.toHaveBeenCalled();
    });

    await activateExactAcceptanceElementOnce(target, 10_000, boundary);

    expect(boundary).toHaveBeenCalledOnce();
    expect(evaluateCalls()).toBe(2);
    expect(target.scrollIntoViewIfNeeded).toHaveBeenCalledOnce();
    expect(target.click).toHaveBeenCalledOnce();
    const clickOptions = target.click.mock.calls[0]?.[0];
    expect(clickOptions?.force).toBe(true);
    expect(clickOptions?.timeout).toBeGreaterThan(0);
    expect(clickOptions?.timeout).toBeLessThanOrEqual(10_000);
    expect(element.dataset.openWranglerAcceptanceActivation).toBe("seen");
  });

  it("rechecks the overall deadline after the immediate click-boundary callback", async () => {
    vi.useFakeTimers();
    try {
      vi.setSystemTime(new Date("2026-08-14T12:00:00.000Z"));
      const deadlineStart = Date.now();
      const { evaluateCalls, target } = exactAcceptanceTarget();
      const boundary = vi.fn(() => {
        vi.setSystemTime(deadlineStart + 201);
      });

      await expect(activateExactAcceptanceElementOnce(target, 200, boundary)).rejects.toMatchObject({
        name: "AcceptanceActionNotDispatchedError",
        message: "The exact acceptance element failed before its click boundary. Final reason: click-deadline.",
        cause: expect.objectContaining({
          message: "Timed out waiting for the exact acceptance element trusted click after 200 ms."
        })
      });

      expect(boundary).toHaveBeenCalledOnce();
      expect(target.click).not.toHaveBeenCalled();
      expect(evaluateCalls()).toBe(1);
    } finally {
      vi.useRealTimers();
    }
  });

  it.each(["covered", "geometry", "disabled", "aria-disabled"] as const)(
    "waits for an exact temporarily %s element on the same handle",
    async (reason) => {
      vi.useFakeTimers();
      try {
        const { evaluateCalls, readinessChecks, target } = exactAcceptanceTarget({
          readinessSequence: [reason, "ready"]
        });
        const boundary = vi.fn();
        const outcome = activateExactAcceptanceElementOnce(target, 10_000, boundary);

        await vi.advanceTimersByTimeAsync(50);
        await outcome;

        expect(readinessChecks()).toBe(2);
        expect(evaluateCalls()).toBe(3);
        expect(target.scrollIntoViewIfNeeded).toHaveBeenCalledOnce();
        expect(target.click).toHaveBeenCalledOnce();
        expect(boundary).toHaveBeenCalledOnce();
      } finally {
        vi.useRealTimers();
      }
    }
  );

  it("fails a never-ready exact handle with one bounded allowlisted reason and no click", async () => {
    vi.useFakeTimers();
    try {
      const { evaluateCalls, target } = exactAcceptanceTarget({ covered: true });
      const outcome = activateExactAcceptanceElementOnce(target, 200);
      const assertion = expect(outcome).rejects.toMatchObject({
        name: "AcceptanceActionNotDispatchedError",
        message: "The exact acceptance element failed before its click boundary. Final reason: covered.",
        cause: expect.objectContaining({
          message: "The exact acceptance element remained covered after 200 ms of bounded readiness polling."
        })
      });

      await vi.advanceTimersByTimeAsync(200);
      await assertion;
      expect(target.click).not.toHaveBeenCalled();
      expect(evaluateCalls()).toBeGreaterThan(1);
      expect(evaluateCalls()).toBeLessThanOrEqual(4);
    } finally {
      vi.useRealTimers();
    }
  });

  it.each(["covered", "disabled", "geometry"] as const)(
    "reports probe-error when a same-handle readiness probe rejects after %s",
    async (transientReason) => {
      vi.useFakeTimers();
      try {
        const evaluationError = new Error("renderer execution context retired");
        const { evaluateCalls, target } = exactAcceptanceTarget({
          readinessSequence: [transientReason, "ready"],
          evaluationError: { call: 2, error: evaluationError }
        });
        const outcome = activateExactAcceptanceElementOnce(target, 200);
        const assertion = expect(outcome).rejects.toMatchObject({
          name: "AcceptanceActionNotDispatchedError",
          message: "The exact acceptance element failed before its click boundary. Final reason: probe-error.",
          cause: evaluationError
        });

        await vi.advanceTimersByTimeAsync(50);
        await assertion;
        expect(target.click).not.toHaveBeenCalled();
        expect(evaluateCalls()).toBe(2);
      } finally {
        vi.useRealTimers();
      }
    }
  );

  it("maps an invalid readiness receipt to one bounded allowlisted top-level reason", async () => {
    const sentinel = `INVALID-READINESS-${"x".repeat(64 * 1024)}`;
    const { evaluateCalls, target } = exactAcceptanceTarget({ readinessReceiptOverride: sentinel });
    let failure: (Error & { readonly cause?: unknown }) | undefined;
    try {
      await activateExactAcceptanceElementOnce(target, 200);
    } catch (error) {
      expect(error).toBeInstanceOf(AcceptanceActionNotDispatchedError);
      failure = error as Error & { readonly cause?: unknown };
    }
    expect(failure).toBeDefined();
    if (!failure) throw new Error("The invalid readiness receipt must fail before the click boundary.");
    const diagnostic = [failure.message, failure.stack, String((failure.cause as Error | undefined)?.message)].join(
      "\n"
    );
    expect(
      failure.message ===
        "The exact acceptance element failed before its click boundary. Final reason: invalid-receipt."
    ).toBe(true);
    expect(Buffer.byteLength(diagnostic, "utf8")).toBeLessThan(16 * 1024);
    expect(diagnostic.includes(sentinel)).toBe(false);
    expect(target.click).not.toHaveBeenCalled();
    expect(evaluateCalls()).toBe(1);
  });

  it("fails after exactly one click when no trusted event receipt is recorded", async () => {
    const { evaluateCalls, target } = exactAcceptanceTarget({ trusted: false });

    await expect(activateExactAcceptanceElementOnce(target, 10_000)).rejects.toThrow(
      "The exact acceptance element did not receive one trusted click."
    );
    expect(target.click).toHaveBeenCalledOnce();
    expect(evaluateCalls()).toBe(2);
  });

  it("does not retry or inspect after the exact click rejects", async () => {
    const clickError = new Error("Cursor rejected the click");
    const { evaluateCalls, target } = exactAcceptanceTarget({ clickError });

    await expect(activateExactAcceptanceElementOnce(target, 10_000)).rejects.toBe(clickError);
    expect(target.click).toHaveBeenCalledOnce();
    expect(evaluateCalls()).toBe(1);
  });

  it("reacquires one renderer target that retires before the click boundary", async () => {
    const first = exactAcceptanceTarget({ disconnected: true });
    const second = exactAcceptanceTarget();
    const acquire = vi.fn().mockResolvedValueOnce(first.target).mockResolvedValueOnce(second.target);
    const dispose = vi.fn().mockResolvedValue(undefined);

    await activateWithOnePreDispatchReacquisition({
      acquire,
      activate: (target) => activateExactAcceptanceElementOnce(target, 10_000),
      dispose
    });

    expect(acquire).toHaveBeenCalledTimes(2);
    expect(first.target.click).not.toHaveBeenCalled();
    expect(second.target.click).toHaveBeenCalledOnce();
    expect(dispose).toHaveBeenCalledTimes(2);
    expect(dispose).toHaveBeenNthCalledWith(1, first.target);
    expect(dispose).toHaveBeenNthCalledWith(2, second.target);
  });

  it("reacquires one renderer target that cannot enter the outer viewport before the click boundary", async () => {
    const viewportFailure = new Error("Element is outside of the viewport");
    const first = exactAcceptanceTarget({ scrollError: viewportFailure });
    const second = exactAcceptanceTarget();
    const acquire = vi.fn().mockResolvedValueOnce(first.target).mockResolvedValueOnce(second.target);
    const dispose = vi.fn().mockResolvedValue(undefined);
    const boundary = vi.fn();

    await activateWithOnePreDispatchReacquisition({
      acquire,
      activate: (target) => activateExactAcceptanceElementOnce(target, 10_000, boundary),
      dispose
    });

    expect(acquire).toHaveBeenCalledTimes(2);
    expect(first.target.scrollIntoViewIfNeeded).toHaveBeenCalledOnce();
    expect(first.target.click).not.toHaveBeenCalled();
    expect(second.target.scrollIntoViewIfNeeded).toHaveBeenCalledOnce();
    expect(second.target.click).toHaveBeenCalledOnce();
    expect(boundary).toHaveBeenCalledOnce();
    expect(dispose).toHaveBeenCalledTimes(2);
  });

  it("classifies an initial target-acquisition failure before the click boundary", async () => {
    const acquisitionFailure = new Error("renderer discovery failed");
    const acquire = vi.fn().mockRejectedValue(acquisitionFailure);
    const activate = vi.fn();
    const dispose = vi.fn();
    const authoritativeReceiptAfterActivationFailure = vi.fn().mockResolvedValue("opened session");

    await expect(
      invokeAcceptanceActionOnceWithAuthoritativeReceipt({
        description: "the notebook renderer action",
        activate: () => activateWithOnePreDispatchReacquisition({ acquire, activate, dispose }),
        receipt: vi.fn().mockResolvedValue("ordinary receipt"),
        authoritativeReceiptAfterActivationFailure
      })
    ).rejects.toMatchObject({
      name: "AcceptanceActionNotDispatchedError",
      cause: acquisitionFailure
    });

    expect(acquire).toHaveBeenCalledOnce();
    expect(activate).not.toHaveBeenCalled();
    expect(dispose).not.toHaveBeenCalled();
    expect(authoritativeReceiptAfterActivationFailure).not.toHaveBeenCalled();
  });

  it("does not make a third acquisition when replacement discovery fails", async () => {
    const first = exactAcceptanceTarget({ disconnected: true });
    const replacementFailure = new Error("replacement discovery failed");
    const acquire = vi.fn().mockResolvedValueOnce(first.target).mockRejectedValueOnce(replacementFailure);
    const dispose = vi.fn().mockResolvedValue(undefined);

    await expect(
      activateWithOnePreDispatchReacquisition({
        acquire,
        activate: (target) => activateExactAcceptanceElementOnce(target, 10_000),
        dispose
      })
    ).rejects.toMatchObject({
      name: "AcceptanceActionNotDispatchedError",
      cause: replacementFailure
    });

    expect(acquire).toHaveBeenCalledTimes(2);
    expect(first.target.click).not.toHaveBeenCalled();
    expect(dispose).toHaveBeenCalledOnce();
    expect(dispose).toHaveBeenCalledWith(first.target);
  });

  it("does not reacquire when retiring the first pre-click target fails", async () => {
    const first = exactAcceptanceTarget({ disconnected: true });
    const cleanupFailure = new Error("retired handle did not dispose");
    const acquire = vi.fn().mockResolvedValue(first.target);
    const dispose = vi.fn().mockRejectedValue(cleanupFailure);

    await expect(
      activateWithOnePreDispatchReacquisition({
        acquire,
        activate: (target) => activateExactAcceptanceElementOnce(target, 10_000),
        dispose
      })
    ).rejects.toMatchObject({
      name: "AcceptanceActionNotDispatchedError",
      cause: cleanupFailure
    });

    expect(acquire).toHaveBeenCalledOnce();
    expect(first.target.click).not.toHaveBeenCalled();
    expect(dispose).toHaveBeenCalledOnce();
  });

  it("does not make a third acquisition when the replacement also fails readiness", async () => {
    vi.useFakeTimers();
    try {
      const first = exactAcceptanceTarget({ disconnected: true });
      const second = exactAcceptanceTarget({ covered: true });
      const acquire = vi.fn().mockResolvedValueOnce(first.target).mockResolvedValueOnce(second.target);
      const dispose = vi.fn().mockResolvedValue(undefined);
      const outcome = activateWithOnePreDispatchReacquisition({
        acquire,
        activate: (target) => activateExactAcceptanceElementOnce(target, 200),
        dispose
      });
      const assertion = expect(outcome).rejects.toMatchObject({
        name: "AcceptanceActionNotDispatchedError",
        message: "The exact acceptance element failed before its click boundary. Final reason: covered."
      });

      await vi.advanceTimersByTimeAsync(200);
      await assertion;
      expect(acquire).toHaveBeenCalledTimes(2);
      expect(first.target.click).not.toHaveBeenCalled();
      expect(second.target.click).not.toHaveBeenCalled();
      expect(dispose).toHaveBeenCalledTimes(2);
    } finally {
      vi.useRealTimers();
    }
  });

  it("keeps replacement cleanup failures classified before the click boundary", async () => {
    const first = exactAcceptanceTarget({ disconnected: true });
    const second = exactAcceptanceTarget({ disconnected: true });
    const cleanupFailure = new Error("replacement handle did not dispose");
    const acquire = vi.fn().mockResolvedValueOnce(first.target).mockResolvedValueOnce(second.target);
    const dispose = vi.fn().mockResolvedValueOnce(undefined).mockRejectedValueOnce(cleanupFailure);

    await expect(
      activateWithOnePreDispatchReacquisition({
        acquire,
        activate: (target) => activateExactAcceptanceElementOnce(target, 10_000),
        dispose
      })
    ).rejects.toMatchObject({
      name: "AcceptanceActionNotDispatchedError",
      cause: cleanupFailure
    });

    expect(acquire).toHaveBeenCalledTimes(2);
    expect(first.target.click).not.toHaveBeenCalled();
    expect(second.target.click).not.toHaveBeenCalled();
    expect(dispose).toHaveBeenCalledTimes(2);
  });

  it("does not reacquire after the renderer action crosses its click boundary", async () => {
    const clickFailure = new Error("Cursor rejected the click");
    const first = exactAcceptanceTarget({ clickError: clickFailure });
    const replacement = exactAcceptanceTarget();
    const acquire = vi.fn().mockResolvedValueOnce(first.target).mockResolvedValueOnce(replacement.target);
    const dispose = vi.fn().mockResolvedValue(undefined);
    const boundary = vi.fn();

    await expect(
      activateWithOnePreDispatchReacquisition({
        acquire,
        activate: (target) => activateExactAcceptanceElementOnce(target, 10_000, boundary),
        dispose
      })
    ).rejects.toBe(clickFailure);

    expect(boundary).toHaveBeenCalledOnce();
    expect(acquire).toHaveBeenCalledOnce();
    expect(first.target.click).toHaveBeenCalledOnce();
    expect(replacement.target.click).not.toHaveBeenCalled();
    expect(dispose).toHaveBeenCalledOnce();
    expect(dispose).toHaveBeenCalledWith(first.target);
  });

  it("bounds stalled outer-viewport placement before any click", async () => {
    vi.useFakeTimers();
    try {
      const { evaluateCalls, target } = exactAcceptanceTarget({ stalledScroll: true });
      const outcome = activateExactAcceptanceElementOnce(target, 10_000);
      const assertion = expect(outcome).rejects.toMatchObject({
        name: "AcceptanceActionNotDispatchedError",
        cause: expect.objectContaining({
          message: "Timed out waiting for the exact acceptance element outer-viewport placement after 10000 ms."
        })
      });

      await vi.advanceTimersByTimeAsync(10_000);
      await assertion;
      expect(target.click).not.toHaveBeenCalled();
      expect(evaluateCalls()).toBe(0);
    } finally {
      vi.useRealTimers();
    }
  });

  it("bounds a stalled exact-element readiness check before any click", async () => {
    vi.useFakeTimers();
    try {
      const { evaluateCalls, target } = exactAcceptanceTarget({ stalledEvaluation: 1 });
      const outcome = activateExactAcceptanceElementOnce(target, 10_000);
      const assertion = expect(outcome).rejects.toMatchObject({
        name: "AcceptanceActionNotDispatchedError",
        message: "The exact acceptance element failed before its click boundary. Final reason: probe-timeout.",
        cause: expect.objectContaining({
          message: "Timed out waiting for the exact acceptance element readiness after 10000 ms."
        })
      });

      await vi.advanceTimersByTimeAsync(10_000);
      await assertion;
      expect(target.click).not.toHaveBeenCalled();
      expect(evaluateCalls()).toBe(1);
    } finally {
      vi.useRealTimers();
    }
  });

  it("bounds a stalled trusted-click receipt without issuing another click", async () => {
    vi.useFakeTimers();
    try {
      const { evaluateCalls, target } = exactAcceptanceTarget({ stalledEvaluation: 2 });
      const outcome = activateExactAcceptanceElementOnce(target, 10_000);
      const assertion = expect(outcome).rejects.toThrow(
        "Timed out waiting for the exact acceptance element trusted-click receipt after 10000 ms."
      );

      await vi.advanceTimersByTimeAsync(10_000);
      await assertion;
      expect(target.click).toHaveBeenCalledOnce();
      expect(evaluateCalls()).toBe(2);
    } finally {
      vi.useRealTimers();
    }
  });

  it("retains both a missing receipt and failed natural dismissal", async () => {
    const receiptFailure = new Error("input missing");
    const dismissalFailure = new Error("menu remained open");

    await expect(
      invokeAcceptanceActionOnce({
        description: "the notebook overflow action",
        activate: vi.fn().mockResolvedValue(undefined),
        receipt: vi.fn().mockRejectedValue(receiptFailure),
        naturalDismissal: vi.fn().mockRejectedValue(dismissalFailure)
      })
    ).rejects.toMatchObject({
      message: "the notebook overflow action did not publish its receipt or dismiss its launch surface naturally.",
      errors: [receiptFailure, dismissalFailure]
    });
  });

  it("clears its deadline after an operation settles", async () => {
    vi.useFakeTimers();
    try {
      await expect(withAcceptanceOperationDeadline(Promise.resolve("ready"), 10_000, "the workbench")).resolves.toBe(
        "ready"
      );
      expect(vi.getTimerCount()).toBe(0);
    } finally {
      vi.useRealTimers();
    }
  });

  it("rejects a stalled operation at its local deadline", async () => {
    vi.useFakeTimers();
    try {
      const outcome = withAcceptanceOperationDeadline(new Promise<never>(() => undefined), 10_000, "the prompt");
      const assertion = expect(outcome).rejects.toThrow("Timed out waiting for the prompt after 10000 ms.");
      await vi.advanceTimersByTimeAsync(10_000);
      await assertion;
      expect(vi.getTimerCount()).toBe(0);
    } finally {
      vi.useRealTimers();
    }
  });

  it("preserves an operation's own failure", async () => {
    const error = new Error("locator failed");
    await expect(withAcceptanceOperationDeadline(Promise.reject(error), 10_000, "the prompt")).rejects.toBe(error);
  });

  it("returns a passive probe value before its shared deadline", async () => {
    const probe = vi.fn<() => Promise<string>>().mockResolvedValue("visible");
    await expect(probeAcceptanceBeforeDeadline(probe, 1_500, () => 1_000)).resolves.toBe("visible");
    expect(probe).toHaveBeenCalledTimes(1);
  });

  it("does not start a passive probe after its shared deadline", async () => {
    const probe = vi.fn<() => Promise<string>>().mockResolvedValue("late");
    await expect(probeAcceptanceBeforeDeadline(probe, 1_000, () => 1_000)).resolves.toBeUndefined();
    expect(probe).not.toHaveBeenCalled();
  });

  it("returns undefined for a stalled passive probe and handles its late rejection", async () => {
    vi.useFakeTimers();
    try {
      let rejectLate: ((error: unknown) => void) | undefined;
      const stalled = new Promise<never>((_resolve, reject) => {
        rejectLate = reject;
      });
      const outcome = probeAcceptanceBeforeDeadline(
        () => stalled,
        10_000,
        () => 0
      );
      const assertion = expect(outcome).resolves.toBeUndefined();
      await vi.advanceTimersByTimeAsync(10_000);
      await assertion;
      rejectLate?.(new Error("late locator failure"));
      await Promise.resolve();
      expect(vi.getTimerCount()).toBe(0);
    } finally {
      vi.useRealTimers();
    }
  });

  it("preserves synchronous and asynchronous passive-probe failures", async () => {
    const syncError = new Error("synchronous locator failure");
    const asyncError = new Error("asynchronous locator failure");
    await expect(
      probeAcceptanceBeforeDeadline(
        () => {
          throw syncError;
        },
        10_000,
        () => 0
      )
    ).rejects.toBe(syncError);
    await expect(
      probeAcceptanceBeforeDeadline(
        () => Promise.reject(asyncError),
        10_000,
        () => 0
      )
    ).rejects.toBe(asyncError);
  });

  it("polls a naturally transferred focus state without assigning focus", async () => {
    const probe = vi
      .fn<() => Promise<boolean>>()
      .mockResolvedValueOnce(false)
      .mockResolvedValueOnce(false)
      .mockResolvedValueOnce(true);
    const wait = vi.fn<() => Promise<void>>().mockResolvedValue(undefined);

    await expect(pollAcceptanceCondition(probe, { timeoutMs: 500, intervalMs: 50, wait })).resolves.toBe(true);
    expect(probe).toHaveBeenCalledTimes(3);
    expect(wait).toHaveBeenCalledTimes(2);
    expect(wait).toHaveBeenNthCalledWith(1, 50);
    expect(wait).toHaveBeenNthCalledWith(2, 50);
  });

  it("stops natural-focus polling at its exact deadline", async () => {
    const probe = vi.fn<() => Promise<boolean>>().mockResolvedValue(false);
    let currentTime = 0;
    const wait = vi.fn<(durationMs: number) => Promise<void>>(async (durationMs) => {
      currentTime += durationMs;
    });

    await expect(
      pollAcceptanceCondition(probe, {
        timeoutMs: 100,
        intervalMs: 25,
        now: () => currentTime,
        wait
      })
    ).resolves.toBe(false);
    expect(probe).toHaveBeenCalledTimes(5);
    expect(wait).toHaveBeenCalledTimes(4);
  });

  it("queues key-up before a transitioning-QuickInput key-down acknowledgement and awaits key-down", async () => {
    let resolveKeyDown!: () => void;
    const keyDown = new Promise<void>((resolve) => {
      resolveKeyDown = resolve;
    });
    const keyboard = {
      down: vi.fn().mockReturnValue(keyDown),
      up: vi.fn().mockResolvedValue(undefined)
    };

    const outcome = pressKeyboardKeyPairWithoutTransitionGap(keyboard, "Enter");
    let settled = false;
    void outcome.then(
      () => {
        settled = true;
      },
      () => {
        settled = true;
      }
    );
    await Promise.resolve();

    expect(keyboard.down).toHaveBeenCalledWith("Enter");
    expect(keyboard.up).toHaveBeenCalledWith("Enter");
    expect(settled).toBe(false);

    resolveKeyDown();
    await expect(outcome).resolves.toBeUndefined();
  });

  it("awaits transitioning-QuickInput key-up completion after key-down settles", async () => {
    let resolveKeyUp!: () => void;
    const keyUp = new Promise<void>((resolve) => {
      resolveKeyUp = resolve;
    });
    const keyboard = {
      down: vi.fn().mockResolvedValue(undefined),
      up: vi.fn().mockReturnValue(keyUp)
    };

    const outcome = pressKeyboardKeyPairWithoutTransitionGap(keyboard, "Enter");
    let settled = false;
    void outcome.then(
      () => {
        settled = true;
      },
      () => {
        settled = true;
      }
    );
    await Promise.resolve();

    expect(settled).toBe(false);

    resolveKeyUp();
    await expect(outcome).resolves.toBeUndefined();
  });

  it.each(["down", "up"] as const)("propagates a transitioning-QuickInput key-%s failure", async (failedEvent) => {
    const error = new Error(`${failedEvent} failed`);
    const keyboard = {
      down: vi.fn().mockImplementation(async () => {
        if (failedEvent === "down") throw error;
      }),
      up: vi.fn().mockImplementation(async () => {
        if (failedEvent === "up") throw error;
      })
    };

    await expect(pressKeyboardKeyPairWithoutTransitionGap(keyboard, "Enter")).rejects.toBe(error);
    expect(keyboard.down).toHaveBeenCalledWith("Enter");
    expect(keyboard.up).toHaveBeenCalledWith("Enter");
  });

  it("awaits the peer keyboard event before propagating an early transitioning-QuickInput failure", async () => {
    const error = new Error("key-down failed");
    let resolveKeyUp!: () => void;
    const keyUp = new Promise<void>((resolve) => {
      resolveKeyUp = resolve;
    });
    const keyboard = {
      down: vi.fn().mockRejectedValue(error),
      up: vi.fn().mockReturnValue(keyUp)
    };

    const outcome = pressKeyboardKeyPairWithoutTransitionGap(keyboard, "Enter");
    let settled = false;
    void outcome.then(
      () => {
        settled = true;
      },
      () => {
        settled = true;
      }
    );
    await Promise.resolve();
    expect(settled).toBe(false);

    resolveKeyUp();
    await expect(outcome).rejects.toBe(error);
  });

  it("retains both failures when both transitioning-QuickInput keyboard events reject", async () => {
    const keyDownError = new Error("key-down failed");
    const keyUpError = new Error("key-up failed");
    const keyboard = {
      down: vi.fn().mockRejectedValue(keyDownError),
      up: vi.fn().mockRejectedValue(keyUpError)
    };

    const outcome = pressKeyboardKeyPairWithoutTransitionGap(keyboard, "Enter");
    await expect(outcome).rejects.toMatchObject({
      message: "Both transitioning-QuickInput keyboard events failed.",
      errors: [keyDownError, keyUpError]
    });
  });

  it("reports an absent renderer button without probing presentation or enabled state", async () => {
    const button = {
      count: vi.fn().mockResolvedValue(0),
      isVisible: vi.fn().mockResolvedValue(true),
      isEnabled: vi.fn().mockResolvedValue(true)
    };

    await expect(probeRendererButtonReadiness(button, 1_000)).resolves.toBe(false);
    expect(button.count).toHaveBeenCalledOnce();
    expect(button.isVisible).not.toHaveBeenCalled();
    expect(button.isEnabled).not.toHaveBeenCalled();
  });

  it("rejects an ambiguous renderer action without probing presentation or enabled state", async () => {
    const button = {
      count: vi.fn().mockResolvedValue(2),
      isVisible: vi.fn().mockResolvedValue(true),
      isEnabled: vi.fn().mockResolvedValue(true)
    };

    await expect(probeRendererButtonReadiness(button, 1_000)).resolves.toBe(false);
    expect(button.count).toHaveBeenCalledOnce();
    expect(button.isVisible).not.toHaveBeenCalled();
    expect(button.isEnabled).not.toHaveBeenCalled();
  });

  it("reports a hidden renderer button without probing enabled state", async () => {
    const button = {
      count: vi.fn().mockResolvedValue(1),
      isVisible: vi.fn().mockResolvedValue(false),
      isEnabled: vi.fn().mockResolvedValue(true)
    };

    await expect(probeRendererButtonReadiness(button, 1_000)).resolves.toBe(false);
    expect(button.count).toHaveBeenCalledOnce();
    expect(button.isVisible).toHaveBeenCalledOnce();
    expect(button.isEnabled).not.toHaveBeenCalled();
  });

  it("reports a visible disabled renderer button as unavailable", async () => {
    const button = {
      count: vi.fn().mockResolvedValue(1),
      isVisible: vi.fn().mockResolvedValue(true),
      isEnabled: vi.fn().mockResolvedValue(false)
    };

    await expect(probeRendererButtonReadiness(button, 1_000)).resolves.toBe(false);
    expect(button.count).toHaveBeenCalledOnce();
    expect(button.isVisible).toHaveBeenCalledOnce();
    expect(button.isEnabled).toHaveBeenCalledWith({ timeout: 1_000 });
  });

  it("accepts a visible renderer action when enabled state is not required", async () => {
    const button = {
      count: vi.fn().mockResolvedValue(1),
      isVisible: vi.fn().mockResolvedValue(true),
      isEnabled: vi.fn().mockResolvedValue(false)
    };

    await expect(probeRendererButtonReadiness(button, 1_000, false)).resolves.toBe(true);
    expect(button.count).toHaveBeenCalledOnce();
    expect(button.isVisible).toHaveBeenCalledOnce();
    expect(button.isEnabled).not.toHaveBeenCalled();
  });

  it("reports a visible enabled renderer button without scrolling, focusing, or clicking", async () => {
    const button = {
      count: vi.fn().mockResolvedValue(1),
      isVisible: vi.fn().mockResolvedValue(true),
      isEnabled: vi.fn().mockResolvedValue(true),
      scrollIntoViewIfNeeded: vi.fn(),
      focus: vi.fn(),
      click: vi.fn()
    };

    await expect(probeRendererButtonReadiness(button, 1_000)).resolves.toBe(true);
    expect(button.count).toHaveBeenCalledOnce();
    expect(button.isVisible).toHaveBeenCalledOnce();
    expect(button.isEnabled).toHaveBeenCalledWith({ timeout: 1_000 });
    expect(button.scrollIntoViewIfNeeded).not.toHaveBeenCalled();
    expect(button.focus).not.toHaveBeenCalled();
    expect(button.click).not.toHaveBeenCalled();
  });

  it("keeps a stalled renderer readiness probe inside its explicit operation deadline", async () => {
    vi.useFakeTimers();
    try {
      const button = {
        count: vi.fn(() => new Promise<number>(() => undefined)),
        isVisible: vi.fn().mockResolvedValue(true),
        isEnabled: vi.fn().mockResolvedValue(true)
      };
      const outcome = withAcceptanceOperationDeadline(
        probeRendererButtonReadiness(button, 1_000),
        1_000,
        "the renderer readiness probe"
      );
      const assertion = expect(outcome).rejects.toThrow(
        "Timed out waiting for the renderer readiness probe after 1000 ms."
      );

      await vi.advanceTimersByTimeAsync(1_000);
      await assertion;
      expect(button.count).toHaveBeenCalledOnce();
      expect(button.isVisible).not.toHaveBeenCalled();
      expect(button.isEnabled).not.toHaveBeenCalled();
      expect(vi.getTimerCount()).toBe(0);
    } finally {
      vi.useRealTimers();
    }
  });

  it("reacquires an action that appears while bounded diagnostics run", async () => {
    let now = 1_000;
    let replacementReady = false;
    const diagnose = vi.fn(async (deadline: number) => {
      expect(deadline).toBe(6_000);
      replacementReady = true;
      now = 1_250;
      return { targets: 2 };
    });
    const reacquire = vi.fn(async (deadline: number) => {
      expect(deadline).toBe(6_000);
      return replacementReady && now < deadline ? "replacement" : undefined;
    });

    await expect(
      diagnoseThenReacquireAcceptanceAction({
        timeoutMs: 5_000,
        diagnose,
        reacquire,
        now: () => now
      })
    ).resolves.toEqual({ action: "replacement", diagnostics: { targets: 2 } });
    expect(diagnose).toHaveBeenCalledOnce();
    expect(reacquire).toHaveBeenCalledOnce();
  });

  it("does not extend the failure budget when diagnostics consume it", async () => {
    let now = 1_000;
    const reacquire = vi.fn(async (deadline: number) => (now < deadline ? "late action" : undefined));

    await expect(
      diagnoseThenReacquireAcceptanceAction({
        timeoutMs: 5_000,
        diagnose: async (deadline) => {
          expect(deadline).toBe(6_000);
          now = deadline;
          return "timed out";
        },
        reacquire,
        now: () => now
      })
    ).resolves.toEqual({ action: undefined, diagnostics: "timed out" });
    expect(reacquire).toHaveBeenCalledWith(6_000);
  });

  it.each([0, Number.NaN])("rejects an invalid failure-reacquisition timeout (%s)", async (timeoutMs) => {
    await expect(
      diagnoseThenReacquireAcceptanceAction({
        timeoutMs,
        diagnose: async () => "unused",
        reacquire: async () => "unused"
      })
    ).rejects.toThrow("Acceptance failure reacquisition requires a positive safe-integer timeout.");
  });

  it("retires a closed auxiliary page without treating the workbench as closed", () => {
    const workbench = page(frame());
    const auxiliary = page(frame(true), true);

    expect(isRetiredRendererTarget(workbench, auxiliary, auxiliary.mainFrame())).toBe(true);
    expect(() =>
      ignoreRetiredRendererProbeFailure(
        workbench,
        connectedBrowser,
        auxiliary,
        auxiliary.mainFrame(),
        new Error("target closed")
      )
    ).not.toThrow();
  });

  it("retires detached renderer frames, including workbench child frames", () => {
    const workbenchMain = frame();
    const workbench = page(workbenchMain);
    const rendererFrame = frame(true);

    expect(isRetiredRendererTarget(workbench, workbench, rendererFrame)).toBe(true);
    expect(() =>
      ignoreRetiredRendererProbeFailure(
        workbench,
        connectedBrowser,
        workbench,
        rendererFrame,
        new Error("locator.count: Frame was detached")
      )
    ).not.toThrow();
  });

  it("fails closed when the workbench closes", () => {
    const workbenchMain = frame(true);
    const workbench = page(workbenchMain, true);
    const auxiliary = page(frame(true), true);
    const error = new Error("workbench closed");

    expect(() =>
      ignoreRetiredRendererProbeFailure(workbench, connectedBrowser, auxiliary, auxiliary.mainFrame(), error)
    ).toThrow(error);
  });

  it("fails closed when the CDP browser disconnects", () => {
    const workbench = page(frame());
    const auxiliary = page(frame(true), true);
    const error = new Error("browser disconnected");

    expect(() =>
      ignoreRetiredRendererProbeFailure(
        workbench,
        { isConnected: () => false },
        auxiliary,
        auxiliary.mainFrame(),
        error
      )
    ).toThrow(error);
  });

  it("does not retire the detached workbench main frame", () => {
    const workbenchMain = frame(true);
    const workbench = page(workbenchMain);
    const error = new Error("locator.count: Frame was detached");

    expect(isRetiredRendererTarget(workbench, workbench, workbenchMain)).toBe(false);
    expect(() =>
      ignoreRetiredRendererProbeFailure(workbench, connectedBrowser, workbench, workbenchMain, error)
    ).toThrow(error);
  });

  it("rethrows an unrelated locator failure from a live target", () => {
    const workbench = page(frame());
    const auxiliaryMain = frame();
    const auxiliary = page(auxiliaryMain);
    const error = new Error("locator failed");

    expect(isRetiredRendererTarget(workbench, auxiliary, auxiliaryMain)).toBe(false);
    expect(() =>
      ignoreRetiredRendererProbeFailure(workbench, connectedBrowser, auxiliary, auxiliaryMain, error)
    ).toThrow(error);
  });

  it("accepts normal locator detachment without requiring the containing frame to retire", async () => {
    const workbenchMain = frame();
    const workbench = page(workbenchMain);

    await expect(
      observeExactRendererRetirement(workbench, connectedBrowser, workbench, workbenchMain, async () => undefined)
    ).resolves.toBeUndefined();
  });

  it("accepts only the exact whole-frame-detached locator rejection from a proven retired target", async () => {
    const workbench = page(frame());
    const rendererFrame = frame(true);

    await expect(
      observeExactRendererRetirement(workbench, connectedBrowser, workbench, rendererFrame, async () => {
        throw new Error("locator.waitFor: Frame was detached\nCall log:\n  - waiting for locator");
      })
    ).resolves.toBeUndefined();
  });

  it.each([
    new Error("locator.waitFor: Timeout 10000ms exceeded."),
    new Error("locator.waitFor: Target page, context or browser has been closed"),
    new Error("locator.count: Frame was detached"),
    "locator.waitFor: Frame was detached"
  ])("rethrows a non-retirement locator outcome from a retired target", async (error) => {
    const workbench = page(frame());
    const rendererFrame = frame(true);

    await expect(
      observeExactRendererRetirement(workbench, connectedBrowser, workbench, rendererFrame, async () => {
        throw error;
      })
    ).rejects.toBe(error);
  });

  it("rethrows the exact detached-frame error when the stored target remains live", async () => {
    const workbench = page(frame());
    const rendererFrame = frame();
    const error = new Error("locator.waitFor: Frame was detached");

    await expect(
      observeExactRendererRetirement(workbench, connectedBrowser, workbench, rendererFrame, async () => {
        throw error;
      })
    ).rejects.toBe(error);
  });

  it("rethrows a detached-frame error when the workbench closes or browser disconnects during observation", async () => {
    const rendererFrame = frame(true);
    const workbenchMain = frame();
    let workbenchClosed = false;
    const workbench = {
      isClosed: () => workbenchClosed,
      mainFrame: () => workbenchMain
    };
    const closedError = new Error("locator.waitFor: Frame was detached");
    await expect(
      observeExactRendererRetirement(workbench, connectedBrowser, workbench, rendererFrame, async () => {
        workbenchClosed = true;
        throw closedError;
      })
    ).rejects.toBe(closedError);

    workbenchClosed = false;
    let browserConnected = true;
    const disconnectedError = new Error("locator.waitFor: Frame was detached");
    await expect(
      observeExactRendererRetirement(
        workbench,
        { isConnected: () => browserConnected },
        workbench,
        rendererFrame,
        async () => {
          browserConnected = false;
          throw disconnectedError;
        }
      )
    ).rejects.toBe(disconnectedError);
  });

  it("requires a live workbench and connected browser before and after a normally resolved retirement wait", async () => {
    const main = frame();
    const observe = vi.fn(async () => undefined);
    await expect(
      observeExactRendererRetirement(page(main, true), connectedBrowser, page(main), main, observe)
    ).rejects.toThrow("The editor workbench closed while observing exact renderer retirement.");
    expect(observe).not.toHaveBeenCalled();

    await expect(
      observeExactRendererRetirement(page(main), { isConnected: () => false }, page(main), main, observe)
    ).rejects.toThrow("The editor CDP browser disconnected while observing exact renderer retirement.");
    expect(observe).not.toHaveBeenCalled();

    let closed = false;
    const workbench = {
      isClosed: () => closed,
      mainFrame: () => main
    };
    await expect(
      observeExactRendererRetirement(workbench, connectedBrowser, workbench, main, async () => {
        closed = true;
      })
    ).rejects.toThrow("The editor workbench closed while observing exact renderer retirement.");
  });
});
