import { createHash } from "node:crypto";

interface BrowserLifecycle {
  isConnected(): boolean;
}

interface FrameLifecycle {
  isDetached(): boolean;
}

interface PageLifecycle {
  isClosed(): boolean;
  mainFrame(): FrameLifecycle;
}

interface AcceptancePollOptions {
  readonly timeoutMs: number;
  readonly intervalMs: number;
  readonly now?: () => number;
  readonly wait?: (durationMs: number) => Promise<void>;
}

interface PreparedAcceptanceActionOptions<T> extends AcceptancePollOptions {
  readonly acquire: () => Promise<T | undefined>;
  readonly prepare: (action: T) => Promise<void>;
  readonly dispose: (action: T) => Promise<void>;
  readonly isRetryablePreparationError: (error: unknown) => boolean;
}

interface RendererButtonProbe {
  count(): Promise<number>;
  isVisible(): Promise<boolean>;
  isEnabled(options?: { readonly timeout?: number }): Promise<boolean>;
}

interface AcceptanceFailureReacquisitionOptions<T, D> {
  readonly timeoutMs: number;
  readonly diagnose: (deadline: number) => Promise<D>;
  readonly reacquire: (deadline: number) => Promise<T | undefined>;
  readonly now?: () => number;
}

interface KeyboardKeyPair {
  down(key: string): Promise<void>;
  up(key: string): Promise<void>;
}

interface OneShotAcceptanceAction<T> {
  readonly activate: () => Promise<void>;
  readonly receipt: () => Promise<T>;
  readonly naturalDismissal?: () => Promise<void>;
  readonly description: string;
}

interface AuthoritativelyReceiptedOneShotAcceptanceAction<T> extends OneShotAcceptanceAction<T> {
  readonly authoritativeReceiptAfterActivationFailure: () => Promise<T>;
}

interface PreDispatchReacquisitionOptions<T> {
  readonly acquire: () => Promise<T>;
  readonly activate: (action: T) => Promise<void>;
  readonly dispose: (action: T) => Promise<void>;
}

export interface CategoricalUndoAcceptanceSnapshot {
  readonly sessionId: string | undefined;
  readonly revision: number | undefined;
  readonly panelReceipt:
    | Readonly<{
        readonly syncId: string;
        readonly sessionId: string;
        readonly revision: number;
        readonly layoutTransitionPending: boolean;
      }>
    | undefined;
  readonly scheduler:
    | Readonly<{
        readonly sessionId: string;
        readonly quiescent: boolean;
        readonly activeForegroundOperation: boolean;
        readonly activeBackgroundOperation: boolean;
        readonly interactiveQueueLength: number;
        readonly backgroundQueueLength: number;
        readonly terminalOperation: boolean;
      }>
    | undefined;
  readonly restored: boolean;
}

interface FailClosedCategoricalUndoOptions<T> {
  readonly sessionId: string;
  readonly appliedRevision: number;
  readonly snapshot: () => CategoricalUndoAcceptanceSnapshot;
  readonly acquire: () => Promise<T>;
  readonly activate: (action: T) => Promise<void>;
  readonly dispose: (action: T) => Promise<void>;
  readonly checkpoint: (stage: "undo-ready" | "undo-dispatched" | "undo-confirmed") => void;
  readonly readyTimeoutMs: number;
  readonly dispatchTimeoutMs: number;
  readonly confirmationTimeoutMs: number;
  readonly intervalMs?: number;
  readonly now?: () => number;
  readonly wait?: (durationMs: number) => Promise<void>;
  readonly description: string;
}

interface ReplaceableAcceptanceLocator {
  click(options: { readonly timeout: number }): Promise<void>;
}

interface ExactAcceptanceElement {
  scrollIntoViewIfNeeded(options: { readonly timeout: number }): Promise<void>;
  click(options: { readonly force: true; readonly timeout: number }): Promise<void>;
  evaluate<Result>(pageFunction: (element: unknown) => Result | Promise<Result>): Promise<Result>;
}

export interface CodePreviewRectangle {
  readonly left: number;
  readonly top: number;
  readonly width: number;
  readonly height: number;
}

export interface CodePreviewScrollGeometry {
  readonly lineBounds: CodePreviewRectangle | null | undefined;
  readonly scrollerBounds: CodePreviewRectangle | null | undefined;
  readonly scrollTop: number | null | undefined;
  readonly scrollHeight: number | null | undefined;
  readonly clientHeight: number | null | undefined;
  readonly rendererViewport: Readonly<{ width: number; height: number }> | null | undefined;
  readonly tolerance: number;
}

export interface CodePreviewScrollPlan {
  readonly currentFullyVisible: boolean;
  readonly maximumScrollTop: number;
  readonly targetScrollTop: number;
}

export interface CodePreviewDocumentReceipt {
  readonly utf8Length: number;
  readonly sha256: string;
}

export interface CodePreviewLogicalLineSelection {
  readonly position: number;
  readonly documentReceipt: CodePreviewDocumentReceipt;
  readonly lineReceipt: CodePreviewDocumentReceipt;
}

export interface CodePreviewDocumentCheck {
  readonly stage: string;
  readonly passed: boolean;
}

export interface ExactCodePreviewLayoutSample {
  readonly codeReceipt: CodePreviewDocumentReceipt | undefined;
  readonly contentIsExact: boolean;
  readonly previewBounds: CodePreviewRectangle;
  readonly previewConnected: boolean;
  readonly previewOwnsScroller: boolean;
  readonly sameDocument: boolean;
  readonly scrollerBounds: CodePreviewRectangle;
  readonly scrollerClass: string | null;
  readonly scrollerConnected: boolean;
  readonly scrollerIsExact: boolean;
  readonly scrollTop: number;
  readonly scrollHeight: number;
  readonly clientHeight: number;
  readonly rendererViewport: Readonly<{ width: number; height: number }> | undefined;
}

interface StableExactCodePreviewLayoutOptions {
  readonly expectedCodeReceipt: CodePreviewDocumentReceipt;
  readonly sample: () => Promise<ExactCodePreviewLayoutSample>;
  readonly waitForAnimationFrames: () => Promise<void>;
  readonly timeoutMs: number;
  readonly now?: () => number;
}

interface ReplaceableCodePreviewGenerationOptions<T, R> {
  readonly initial: T;
  readonly operate: (generation: T, generationNumber: number) => Promise<R>;
  readonly proveRetired: (generation: T, error: unknown) => Promise<boolean>;
  readonly acquireReplacement: (generationNumber: number, deadline: number) => Promise<T>;
  readonly dispose: (generation: T) => Promise<void>;
  readonly maximumGenerations: number;
  readonly timeoutMs: number;
  readonly now?: () => number;
  readonly description: string;
}

export function codePreviewDocumentReceipt(code: string): CodePreviewDocumentReceipt {
  if (typeof code !== "string") throw new TypeError("A Code Preview document receipt requires a string.");
  return {
    utf8Length: Buffer.byteLength(code, "utf8"),
    sha256: createHash("sha256").update(code, "utf8").digest("hex")
  };
}

export function codePreviewReceiptDiagnostic(receipt: CodePreviewDocumentReceipt): string {
  if (!Number.isSafeInteger(receipt.utf8Length) || receipt.utf8Length < 0 || !/^[0-9a-f]{64}$/u.test(receipt.sha256)) {
    throw new Error("A Code Preview diagnostic requires one valid bounded document receipt.");
  }
  return JSON.stringify(receipt);
}

export function selectUniqueCodePreviewLogicalLine(
  code: string,
  expectedLine: string
): CodePreviewLogicalLineSelection {
  if (typeof code !== "string" || typeof expectedLine !== "string") {
    throw new TypeError("Code Preview logical-line selection requires string inputs.");
  }
  const fail = (stage: "empty" | "multiline" | "missing" | "duplicate"): never => {
    throw new Error(
      `Code Preview logical-line selection failed: ${JSON.stringify({
        stage,
        documentReceipt: codePreviewDocumentReceipt(code),
        lineReceipt: codePreviewDocumentReceipt(expectedLine)
      })}.`
    );
  };
  if (expectedLine.length === 0) fail("empty");
  if (/[\r\n\u2028\u2029]/u.test(expectedLine)) fail("multiline");

  let position = -1;
  let matches = 0;
  let lineStart = 0;
  for (let cursor = 0; cursor <= code.length; cursor += 1) {
    const character = code.charCodeAt(cursor);
    if (cursor < code.length && character !== 10 && character !== 13) continue;
    if (cursor - lineStart === expectedLine.length && code.startsWith(expectedLine, lineStart)) {
      matches += 1;
      if (matches === 1) position = lineStart;
    }
    if (character === 13 && code.charCodeAt(cursor + 1) === 10) cursor += 1;
    lineStart = cursor + 1;
  }
  if (matches === 0) fail("missing");
  if (matches !== 1) fail("duplicate");
  return {
    position,
    documentReceipt: codePreviewDocumentReceipt(code),
    lineReceipt: codePreviewDocumentReceipt(expectedLine)
  };
}

export function assertCodePreviewDocumentChecks(code: string, checks: readonly CodePreviewDocumentCheck[]): void {
  if (!Array.isArray(checks) || checks.length < 1 || checks.length > 32) {
    throw new Error("A Code Preview document assertion requires between one and 32 bounded checks.");
  }
  const receipt = codePreviewDocumentReceipt(code);
  for (const check of checks) {
    if (
      typeof check !== "object" ||
      check === null ||
      typeof check.stage !== "string" ||
      !/^[a-z0-9](?:[a-z0-9:-]{0,94}[a-z0-9])?$/u.test(check.stage) ||
      typeof check.passed !== "boolean"
    ) {
      throw new Error("A Code Preview document assertion requires one fixed ASCII stage and a boolean result.");
    }
    if (!check.passed) {
      throw new Error(`Code Preview document assertion failed: ${JSON.stringify({ stage: check.stage, ...receipt })}.`);
    }
  }
}

export async function waitForStableExactCodePreviewLayout({
  expectedCodeReceipt,
  sample,
  waitForAnimationFrames,
  timeoutMs,
  now = Date.now
}: StableExactCodePreviewLayoutOptions): Promise<ExactCodePreviewLayoutSample> {
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 1) {
    throw new Error("Stable Code Preview layout requires a positive safe-integer deadline.");
  }
  const expectedReceiptDiagnostic = codePreviewReceiptDiagnostic(expectedCodeReceipt);
  const deadline = now() + timeoutMs;
  let previousPositive: ExactCodePreviewLayoutSample | undefined;
  let lastDiagnostic: ReturnType<typeof exactCodePreviewLayoutDiagnostic> | undefined;
  while (now() < deadline) {
    const current = await probeAcceptanceBeforeDeadline(sample, deadline, now);
    if (current === undefined) break;
    lastDiagnostic = exactCodePreviewLayoutDiagnostic(current);
    if (!exactCodePreviewReceiptMatches(current.codeReceipt, expectedCodeReceipt)) {
      throw new Error(
        `The exact Code Preview layout changed from document ${expectedReceiptDiagnostic}: ${JSON.stringify(lastDiagnostic)}.`
      );
    }
    if (
      !current.previewConnected ||
      !current.scrollerConnected ||
      !current.previewOwnsScroller ||
      !current.sameDocument ||
      !current.contentIsExact ||
      !current.scrollerIsExact ||
      !current.scrollerClass?.split(/\s+/u).includes("cm-scroller")
    ) {
      throw new Error(
        `The exact Code Preview layout lost its connected CodeMirror generation for document ${expectedReceiptDiagnostic}: ${JSON.stringify(lastDiagnostic)}.`
      );
    }
    if (exactCodePreviewLayoutIsPositive(current)) {
      if (previousPositive && exactCodePreviewLayoutIsStable(previousPositive, current)) return current;
      previousPositive = current;
    } else {
      previousPositive = undefined;
    }
    const animationFramesCompleted = await probeAcceptanceBeforeDeadline(
      async () => {
        await waitForAnimationFrames();
        return true;
      },
      deadline,
      now
    );
    if (animationFramesCompleted !== true) break;
  }
  throw new Error(
    `The exact Code Preview layout did not materialize within ${timeoutMs} ms for document ${expectedReceiptDiagnostic}. Last geometry: ${JSON.stringify(lastDiagnostic)}.`
  );
}

function exactCodePreviewReceiptMatches(
  actual: CodePreviewDocumentReceipt | undefined,
  expected: CodePreviewDocumentReceipt
): boolean {
  return actual?.utf8Length === expected.utf8Length && actual.sha256 === expected.sha256;
}

function exactCodePreviewLayoutDiagnostic(sample: ExactCodePreviewLayoutSample): Readonly<{
  codeReceipt: CodePreviewDocumentReceipt | undefined;
  exactGeneration: Readonly<{
    contentIsExact: boolean;
    previewConnected: boolean;
    previewOwnsScroller: boolean;
    sameDocument: boolean;
    scrollerClass: string | null;
    scrollerConnected: boolean;
    scrollerIsExact: boolean;
  }>;
  previewBounds: CodePreviewRectangle;
  scrollerBounds: CodePreviewRectangle;
  scrollTop: number;
  scrollHeight: number;
  clientHeight: number;
  rendererViewport: Readonly<{ width: number; height: number }> | undefined;
}> {
  return {
    codeReceipt: sample.codeReceipt,
    exactGeneration: {
      contentIsExact: sample.contentIsExact,
      previewConnected: sample.previewConnected,
      previewOwnsScroller: sample.previewOwnsScroller,
      sameDocument: sample.sameDocument,
      scrollerClass: sample.scrollerClass,
      scrollerConnected: sample.scrollerConnected,
      scrollerIsExact: sample.scrollerIsExact
    },
    previewBounds: sample.previewBounds,
    scrollerBounds: sample.scrollerBounds,
    scrollTop: sample.scrollTop,
    scrollHeight: sample.scrollHeight,
    clientHeight: sample.clientHeight,
    rendererViewport: sample.rendererViewport
  };
}

function exactCodePreviewLayoutIsPositive(sample: ExactCodePreviewLayoutSample): boolean {
  const viewport = sample.rendererViewport;
  const previewBounds = sample.previewBounds;
  const bounds = sample.scrollerBounds;
  return (
    viewport !== undefined &&
    Number.isFinite(viewport.width) &&
    viewport.width > 0 &&
    Number.isFinite(viewport.height) &&
    viewport.height > 0 &&
    Number.isFinite(previewBounds.left) &&
    Number.isFinite(previewBounds.top) &&
    Number.isFinite(previewBounds.width) &&
    previewBounds.width > 0 &&
    Number.isFinite(previewBounds.height) &&
    previewBounds.height > 0 &&
    Number.isFinite(bounds.left) &&
    Number.isFinite(bounds.top) &&
    Number.isFinite(bounds.width) &&
    bounds.width > 0 &&
    Number.isFinite(bounds.height) &&
    bounds.height > 0 &&
    Number.isFinite(sample.scrollTop) &&
    sample.scrollTop >= 0 &&
    Number.isFinite(sample.scrollHeight) &&
    sample.scrollHeight > 0 &&
    Number.isFinite(sample.clientHeight) &&
    sample.clientHeight > 0 &&
    sample.clientHeight <= bounds.height + 1 &&
    sample.scrollHeight + 1 >= sample.clientHeight &&
    sample.scrollTop <= Math.max(0, sample.scrollHeight - sample.clientHeight) + 1 &&
    bounds.left >= -1 &&
    bounds.top >= -1 &&
    bounds.left + bounds.width <= viewport.width + 1 &&
    bounds.top + bounds.height <= viewport.height + 1
  );
}

function exactCodePreviewLayoutIsStable(
  previous: ExactCodePreviewLayoutSample,
  current: ExactCodePreviewLayoutSample
): boolean {
  return (
    previous.rendererViewport?.width === current.rendererViewport?.width &&
    previous.rendererViewport?.height === current.rendererViewport?.height &&
    previous.previewBounds.left === current.previewBounds.left &&
    previous.previewBounds.top === current.previewBounds.top &&
    previous.previewBounds.width === current.previewBounds.width &&
    previous.previewBounds.height === current.previewBounds.height &&
    previous.scrollerBounds.left === current.scrollerBounds.left &&
    previous.scrollerBounds.top === current.scrollerBounds.top &&
    previous.scrollerBounds.width === current.scrollerBounds.width &&
    previous.scrollerBounds.height === current.scrollerBounds.height &&
    previous.scrollTop === current.scrollTop &&
    previous.scrollHeight === current.scrollHeight &&
    previous.clientHeight === current.clientHeight
  );
}

export async function runReplaceableCodePreviewGeneration<T, R>({
  initial,
  operate,
  proveRetired,
  acquireReplacement,
  dispose,
  maximumGenerations,
  timeoutMs,
  now = Date.now,
  description
}: ReplaceableCodePreviewGenerationOptions<T, R>): Promise<R> {
  if (!Number.isSafeInteger(maximumGenerations) || maximumGenerations < 1) {
    throw new Error("Code Preview replacement requires a positive safe-integer generation bound.");
  }
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 1) {
    throw new Error("Code Preview replacement requires a positive safe-integer deadline.");
  }
  const deadline = now() + timeoutMs;
  let current = initial;
  for (let generationNumber = 1; generationNumber <= maximumGenerations; generationNumber += 1) {
    let result: R | undefined;
    let operationError: unknown;
    try {
      result = await operate(current, generationNumber);
    } catch (error) {
      operationError = error;
    }

    let retired = false;
    let retirementError: unknown;
    if (operationError !== undefined) {
      try {
        retired = await proveRetired(current, operationError);
      } catch (error) {
        retirementError = error;
      }
    }

    let cleanupError: unknown;
    try {
      await dispose(current);
    } catch (error) {
      cleanupError = error;
    }
    if (cleanupError !== undefined) {
      const failures = [operationError, retirementError, cleanupError].filter((error) => error !== undefined);
      throw failures.length === 1
        ? cleanupError
        : new AggregateError(failures, `${description} failed and its exact generation cleanup also failed.`);
    }
    if (operationError === undefined) return result as R;
    if (retirementError !== undefined) {
      throw new AggregateError(
        [operationError, retirementError],
        `${description} failed and the generation could not be proven retired.`
      );
    }
    if (!retired) throw operationError;
    if (generationNumber === maximumGenerations || now() >= deadline) {
      throw new Error(
        `${description} exhausted ${generationNumber} proven retired Code Preview generation${generationNumber === 1 ? "" : "s"}.`,
        { cause: operationError }
      );
    }
    current = await acquireReplacement(generationNumber + 1, deadline);
  }
  throw new Error(`${description} exhausted its bounded Code Preview generations.`);
}

export function computeCodePreviewScrollPlan(geometry: CodePreviewScrollGeometry): CodePreviewScrollPlan {
  const tolerance = finiteCodePreviewNumber(geometry.tolerance, "geometry tolerance");
  if (tolerance < 0) throw new Error("Code Preview geometry tolerance must be non-negative.");
  const lineBounds = codePreviewRectangle(geometry.lineBounds, "line");
  const scrollerBounds = codePreviewRectangle(geometry.scrollerBounds, "scroller");
  const rendererViewport = geometry.rendererViewport;
  if (rendererViewport === null || rendererViewport === undefined) {
    throw new Error("Code Preview renderer viewport geometry is required.");
  }
  const rendererWidth = finiteCodePreviewNumber(rendererViewport.width, "renderer viewport width");
  const rendererHeight = finiteCodePreviewNumber(rendererViewport.height, "renderer viewport height");
  if (rendererWidth <= 0 || rendererHeight <= 0) {
    throw new Error("Code Preview renderer viewport dimensions must be positive.");
  }
  const scrollTop = finiteCodePreviewNumber(geometry.scrollTop, "scrollTop");
  const scrollHeight = finiteCodePreviewNumber(geometry.scrollHeight, "scrollHeight");
  const clientHeight = finiteCodePreviewNumber(geometry.clientHeight, "clientHeight");
  if (scrollTop < 0) throw new Error("Code Preview scrollTop must be non-negative.");
  if (scrollHeight <= 0 || clientHeight <= 0) {
    throw new Error("Code Preview scrollHeight and clientHeight must be positive.");
  }
  if (clientHeight > scrollerBounds.height + tolerance) {
    throw new Error("Code Preview clientHeight exceeds the exact scroller geometry.");
  }
  if (scrollHeight + tolerance < clientHeight) {
    throw new Error("Code Preview scrollHeight is smaller than clientHeight.");
  }

  const maximumScrollTop = Math.max(0, scrollHeight - clientHeight);
  if (scrollTop > maximumScrollTop + tolerance) {
    throw new Error("Code Preview scrollTop exceeds the exact scroller range.");
  }
  if (
    scrollerBounds.left < -tolerance ||
    scrollerBounds.top < -tolerance ||
    scrollerBounds.left + scrollerBounds.width > rendererWidth + tolerance ||
    scrollerBounds.top + scrollerBounds.height > rendererHeight + tolerance
  ) {
    throw new Error("The exact Code Preview scroller is not fully exposed in its renderer viewport.");
  }
  if (lineBounds.height > clientHeight) {
    throw new Error("The Code Preview line is too tall to reveal fully in the exact scroller.");
  }

  const boundedScrollTop = Math.min(scrollTop, maximumScrollTop);
  const lineContentTop = lineBounds.top - scrollerBounds.top + boundedScrollTop;
  if (lineContentTop < -tolerance || lineContentTop + lineBounds.height > scrollHeight + tolerance) {
    throw new Error("The Code Preview line geometry falls outside the exact scroller content range.");
  }
  const targetScrollTop = Math.min(
    maximumScrollTop,
    Math.max(0, lineContentTop + lineBounds.height / 2 - clientHeight / 2)
  );
  return {
    currentFullyVisible:
      lineBounds.top >= scrollerBounds.top - tolerance &&
      lineBounds.top + lineBounds.height <= scrollerBounds.top + clientHeight + tolerance,
    maximumScrollTop,
    targetScrollTop
  };
}

function codePreviewRectangle(
  value: CodePreviewRectangle | null | undefined,
  subject: "line" | "scroller"
): CodePreviewRectangle {
  if (value === null || value === undefined) throw new Error(`Code Preview ${subject} geometry is required.`);
  const left = finiteCodePreviewNumber(value.left, `${subject} left`);
  const top = finiteCodePreviewNumber(value.top, `${subject} top`);
  const width = finiteCodePreviewNumber(value.width, `${subject} width`);
  const height = finiteCodePreviewNumber(value.height, `${subject} height`);
  if (width <= 0 || height <= 0) throw new Error(`Code Preview ${subject} dimensions must be positive.`);
  return { left, top, width, height };
}

function finiteCodePreviewNumber(value: number | null | undefined, subject: string): number {
  if (typeof value !== "number" || !Number.isFinite(value)) {
    throw new Error(`Code Preview ${subject} must be finite.`);
  }
  return value;
}

export class IndeterminateAcceptanceActionError extends Error {
  constructor(description: string, cause: unknown) {
    super(`${description} may have been dispatched, but its one-shot user activation did not settle.`, { cause });
    this.name = "IndeterminateAcceptanceActionError";
  }
}

const ACCEPTANCE_ACTION_SAFE_FINAL_REASONS = [
  "covered",
  "click-deadline",
  "disabled",
  "disconnected",
  "geometry",
  "invalid-receipt",
  "probe-error",
  "probe-timeout",
  "unavailable"
] as const;

type AcceptanceActionSafeFinalReason = (typeof ACCEPTANCE_ACTION_SAFE_FINAL_REASONS)[number];

function acceptanceActionSafeFinalReason(value: unknown): AcceptanceActionSafeFinalReason {
  return ACCEPTANCE_ACTION_SAFE_FINAL_REASONS.includes(value as AcceptanceActionSafeFinalReason)
    ? (value as AcceptanceActionSafeFinalReason)
    : "unavailable";
}

export class AcceptanceActionNotDispatchedError extends Error {
  constructor(description: string, cause: unknown, finalReason?: unknown) {
    const reasonSuffix =
      finalReason === undefined ? "" : ` Final reason: ${acceptanceActionSafeFinalReason(finalReason)}.`;
    super(`${description} failed before its click boundary.${reasonSuffix}`, { cause });
    this.name = "AcceptanceActionNotDispatchedError";
  }
}

export async function invokeAcceptanceActionOnce<T>({
  activate,
  receipt,
  naturalDismissal,
  description
}: OneShotAcceptanceAction<T>): Promise<T> {
  try {
    await activate();
  } catch (error) {
    throw new IndeterminateAcceptanceActionError(description, error);
  }

  return observeAcceptanceActionReceipt(receipt, naturalDismissal, description);
}

export async function invokeAcceptanceActionOnceWithAuthoritativeReceipt<T>({
  activate,
  receipt,
  authoritativeReceiptAfterActivationFailure,
  naturalDismissal,
  description
}: AuthoritativelyReceiptedOneShotAcceptanceAction<T>): Promise<T> {
  try {
    await activate();
  } catch (error) {
    if (error instanceof AcceptanceActionNotDispatchedError) throw error;
    const indeterminate = new IndeterminateAcceptanceActionError(description, error);
    try {
      return await authoritativeReceiptAfterActivationFailure();
    } catch (receiptError) {
      throw new AggregateError(
        [indeterminate, receiptError],
        `${description} did not settle and its authoritative receipt could not prove dispatch.`
      );
    }
  }

  return observeAcceptanceActionReceipt(receipt, naturalDismissal, description);
}

export async function activateWithOnePreDispatchReacquisition<T>({
  acquire,
  activate,
  dispose
}: PreDispatchReacquisitionOptions<T>): Promise<void> {
  let ownedAction: T | undefined;
  const acquireBeforeClick = async (): Promise<T> => {
    try {
      return await acquire();
    } catch (error) {
      throw new AcceptanceActionNotDispatchedError("The acceptance action target acquisition", error);
    }
  };
  const release = async (): Promise<void> => {
    if (ownedAction === undefined) return;
    const action = ownedAction;
    ownedAction = undefined;
    await dispose(action);
  };

  ownedAction = await acquireBeforeClick();
  try {
    try {
      await activate(ownedAction);
      return;
    } catch (error) {
      if (!(error instanceof AcceptanceActionNotDispatchedError)) throw error;
    }

    try {
      await release();
    } catch (error) {
      throw new AcceptanceActionNotDispatchedError("The retired acceptance action cleanup", error);
    }
    ownedAction = await acquireBeforeClick();
    try {
      await activate(ownedAction);
    } catch (error) {
      if (error instanceof AcceptanceActionNotDispatchedError) {
        try {
          await release();
        } catch (cleanupError) {
          throw new AcceptanceActionNotDispatchedError("The replacement acceptance action cleanup", cleanupError);
        }
      }
      throw error;
    }
  } finally {
    await release();
  }
}

export async function runFailClosedCategoricalUndo<T>({
  sessionId,
  appliedRevision,
  snapshot,
  acquire,
  activate,
  dispose,
  checkpoint,
  readyTimeoutMs,
  dispatchTimeoutMs,
  confirmationTimeoutMs,
  intervalMs = 50,
  now = Date.now,
  wait = waitForPollInterval,
  description
}: FailClosedCategoricalUndoOptions<T>): Promise<void> {
  if (!sessionId) throw new Error("Categorical Undo requires one non-empty exact session ID.");
  if (!Number.isSafeInteger(appliedRevision) || appliedRevision < 0) {
    throw new Error("Categorical Undo requires one non-negative applied revision.");
  }
  const waitForSnapshot = async (
    predicate: (value: CategoricalUndoAcceptanceSnapshot) => boolean,
    timeoutMs: number,
    stage: "ready" | "dispatch" | "confirmation"
  ): Promise<CategoricalUndoAcceptanceSnapshot> => {
    let latest = snapshot();
    const accepted = await pollAcceptanceCondition(
      async () => {
        latest = snapshot();
        return predicate(latest);
      },
      { timeoutMs, intervalMs, now, wait }
    );
    if (!accepted) {
      throw new Error(
        `${description} did not publish its ${stage} receipt within ${timeoutMs} ms: ${JSON.stringify(latest)}.`
      );
    }
    return latest;
  };
  const exactSession = (value: CategoricalUndoAcceptanceSnapshot): boolean =>
    value.sessionId === sessionId && value.scheduler?.sessionId === sessionId;
  const exactIdleScheduler = (value: CategoricalUndoAcceptanceSnapshot): boolean =>
    exactSession(value) &&
    value.scheduler?.quiescent === true &&
    value.scheduler.activeForegroundOperation === false &&
    value.scheduler.activeBackgroundOperation === false &&
    value.scheduler.interactiveQueueLength === 0 &&
    value.scheduler.backgroundQueueLength === 0 &&
    value.scheduler.terminalOperation === false;
  const waitForDispatch = () =>
    waitForSnapshot(
      (value) =>
        exactSession(value) &&
        ((value.revision ?? appliedRevision) > appliedRevision ||
          value.scheduler?.activeForegroundOperation === true ||
          (value.scheduler?.interactiveQueueLength ?? 0) > 0),
      dispatchTimeoutMs,
      "dispatch"
    );

  await waitForSnapshot(
    (value) =>
      exactIdleScheduler(value) &&
      value.revision === appliedRevision &&
      value.panelReceipt?.sessionId === sessionId &&
      value.panelReceipt.revision === appliedRevision &&
      value.panelReceipt.layoutTransitionPending === false,
    readyTimeoutMs,
    "ready"
  );
  checkpoint("undo-ready");

  await invokeAcceptanceActionOnceWithAuthoritativeReceipt({
    description,
    activate: () => activateWithOnePreDispatchReacquisition({ acquire, activate, dispose }),
    receipt: waitForDispatch,
    authoritativeReceiptAfterActivationFailure: waitForDispatch
  });
  checkpoint("undo-dispatched");

  await waitForSnapshot(
    (value) =>
      exactIdleScheduler(value) &&
      value.restored &&
      value.revision !== undefined &&
      value.revision > appliedRevision &&
      value.panelReceipt?.sessionId === sessionId &&
      value.panelReceipt.revision === value.revision &&
      value.panelReceipt.layoutTransitionPending === false,
    confirmationTimeoutMs,
    "confirmation"
  );
  checkpoint("undo-confirmed");
}

export function activateReplaceableAcceptanceLocator(
  locator: ReplaceableAcceptanceLocator,
  timeoutMs: number
): Promise<void> {
  return locator.click({ timeout: timeoutMs });
}

export async function activateExactAcceptanceElementOnce(
  target: ExactAcceptanceElement,
  timeoutMs: number,
  immediatelyBeforeClick?: () => void
): Promise<void> {
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 1) {
    throw new Error("Exact acceptance-element activation requires a positive safe-integer timeout.");
  }
  if (immediatelyBeforeClick !== undefined && typeof immediatelyBeforeClick !== "function") {
    throw new TypeError("An acceptance click-boundary callback must be a function.");
  }
  const deadline = Date.now() + timeoutMs;
  const remaining = (description: string): number => {
    const remainingMs = deadline - Date.now();
    if (remainingMs < 1) {
      throw new Error(`Timed out waiting for ${description} after ${timeoutMs} ms.`);
    }
    return remainingMs;
  };

  const viewportDescription = "the exact acceptance element outer-viewport placement";
  try {
    const viewportTimeoutMs = remaining(viewportDescription);
    await withAcceptanceOperationDeadline(
      target.scrollIntoViewIfNeeded({ timeout: viewportTimeoutMs }),
      viewportTimeoutMs,
      viewportDescription
    );
  } catch (error) {
    throw new AcceptanceActionNotDispatchedError("The exact acceptance element", error);
  }

  const readinessDescription = "the exact acceptance element readiness";
  const readinessPollIntervalMs = 50;
  let finalReadinessReason: AcceptanceActionSafeFinalReason = "probe-error";
  try {
    for (;;) {
      if (Date.now() >= deadline) {
        throw new Error(
          `The exact acceptance element remained ${finalReadinessReason} after ${timeoutMs} ms of bounded readiness polling.`
        );
      }
      finalReadinessReason = "probe-error";
      const readinessReceipt = await probeAcceptanceBeforeDeadline(
        () =>
          target.evaluate((candidate) => {
            type ClickableElement = {
              readonly disabled?: boolean;
              readonly isConnected: boolean;
              readonly ownerDocument: {
                elementFromPoint(x: number, y: number): ClickableElement | null;
              };
              dataset: Record<string, string | undefined>;
              addEventListener(
                type: "click",
                listener: (event: { readonly isTrusted: boolean }) => void,
                options: { once: boolean }
              ): void;
              matches(selector: string): boolean;
              contains(node: ClickableElement | null): boolean;
              getAttribute(name: string): string | null;
              getBoundingClientRect(): {
                readonly left: number;
                readonly top: number;
                readonly width: number;
                readonly height: number;
              };
            };
            const element = candidate as ClickableElement;
            if (!element.isConnected) return "disconnected";
            if (
              element.disabled === true ||
              element.matches(":disabled") ||
              element.getAttribute("aria-disabled") === "true"
            )
              return "disabled";
            const rect = element.getBoundingClientRect();
            if (rect.width <= 0 || rect.height <= 0) return "geometry";
            const hit = element.ownerDocument.elementFromPoint(rect.left + rect.width / 2, rect.top + rect.height / 2);
            if (hit !== element && !element.contains(hit)) return "covered";
            element.dataset.openWranglerAcceptanceActivation = "pending";
            element.addEventListener(
              "click",
              (event) => {
                if (event.isTrusted) element.dataset.openWranglerAcceptanceActivation = "seen";
              },
              { once: true }
            );
            return "ready";
          }),
        deadline
      );
      if (readinessReceipt === undefined) {
        finalReadinessReason = "probe-timeout";
        throw new Error(`Timed out waiting for ${readinessDescription} after ${timeoutMs} ms.`);
      }
      if (
        readinessReceipt !== "ready" &&
        readinessReceipt !== "covered" &&
        readinessReceipt !== "disabled" &&
        readinessReceipt !== "disconnected" &&
        readinessReceipt !== "geometry"
      ) {
        finalReadinessReason = "invalid-receipt";
        throw new Error("The exact acceptance element returned an invalid bounded readiness receipt.");
      }
      if (readinessReceipt === "ready") break;
      finalReadinessReason = readinessReceipt;
      if (readinessReceipt === "disconnected") {
        throw new Error("The exact acceptance element disconnected before its click boundary.");
      }
      const remainingMs = deadline - Date.now();
      if (remainingMs < 1) continue;
      await waitForPollInterval(Math.min(readinessPollIntervalMs, remainingMs));
    }
  } catch (error) {
    throw new AcceptanceActionNotDispatchedError("The exact acceptance element", error, finalReadinessReason);
  }

  immediatelyBeforeClick?.();
  let clickTimeoutMs: number;
  try {
    clickTimeoutMs = remaining("the exact acceptance element trusted click");
  } catch (error) {
    throw new AcceptanceActionNotDispatchedError("The exact acceptance element", error, "click-deadline");
  }
  await target.click({ force: true, timeout: clickTimeoutMs });
  const receiptDescription = "the exact acceptance element trusted-click receipt";
  const activation = await withAcceptanceOperationDeadline(
    target.evaluate(
      (element) =>
        (element as { readonly dataset: Record<string, string | undefined> }).dataset.openWranglerAcceptanceActivation
    ),
    remaining(receiptDescription),
    receiptDescription
  );
  if (activation !== "seen") {
    throw new Error("The exact acceptance element did not receive one trusted click.");
  }
}

async function observeAcceptanceActionReceipt<T>(
  receipt: () => Promise<T>,
  naturalDismissal: (() => Promise<void>) | undefined,
  description: string
): Promise<T> {
  const receiptResult = receipt();
  if (!naturalDismissal) return receiptResult;

  const [receiptOutcome, dismissalOutcome] = await Promise.allSettled([receiptResult, naturalDismissal()]);
  if (receiptOutcome.status === "rejected" && dismissalOutcome.status === "rejected") {
    throw new AggregateError(
      [receiptOutcome.reason, dismissalOutcome.reason],
      `${description} did not publish its receipt or dismiss its launch surface naturally.`
    );
  }
  if (receiptOutcome.status === "rejected") throw receiptOutcome.reason;
  if (dismissalOutcome.status === "rejected") throw dismissalOutcome.reason;
  return receiptOutcome.value;
}

export async function withAcceptanceOperationDeadline<T>(
  operation: PromiseLike<T>,
  timeoutMs: number,
  description: string
): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<never>((_resolve, reject) => {
    timer = setTimeout(() => {
      reject(new Error(`Timed out waiting for ${description} after ${timeoutMs} ms.`));
    }, timeoutMs);
  });
  try {
    return await Promise.race([operation, timeout]);
  } finally {
    if (timer !== undefined) clearTimeout(timer);
  }
}

export async function probeAcceptanceBeforeDeadline<T>(
  probe: () => PromiseLike<T>,
  deadline: number,
  now: () => number = Date.now
): Promise<T | undefined> {
  const remainingMs = deadline - now();
  if (remainingMs <= 0) return undefined;
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    const outcome = await Promise.race([
      Promise.resolve()
        .then(probe)
        .then(
          (value) => ({ kind: "fulfilled" as const, value }),
          (error: unknown) => ({ kind: "rejected" as const, error })
        ),
      new Promise<{ readonly kind: "timedOut" }>((resolve) => {
        timer = setTimeout(() => resolve({ kind: "timedOut" }), remainingMs);
      })
    ]);
    if (outcome.kind === "rejected") throw outcome.error;
    return outcome.kind === "fulfilled" ? outcome.value : undefined;
  } finally {
    if (timer !== undefined) clearTimeout(timer);
  }
}

export async function pollAcceptanceCondition(
  probe: () => Promise<boolean>,
  { timeoutMs, intervalMs, now = Date.now, wait = waitForPollInterval }: AcceptancePollOptions
): Promise<boolean> {
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 1) {
    throw new Error("Acceptance polling requires a positive safe-integer timeout.");
  }
  if (!Number.isSafeInteger(intervalMs) || intervalMs < 1) {
    throw new Error("Acceptance polling requires a positive safe-integer interval.");
  }

  const deadline = now() + timeoutMs;
  while (true) {
    if (await probe()) return true;
    const remainingMs = deadline - now();
    if (remainingMs <= 0) return false;
    await wait(Math.min(intervalMs, remainingMs));
  }
}

export async function acquirePreparedAcceptanceAction<T>({
  acquire,
  prepare,
  dispose,
  isRetryablePreparationError,
  timeoutMs,
  intervalMs,
  now = Date.now,
  wait = waitForPollInterval
}: PreparedAcceptanceActionOptions<T>): Promise<T | undefined> {
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 1) {
    throw new Error("Acceptance-action preparation requires a positive safe-integer timeout.");
  }
  if (!Number.isSafeInteger(intervalMs) || intervalMs < 1) {
    throw new Error("Acceptance-action preparation requires a positive safe-integer interval.");
  }

  const deadline = now() + timeoutMs;
  let firstAttempt = true;
  while (true) {
    if (!firstAttempt && now() >= deadline) return undefined;
    firstAttempt = false;

    let candidate: T | undefined;
    try {
      candidate = await acquire();
    } catch (error) {
      if (!isRetryablePreparationError(error)) throw error;
    }

    if (candidate !== undefined) {
      let transferred = false;
      try {
        await prepare(candidate);
        transferred = true;
        return candidate;
      } catch (error) {
        if (!isRetryablePreparationError(error)) throw error;
      } finally {
        if (!transferred) await dispose(candidate);
      }
    }

    const remainingMs = deadline - now();
    if (remainingMs <= 0) return undefined;
    await wait(Math.min(intervalMs, remainingMs));
  }
}

export async function probeRendererButtonReadiness(
  button: RendererButtonProbe,
  enabledProbeTimeoutMs: number,
  requireEnabled = true
): Promise<boolean> {
  if ((await button.count()) !== 1) return false;
  if (!(await button.isVisible())) return false;
  return !requireEnabled || button.isEnabled({ timeout: enabledProbeTimeoutMs });
}

export async function diagnoseThenReacquireAcceptanceAction<T, D>({
  timeoutMs,
  diagnose,
  reacquire,
  now = Date.now
}: AcceptanceFailureReacquisitionOptions<T, D>): Promise<{
  readonly action: T | undefined;
  readonly diagnostics: D;
}> {
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 1) {
    throw new Error("Acceptance failure reacquisition requires a positive safe-integer timeout.");
  }
  const deadline = now() + timeoutMs;
  const diagnostics = await diagnose(deadline);
  const action = await reacquire(deadline);
  return { action, diagnostics };
}

export async function pressKeyboardKeyPairWithoutTransitionGap(keyboard: KeyboardKeyPair, key: string): Promise<void> {
  // Playwright's press() awaits key-down before it queues key-up. A transitioning
  // QuickInput can close and show its successor during that acknowledgement, so
  // queue both genuine keyboard events first and then await both responses.
  const keyDown = keyboard.down(key);
  const keyUp = keyboard.up(key);
  const [keyDownResult, keyUpResult] = await Promise.allSettled([keyDown, keyUp]);
  if (keyDownResult.status === "rejected" && keyUpResult.status === "rejected") {
    throw new AggregateError(
      [keyDownResult.reason, keyUpResult.reason],
      "Both transitioning-QuickInput keyboard events failed."
    );
  }
  if (keyDownResult.status === "rejected") throw keyDownResult.reason;
  if (keyUpResult.status === "rejected") throw keyUpResult.reason;
}

export function isRetiredRendererTarget(workbench: PageLifecycle, page: PageLifecycle, frame: FrameLifecycle): boolean {
  return (page !== workbench && page.isClosed()) || (frame !== workbench.mainFrame() && frame.isDetached());
}

export function ignoreRetiredRendererProbeFailure(
  workbench: PageLifecycle,
  browser: BrowserLifecycle | null,
  page: PageLifecycle,
  frame: FrameLifecycle,
  error: unknown
): void {
  if (
    workbench.isClosed() ||
    (browser !== null && !browser.isConnected()) ||
    !isRetiredRendererTarget(workbench, page, frame)
  ) {
    throw error;
  }
}

export async function observeExactRendererRetirement(
  workbench: PageLifecycle,
  browser: BrowserLifecycle | null,
  page: PageLifecycle,
  frame: FrameLifecycle,
  observe: () => PromiseLike<void>
): Promise<void> {
  assertRendererRetirementLifecycle(workbench, browser);
  try {
    await observe();
  } catch (error) {
    if (!rendererRetirementLifecycleIsLive(workbench, browser)) throw error;
    const firstMessageLine = error instanceof Error ? error.message.split(/\r?\n/u, 1)[0] : undefined;
    if (
      firstMessageLine !== "locator.waitFor: Frame was detached" ||
      !isRetiredRendererTarget(workbench, page, frame)
    ) {
      throw error;
    }
    if (!rendererRetirementLifecycleIsLive(workbench, browser)) throw error;
    return;
  }
  assertRendererRetirementLifecycle(workbench, browser);
}

function rendererRetirementLifecycleIsLive(
  workbench: PageLifecycle,
  browser: BrowserLifecycle | null
): browser is BrowserLifecycle {
  return !workbench.isClosed() && browser !== null && browser.isConnected();
}

function assertRendererRetirementLifecycle(
  workbench: PageLifecycle,
  browser: BrowserLifecycle | null
): asserts browser is BrowserLifecycle {
  if (workbench.isClosed()) {
    throw new Error("The editor workbench closed while observing exact renderer retirement.");
  }
  if (browser === null || !browser.isConnected()) {
    throw new Error("The editor CDP browser disconnected while observing exact renderer retirement.");
  }
}

function waitForPollInterval(durationMs: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, durationMs));
}
