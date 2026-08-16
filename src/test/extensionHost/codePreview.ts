import * as assert from "node:assert/strict";
import * as vscode from "vscode";
import type { ElementHandle, Frame, Locator, Page } from "playwright-core";
import {
  codePreviewDocumentReceipt,
  codePreviewReceiptDiagnostic,
  computeCodePreviewScrollPlan,
  ignoreRetiredRendererProbeFailure,
  isRetiredRendererTarget,
  runReplaceableCodePreviewGeneration,
  selectUniqueCodePreviewLogicalLine,
  waitForStableExactCodePreviewLayout
} from "./playwrightLifecycle";

const WORKBENCH_PLAYWRIGHT_TIMEOUT_MS = 10_000;

export async function waitForCodePreview(
  workbench: Page,
  expectedCode: string | undefined,
  language: "Python" | "R" = "Python"
): Promise<Locator> {
  const deadline = Date.now() + 10_000;
  do {
    for (const frame of workbench.frames()) {
      try {
        const content = frame.locator(`[aria-label="Editable generated ${language} code preview"]`);
        if ((await content.count()) === 0 || !(await content.isVisible())) continue;
        if (expectedCode === undefined) return content;
        const completeCode = await content.evaluate((element) => {
          const target = element as unknown as {
            cmTile?: { view?: { state: { doc: { toString(): string } } } };
            innerText?: string;
          };
          return target.cmTile?.view?.state.doc.toString() ?? target.innerText ?? "";
        });
        if (completeCode.includes(expectedCode)) return content;
      } catch (error) {
        // Code Preview is a workbench webview whose iframe can be replaced
        // while its provider refreshes. Ignore only a proven retired child
        // target; failures from the live workbench/frame remain fatal.
        ignoreRetiredRendererProbeFailure(workbench, workbench.context().browser(), frame.page(), frame, error);
      }
    }
    await workbench.waitForTimeout(50);
  } while (Date.now() < deadline);
  if (expectedCode === undefined) throw new Error(`The generated ${language} code preview did not become visible.`);
  throw new Error(
    `The generated code preview did not expose expected text ${codePreviewReceiptDiagnostic(codePreviewDocumentReceipt(expectedCode))}.`
  );
}

type ExactCodePreviewHandle = ElementHandle<unknown>;
type ExactCodePreviewLineMatch = "contains" | "exact-logical-line";

export type DisposableCodePreviewHandle = Readonly<{ dispose(): Promise<void> }>;

interface ExactCodePreviewTarget {
  readonly preview: ExactCodePreviewHandle;
  readonly scroller: ExactCodePreviewHandle;
  readonly code: string;
  readonly codeReceipt: ReturnType<typeof codePreviewDocumentReceipt>;
  readonly workbench?: Page;
  readonly frame?: Frame;
  readonly language?: "Python" | "R";
}

interface ExactCodePreviewIdentity {
  readonly codeReceipt: ReturnType<typeof codePreviewDocumentReceipt> | undefined;
  readonly contentIsExact: boolean;
  readonly previewBounds: Readonly<{ left: number; top: number; width: number; height: number }>;
  readonly previewConnected: boolean;
  readonly previewOwnsScroller: boolean;
  readonly sameDocument: boolean;
  readonly scrollerBounds: Readonly<{ left: number; top: number; width: number; height: number }>;
  readonly scrollerClass: string | null;
  readonly scrollerConnected: boolean;
  readonly scrollerIsExact: boolean;
  readonly scrollTop: number;
  readonly scrollHeight: number;
  readonly clientHeight: number;
  readonly rendererViewport: Readonly<{ width: number; height: number }> | undefined;
}

interface ExactCodePreviewExposure {
  readonly lineBounds: Readonly<{ left: number; top: number; width: number; height: number }>;
  readonly lineConnected: boolean;
  readonly lineMatchesExpectedText: boolean;
  readonly lineTextReceipt: ReturnType<typeof codePreviewDocumentReceipt>;
  readonly sameDocument: boolean;
  readonly scrollerBounds: Readonly<{ left: number; top: number; width: number; height: number }>;
  readonly scrollerContainsLine: boolean;
  readonly scrollTop: number;
  readonly scrollHeight: number;
  readonly clientHeight: number;
  readonly rendererViewport: Readonly<{ width: number; height: number }> | undefined;
}

class ExactCodePreviewDocumentMismatchError extends Error {
  override readonly name = "ExactCodePreviewDocumentMismatchError";
}

async function pinExactCodePreview(
  codePreview: Locator,
  context?: Readonly<{ workbench: Page; frame: Frame; language: "Python" | "R" }>,
  timeoutMs = WORKBENCH_PLAYWRIGHT_TIMEOUT_MS,
  expectedCodeReceipt?: ReturnType<typeof codePreviewDocumentReceipt>
): Promise<ExactCodePreviewTarget> {
  assert.ok(
    Number.isSafeInteger(timeoutMs) && timeoutMs > 0,
    "Pinning an exact Code Preview generation requires a positive bounded timeout."
  );
  const deadline = Date.now() + timeoutMs;
  const preview = await codePreview.elementHandle({ timeout: timeoutMs });
  assert.ok(preview, "The generated-code preview must expose one exact content element.");
  let scroller: ExactCodePreviewHandle | undefined;
  const assertCurrentRendererFrame = (stage: string) => {
    if (context && isRetiredRendererTarget(context.workbench, context.frame.page(), context.frame)) {
      throw new Error(`The exact Code Preview renderer frame retired ${stage}.`);
    }
  };
  try {
    assertCurrentRendererFrame("before handle pinning");
    const parent = await preview.evaluateHandle(
      (element) => (element as { readonly parentElement: unknown }).parentElement
    );
    scroller = (parent.asElement() as ExactCodePreviewHandle | null) ?? undefined;
    if (!scroller) await parent.dispose();
    assert.ok(scroller, "The generated-code preview must expose one exact parent scroller element.");
    const initialIdentity = await readExactCodePreviewIdentity(preview, scroller);
    const pinnedCodeReceipt = expectedCodeReceipt ?? initialIdentity.codeReceipt;
    assert.ok(pinnedCodeReceipt, "The generated-code preview must expose its bounded document receipt before layout.");
    const remainingMs = deadline - Date.now();
    assert.ok(remainingMs > 0, "The exact Code Preview layout deadline expired before renderer sampling.");
    const identity = await waitForStableExactCodePreviewLayout({
      expectedCodeReceipt: pinnedCodeReceipt,
      sample: async () => {
        assertCurrentRendererFrame("before a stable-layout sample");
        const sample = await readExactCodePreviewIdentity(preview, scroller!);
        assertCurrentRendererFrame("after a stable-layout sample");
        return sample;
      },
      waitForAnimationFrames: () => waitForExactCodePreviewAnimationFrames(scroller!),
      timeoutMs: remainingMs
    });
    assertCurrentRendererFrame("before stable-layout transfer");
    assertExactCodePreviewIdentity(identity, pinnedCodeReceipt);
    const code = await preview.evaluate((element) => {
      const content = element as unknown as { cmTile?: { view?: { state: { doc: { toString(): string } } } } };
      return content.cmTile?.view?.state.doc.toString();
    });
    assert.ok(typeof code === "string", "The generated-code preview must expose its complete CodeMirror document.");
    const codeReceipt = codePreviewDocumentReceipt(code);
    assertExactCodePreviewReceipt(codeReceipt, pinnedCodeReceipt, "The pinned Code Preview document");
    assertCurrentRendererFrame("after stable-layout transfer");
    return { preview, scroller, code, codeReceipt, ...context };
  } catch (error) {
    try {
      await releaseExactCodePreview({ preview, scroller });
    } catch (cleanupError) {
      throw new AggregateError([error, cleanupError], "Pinning the exact Code Preview and cleaning it up both failed.");
    }
    throw error;
  }
}

export async function acquireCurrentExactCodePreviewGeneration(
  workbench: Page,
  language: "Python" | "R",
  expectedCodeReceipt: ReturnType<typeof codePreviewDocumentReceipt>,
  deadline: number
): Promise<ExactCodePreviewTarget> {
  while (Date.now() < deadline) {
    for (const frame of workbench.frames()) {
      try {
        const locator = frame.locator(`[aria-label="Editable generated ${language} code preview"]`);
        if ((await locator.count()) !== 1 || !(await locator.isVisible())) continue;
        const remainingMs = deadline - Date.now();
        if (remainingMs < 1) break;
        const target = await pinExactCodePreview(
          locator,
          { workbench, frame, language },
          remainingMs,
          expectedCodeReceipt
        );
        try {
          assertExactCodePreviewReceipt(
            target.codeReceipt,
            expectedCodeReceipt,
            "The current exact Code Preview generation"
          );
          return target;
        } catch (error) {
          await releaseExactCodePreview(target);
          throw error;
        }
      } catch (error) {
        if (error instanceof ExactCodePreviewDocumentMismatchError) throw error;
        ignoreRetiredRendererProbeFailure(workbench, workbench.context().browser(), frame.page(), frame, error);
      }
    }
    const remainingMs = deadline - Date.now();
    if (remainingMs > 0) await workbench.waitForTimeout(Math.min(50, remainingMs));
  }
  throw new Error(
    `The current exact ${language} Code Preview generation did not appear for document ${codePreviewReceiptDiagnostic(expectedCodeReceipt)}.`
  );
}

async function exactCodePreviewGenerationIsRetired(target: ExactCodePreviewTarget, _error: unknown): Promise<boolean> {
  if (_error instanceof ExactCodePreviewDocumentMismatchError) return false;
  if (!target.workbench || !target.frame) return false;
  if (isRetiredRendererTarget(target.workbench, target.frame.page(), target.frame)) return true;
  try {
    const lifecycle = await target.preview.evaluate((element, exactScroller) => {
      const content = element as unknown as {
        readonly isConnected: boolean;
        readonly ownerDocument: unknown;
        readonly parentElement: unknown;
      };
      const scroller = exactScroller as unknown as { readonly isConnected: boolean; readonly ownerDocument: unknown };
      return {
        previewConnected: content.isConnected,
        scrollerConnected: scroller.isConnected,
        previewOwnsScroller: content.parentElement === scroller,
        sameDocument: content.ownerDocument === scroller.ownerDocument
      };
    }, target.scroller);
    return (
      !lifecycle.previewConnected ||
      !lifecycle.scrollerConnected ||
      !lifecycle.previewOwnsScroller ||
      !lifecycle.sameDocument
    );
  } catch {
    return isRetiredRendererTarget(target.workbench, target.frame.page(), target.frame);
  }
}

async function runExactCodePreviewGenerations<T>(
  initial: ExactCodePreviewTarget,
  description: string,
  operate: (target: ExactCodePreviewTarget, generation: number) => Promise<T>
): Promise<T> {
  return runReplaceableCodePreviewGeneration({
    initial,
    operate,
    proveRetired: exactCodePreviewGenerationIsRetired,
    acquireReplacement: async (_generation, deadline) => {
      assert.ok(
        initial.workbench && initial.language,
        `${description} cannot reacquire a proven retired generation without its workbench provenance.`
      );
      return acquireCurrentExactCodePreviewGeneration(
        initial.workbench,
        initial.language,
        initial.codeReceipt,
        deadline
      );
    },
    dispose: releaseExactCodePreview,
    maximumGenerations: 4,
    timeoutMs: WORKBENCH_PLAYWRIGHT_TIMEOUT_MS,
    description
  });
}

async function readExactCodePreviewIdentity(
  preview: ExactCodePreviewHandle,
  scroller: ExactCodePreviewHandle
): Promise<ExactCodePreviewIdentity> {
  const raw = await preview.evaluate((element, exactScroller) => {
    type Rectangle = { left: number; top: number; width: number; height: number };
    type PreviewElement = {
      readonly isConnected: boolean;
      readonly parentElement: unknown;
      readonly ownerDocument: {
        readonly defaultView: null | { readonly innerWidth: number; readonly innerHeight: number };
      };
      getBoundingClientRect(): Rectangle;
      cmTile?: {
        view?: {
          readonly contentDOM: unknown;
          readonly scrollDOM: unknown;
          state: { doc: { toString(): string } };
        };
      };
    };
    type ScrollerElement = {
      readonly isConnected: boolean;
      readonly ownerDocument: unknown;
      readonly scrollTop: number;
      readonly scrollHeight: number;
      readonly clientHeight: number;
      getAttribute(name: string): string | null;
      getBoundingClientRect(): Rectangle;
    };
    const content = element as unknown as PreviewElement;
    const scrollerElement = exactScroller as unknown as ScrollerElement;
    const previewBounds = content.getBoundingClientRect();
    const scrollerBounds = scrollerElement.getBoundingClientRect();
    const rendererWindow = content.ownerDocument.defaultView;
    const view = content.cmTile?.view;
    return {
      code: view?.state.doc.toString(),
      contentIsExact: view?.contentDOM === content,
      previewBounds: {
        left: previewBounds.left,
        top: previewBounds.top,
        width: previewBounds.width,
        height: previewBounds.height
      },
      previewConnected: content.isConnected,
      previewOwnsScroller: content.parentElement === scrollerElement,
      sameDocument: content.ownerDocument === scrollerElement.ownerDocument,
      scrollerBounds: {
        left: scrollerBounds.left,
        top: scrollerBounds.top,
        width: scrollerBounds.width,
        height: scrollerBounds.height
      },
      scrollerClass: scrollerElement.getAttribute("class"),
      scrollerConnected: scrollerElement.isConnected,
      scrollerIsExact: view?.scrollDOM === scrollerElement,
      scrollTop: scrollerElement.scrollTop,
      scrollHeight: scrollerElement.scrollHeight,
      clientHeight: scrollerElement.clientHeight,
      rendererViewport: rendererWindow
        ? { width: rendererWindow.innerWidth, height: rendererWindow.innerHeight }
        : undefined
    };
  }, scroller);
  const { code, ...identity } = raw;
  return {
    ...identity,
    codeReceipt: typeof code === "string" ? codePreviewDocumentReceipt(code) : undefined
  };
}

export function assertExactCodePreviewReceipt(
  actual: ReturnType<typeof codePreviewDocumentReceipt> | undefined,
  expected: ReturnType<typeof codePreviewDocumentReceipt>,
  subject: string
): void {
  if (!actual) {
    throw new ExactCodePreviewDocumentMismatchError(
      `${subject} must expose the expected bounded UTF-8 length/SHA-256 receipt ${codePreviewReceiptDiagnostic(expected)}.`
    );
  }
  if (actual.utf8Length !== expected.utf8Length || actual.sha256 !== expected.sha256) {
    throw new ExactCodePreviewDocumentMismatchError(
      `${subject} changed from ${codePreviewReceiptDiagnostic(expected)} to ${codePreviewReceiptDiagnostic(actual)}.`
    );
  }
}

function assertExactCodePreviewIdentity(
  identity: ExactCodePreviewIdentity,
  expectedCodeReceipt?: ReturnType<typeof codePreviewDocumentReceipt>
): void {
  const actual = JSON.stringify(identity);
  assert.equal(identity.previewConnected, true, `The exact Code Preview content must remain connected: ${actual}.`);
  assert.equal(identity.scrollerConnected, true, `The exact Code Preview scroller must remain connected: ${actual}.`);
  assert.equal(
    identity.previewOwnsScroller,
    true,
    `The exact Code Preview content must retain its exact parent scroller: ${actual}.`
  );
  assert.equal(
    identity.sameDocument,
    true,
    `The exact Code Preview content and scroller must retain one renderer document: ${actual}.`
  );
  assert.equal(
    identity.contentIsExact && identity.scrollerIsExact,
    true,
    `The exact Code Preview must bind CodeMirror contentDOM and scrollDOM to its proven elements: ${actual}.`
  );
  assert.ok(
    identity.scrollerClass?.split(/\s+/u).includes("cm-scroller"),
    `The generated-code preview must expose its exact CodeMirror scroller: ${actual}.`
  );
  assertFinitePositiveCodePreviewRectangle(identity.previewBounds, "content", actual);
  assertFinitePositiveCodePreviewRectangle(identity.scrollerBounds, "scroller", actual);
  assert.ok(
    identity.rendererViewport &&
      Number.isFinite(identity.rendererViewport.width) &&
      identity.rendererViewport.width > 0 &&
      Number.isFinite(identity.rendererViewport.height) &&
      identity.rendererViewport.height > 0,
    `The exact Code Preview must retain a finite positive renderer viewport: ${actual}.`
  );
  if (expectedCodeReceipt === undefined) {
    assert.ok(identity.codeReceipt, `The exact Code Preview must expose a bounded document receipt: ${actual}.`);
  } else {
    assertExactCodePreviewReceipt(identity.codeReceipt, expectedCodeReceipt, "The exact Code Preview document");
  }
}

function assertFinitePositiveCodePreviewRectangle(
  bounds: Readonly<{ left: number; top: number; width: number; height: number }>,
  subject: string,
  actual: string
): void {
  assert.ok(
    Number.isFinite(bounds.left) &&
      Number.isFinite(bounds.top) &&
      Number.isFinite(bounds.width) &&
      bounds.width > 0 &&
      Number.isFinite(bounds.height) &&
      bounds.height > 0,
    `The exact Code Preview ${subject} must have finite positive geometry: ${actual}.`
  );
}

function exactCodePreviewUsableScrollerHeight(identity: ExactCodePreviewIdentity, tolerance: number): number {
  const actual = JSON.stringify(identity);
  assert.ok(
    Number.isFinite(identity.scrollTop) && identity.scrollTop >= 0,
    `The exact Code Preview scroller must have a finite non-negative scrollTop: ${actual}.`
  );
  assert.ok(
    Number.isFinite(identity.scrollHeight) && identity.scrollHeight > 0,
    `The exact Code Preview scroller must have a finite positive scrollHeight: ${actual}.`
  );
  assert.ok(
    Number.isFinite(identity.clientHeight) &&
      identity.clientHeight > 0 &&
      identity.clientHeight <= identity.scrollerBounds.height + tolerance,
    `The exact Code Preview scroller must have a bounded finite positive clientHeight: ${actual}.`
  );
  const maximumScrollTop = identity.scrollHeight - identity.clientHeight;
  assert.ok(
    maximumScrollTop >= -tolerance && identity.scrollTop <= Math.max(0, maximumScrollTop) + tolerance,
    `The exact Code Preview scroller must retain a valid bounded scroll range: ${actual}.`
  );
  assert.ok(
    identity.rendererViewport &&
      identity.scrollerBounds.left >= -tolerance &&
      identity.scrollerBounds.top >= -tolerance &&
      identity.scrollerBounds.left + identity.scrollerBounds.width <= identity.rendererViewport.width + tolerance &&
      identity.scrollerBounds.top + identity.scrollerBounds.height <= identity.rendererViewport.height + tolerance,
    `The exact Code Preview scroller must be fully exposed in its renderer viewport: ${actual}.`
  );
  return Math.min(identity.scrollerBounds.height, identity.clientHeight);
}

async function waitForExactCodePreviewAnimationFrames(scroller: ExactCodePreviewHandle): Promise<void> {
  await scroller.evaluate((element) => {
    const target = element as unknown as {
      readonly ownerDocument: {
        readonly defaultView: null | { requestAnimationFrame(callback: () => void): number };
      };
    };
    const frameWindow = target.ownerDocument.defaultView;
    if (!frameWindow) throw new Error("The exact Code Preview scroller has no owning renderer window.");
    return new Promise<void>((resolve) => {
      frameWindow.requestAnimationFrame(() => frameWindow.requestAnimationFrame(() => resolve()));
    });
  });
}

async function prepareExactCodePreviewLine(
  target: ExactCodePreviewTarget,
  expectedText: string,
  occurrence: "first" | "last",
  match: ExactCodePreviewLineMatch = "contains"
): Promise<ExactCodePreviewHandle> {
  const identity = await readExactCodePreviewIdentity(target.preview, target.scroller);
  assertExactCodePreviewIdentity(identity, target.codeReceipt);
  const expectedTextReceipt = codePreviewReceiptDiagnostic(codePreviewDocumentReceipt(expectedText));
  let position: number;
  if (match === "exact-logical-line") {
    const selection = selectUniqueCodePreviewLogicalLine(target.code, expectedText);
    assertExactCodePreviewReceipt(selection.documentReceipt, target.codeReceipt, "The logical-line source document");
    assertExactCodePreviewReceipt(
      selection.lineReceipt,
      codePreviewDocumentReceipt(expectedText),
      "The selected logical line"
    );
    position = selection.position;
  } else {
    position = occurrence === "first" ? target.code.indexOf(expectedText) : target.code.lastIndexOf(expectedText);
  }
  assert.notEqual(position, -1, `The exact Code Preview document must contain text ${expectedTextReceipt}.`);
  const rawInitialExposure = await target.preview.evaluate(
    (element, options) => {
      type Rectangle = { left: number; top: number; width: number; height: number };
      const content = element as unknown as {
        cmTile?: {
          view?: {
            readonly contentDOM: unknown;
            readonly documentTop: number;
            readonly scaleY: number;
            readonly scrollDOM: unknown;
            dispatch(spec: Readonly<{ selection: Readonly<{ anchor: number }> }>): void;
            lineBlockAt(position: number): Readonly<{
              from: number;
              to: number;
              top: number;
              height: number;
            }>;
            state: { doc: { toString(): string } };
          };
        };
        readonly ownerDocument: {
          readonly defaultView: null | { readonly innerWidth: number; readonly innerHeight: number };
        };
        getBoundingClientRect(): Rectangle;
      };
      const exactScroller = options.exactScroller as unknown as {
        readonly scrollTop: number;
        readonly scrollHeight: number;
        readonly clientHeight: number;
        getBoundingClientRect(): Rectangle;
      };
      const view = content.cmTile?.view;
      if (!view) throw new Error("The exact Code Preview lost its CodeMirror view.");
      view.dispatch({ selection: { anchor: options.position } });
      const block = view.lineBlockAt(options.position);
      const contentBounds = content.getBoundingClientRect();
      const scrollerBounds = exactScroller.getBoundingClientRect();
      const rendererWindow = content.ownerDocument.defaultView;
      return {
        blockContainsPosition: block.from <= options.position && block.to >= options.position,
        code: view.state.doc.toString(),
        contentIsExact: view.contentDOM === content,
        lineBounds: {
          left: contentBounds.left,
          top: view.documentTop + block.top * view.scaleY,
          width: contentBounds.width,
          height: block.height * view.scaleY
        },
        scaleY: view.scaleY,
        scrollerBounds: {
          left: scrollerBounds.left,
          top: scrollerBounds.top,
          width: scrollerBounds.width,
          height: scrollerBounds.height
        },
        scrollerIsExact: view.scrollDOM === exactScroller,
        scrollTop: exactScroller.scrollTop,
        scrollHeight: exactScroller.scrollHeight,
        clientHeight: exactScroller.clientHeight,
        rendererViewport: rendererWindow
          ? { width: rendererWindow.innerWidth, height: rendererWindow.innerHeight }
          : undefined
      };
    },
    { exactScroller: target.scroller, position }
  );
  const { code: initialCode, ...initialGeometry } = rawInitialExposure;
  const initialExposure = {
    ...initialGeometry,
    codeReceipt: codePreviewDocumentReceipt(initialCode)
  };
  const initialActual = JSON.stringify(initialExposure);
  assertExactCodePreviewReceipt(
    initialExposure.codeReceipt,
    target.codeReceipt,
    "The exact Code Preview document before line materialization"
  );
  assert.equal(
    initialExposure.contentIsExact && initialExposure.scrollerIsExact && initialExposure.blockContainsPosition,
    true,
    `The exact Code Preview must bind its selected line block to the pinned content and scroller: ${initialActual}.`
  );
  assert.equal(
    initialExposure.scaleY,
    1,
    `The exact Code Preview requires unscaled vertical geometry: ${initialActual}.`
  );
  let initialPlan: ReturnType<typeof computeCodePreviewScrollPlan>;
  try {
    initialPlan = computeCodePreviewScrollPlan({
      lineBounds: initialExposure.lineBounds,
      scrollerBounds: initialExposure.scrollerBounds,
      scrollTop: initialExposure.scrollTop,
      scrollHeight: initialExposure.scrollHeight,
      clientHeight: initialExposure.clientHeight,
      rendererViewport: initialExposure.rendererViewport,
      tolerance: 1
    });
  } catch (error) {
    throw new Error(`The exact Code Preview line-block geometry is invalid: ${initialActual}.`, { cause: error });
  }
  const initialScrollTop = await target.scroller.evaluate((element, scrollTop) => {
    const exactScroller = element as unknown as { scrollTop: number };
    exactScroller.scrollTop = scrollTop;
    return exactScroller.scrollTop;
  }, initialPlan.targetScrollTop);
  assert.ok(
    Number.isFinite(initialScrollTop) && Math.abs(initialScrollTop - initialPlan.targetScrollTop) <= 1,
    `The exact Code Preview scroller did not accept its initial line-block target: ${JSON.stringify({ initialExposure, initialPlan, initialScrollTop })}.`
  );
  await waitForExactCodePreviewAnimationFrames(target.scroller);
  const refreshedIdentity = await readExactCodePreviewIdentity(target.preview, target.scroller);
  assertExactCodePreviewIdentity(refreshedIdentity, target.codeReceipt);

  const rawLine = await target.preview.evaluateHandle(
    (element, options) => {
      type LineElement = { readonly textContent: string | null };
      const content = element as unknown as { querySelectorAll(selector: string): ArrayLike<LineElement> };
      const matches = Array.from(content.querySelectorAll(".cm-line")).filter((line) => {
        const lineText = line.textContent ?? "";
        return options.match === "exact-logical-line"
          ? lineText === options.expectedText
          : lineText.includes(options.expectedText);
      });
      if (options.match === "exact-logical-line") return matches.length === 1 ? matches[0] : null;
      return options.occurrence === "first" ? (matches[0] ?? null) : (matches[matches.length - 1] ?? null);
    },
    { expectedText, occurrence, match }
  );
  const line = rawLine.asElement() as ExactCodePreviewHandle | null;
  if (!line) {
    await rawLine.dispose();
    assert.fail(
      match === "exact-logical-line"
        ? `The exact Code Preview did not render one exact logical line ${expectedTextReceipt}.`
        : `The exact Code Preview did not render a line containing text ${expectedTextReceipt}.`
    );
  }
  return line;
}

async function measureExactCodePreviewExposure(
  target: ExactCodePreviewTarget,
  line: ExactCodePreviewHandle,
  expectedText: string,
  match: ExactCodePreviewLineMatch = "contains"
): Promise<ExactCodePreviewExposure> {
  const raw = await line.evaluate(
    (element, options) => {
      type Rectangle = { left: number; top: number; width: number; height: number };
      type LineElement = {
        readonly isConnected: boolean;
        readonly ownerDocument: {
          readonly defaultView: null | { readonly innerWidth: number; readonly innerHeight: number };
        };
        readonly innerText?: string;
        readonly textContent: string | null;
        getBoundingClientRect(): Rectangle;
      };
      type ScrollerElement = {
        readonly ownerDocument: unknown;
        readonly scrollTop: number;
        readonly scrollHeight: number;
        readonly clientHeight: number;
        contains(candidate: unknown): boolean;
        getBoundingClientRect(): Rectangle;
      };
      const lineElement = element as unknown as LineElement;
      const scrollerElement = options.exactScroller as unknown as ScrollerElement;
      const lineBounds = lineElement.getBoundingClientRect();
      const scrollerBounds = scrollerElement.getBoundingClientRect();
      const rendererWindow = lineElement.ownerDocument.defaultView;
      const lineText =
        options.match === "exact-logical-line"
          ? (lineElement.textContent ?? "")
          : (lineElement.innerText ?? lineElement.textContent ?? "");
      return {
        lineBounds: {
          left: lineBounds.left,
          top: lineBounds.top,
          width: lineBounds.width,
          height: lineBounds.height
        },
        lineConnected: lineElement.isConnected,
        lineText,
        lineMatchesExpectedText:
          options.match === "exact-logical-line"
            ? lineText === options.expectedText
            : lineText.includes(options.expectedText),
        sameDocument: lineElement.ownerDocument === scrollerElement.ownerDocument,
        scrollerBounds: {
          left: scrollerBounds.left,
          top: scrollerBounds.top,
          width: scrollerBounds.width,
          height: scrollerBounds.height
        },
        scrollerContainsLine: scrollerElement.contains(lineElement),
        scrollTop: scrollerElement.scrollTop,
        scrollHeight: scrollerElement.scrollHeight,
        clientHeight: scrollerElement.clientHeight,
        rendererViewport: rendererWindow
          ? { width: rendererWindow.innerWidth, height: rendererWindow.innerHeight }
          : undefined
      };
    },
    { exactScroller: target.scroller, expectedText, match }
  );
  const { lineText, ...exposure } = raw;
  return { ...exposure, lineTextReceipt: codePreviewDocumentReceipt(lineText) };
}

async function settleExactCodePreviewLine(
  target: ExactCodePreviewTarget,
  expectedText: string,
  occurrence: "first" | "last",
  match: ExactCodePreviewLineMatch = "contains"
): Promise<ExactCodePreviewHandle> {
  const line = await prepareExactCodePreviewLine(target, expectedText, occurrence, match);
  let transferred = false;
  let failure: Readonly<{ error: unknown }> | undefined;
  const maximumAttempts = 8;
  const geometryTolerance = 1;
  let previousVisibleExposure: ExactCodePreviewExposure | undefined;
  let lastExposure: unknown;
  try {
    for (let attempt = 1; attempt <= maximumAttempts; attempt += 1) {
      const identity = await readExactCodePreviewIdentity(target.preview, target.scroller);
      assertExactCodePreviewIdentity(identity, target.codeReceipt);
      const exposure = await measureExactCodePreviewExposure(target, line, expectedText, match);
      lastExposure = { attempt, ...exposure };
      assert.equal(
        exposure.lineConnected && exposure.sameDocument && exposure.scrollerContainsLine,
        true,
        `The generated-code line must remain an exact descendant of its scroller: ${JSON.stringify(lastExposure)}.`
      );
      assert.ok(
        exposure.lineMatchesExpectedText,
        `The generated-code line must retain its ${match === "exact-logical-line" ? "exact logical-line identity" : "expected text"} ${codePreviewReceiptDiagnostic(codePreviewDocumentReceipt(expectedText))}: ${JSON.stringify(lastExposure)}.`
      );
      let plan: ReturnType<typeof computeCodePreviewScrollPlan>;
      try {
        plan = computeCodePreviewScrollPlan({
          lineBounds: exposure.lineBounds,
          scrollerBounds: exposure.scrollerBounds,
          scrollTop: exposure.scrollTop,
          scrollHeight: exposure.scrollHeight,
          clientHeight: exposure.clientHeight,
          rendererViewport: exposure.rendererViewport,
          tolerance: geometryTolerance
        });
      } catch (error) {
        throw new Error(`The exact Code Preview exposure geometry is invalid: ${JSON.stringify(lastExposure)}.`, {
          cause: error
        });
      }
      const geometrySettled =
        plan.currentFullyVisible &&
        previousVisibleExposure !== undefined &&
        Math.abs(previousVisibleExposure.lineBounds.top - exposure.lineBounds.top) <= geometryTolerance &&
        Math.abs(previousVisibleExposure.lineBounds.height - exposure.lineBounds.height) <= geometryTolerance &&
        Math.abs(previousVisibleExposure.scrollerBounds.top - exposure.scrollerBounds.top) <= geometryTolerance &&
        Math.abs(previousVisibleExposure.scrollerBounds.height - exposure.scrollerBounds.height) <= geometryTolerance &&
        Math.abs(previousVisibleExposure.scrollTop - exposure.scrollTop) <= geometryTolerance;
      if (geometrySettled) {
        transferred = true;
        return line;
      }
      previousVisibleExposure = plan.currentFullyVisible ? exposure : undefined;
      const appliedScrollTop = await target.scroller.evaluate((element, scrollTop) => {
        const exactScroller = element as unknown as { scrollTop: number };
        exactScroller.scrollTop = scrollTop;
        return exactScroller.scrollTop;
      }, plan.targetScrollTop);
      lastExposure = { attempt, appliedScrollTop, plan, ...exposure };
      assert.ok(
        Number.isFinite(appliedScrollTop) && Math.abs(appliedScrollTop - plan.targetScrollTop) <= geometryTolerance,
        `The exact Code Preview scroller did not accept its clamped center target: ${JSON.stringify(lastExposure)}.`
      );
      await waitForExactCodePreviewAnimationFrames(target.scroller);
    }
    throw new Error(
      `The generated-code line did not settle fully visible in its exact CodeMirror scroller after ${maximumAttempts} attempts: ${JSON.stringify(lastExposure)}.`
    );
  } catch (error) {
    failure = { error };
    throw error;
  } finally {
    if (!transferred) {
      await releaseExactCodePreviewHandlesAfterFailure(
        [line],
        failure,
        "Revealing the exact Code Preview line and releasing its handle both failed."
      );
    }
  }
}

export async function revealCodePreviewOperationLine(
  codePreview: Locator | ExactCodePreviewTarget,
  operationText: string,
  resultText: string
): Promise<void> {
  const initial = await exactCodePreviewTarget(codePreview);
  await runExactCodePreviewGenerations(initial, "Revealing the generated-code operation", async (target) => {
    let operationLine: ExactCodePreviewHandle | undefined;
    let resultLine: ExactCodePreviewHandle | undefined;
    let failure: Readonly<{ error: unknown }> | undefined;
    try {
      resultLine = await settleExactCodePreviewLine(target, resultText, "last");
      operationLine = await prepareExactCodePreviewLine(target, operationText, "last");
      await waitForExactCodePreviewAnimationFrames(target.scroller);
      const identity = await readExactCodePreviewIdentity(target.preview, target.scroller);
      assertExactCodePreviewIdentity(identity, target.codeReceipt);
      const [operationExposure, resultExposure] = await Promise.all([
        measureExactCodePreviewExposure(target, operationLine, operationText),
        measureExactCodePreviewExposure(target, resultLine, resultText)
      ]);
      for (const [subject, text, exposure] of [
        ["operation", operationText, operationExposure],
        ["result", resultText, resultExposure]
      ] as const) {
        const actual = JSON.stringify(exposure);
        assert.equal(
          exposure.lineConnected && exposure.sameDocument && exposure.scrollerContainsLine,
          true,
          `The generated-code ${subject} line must remain in the exact scroller: ${actual}.`
        );
        assert.ok(
          exposure.lineMatchesExpectedText,
          `The generated-code ${subject} line must retain text ${codePreviewReceiptDiagnostic(codePreviewDocumentReceipt(text))}: ${actual}.`
        );
        const plan = computeCodePreviewScrollPlan({
          lineBounds: exposure.lineBounds,
          scrollerBounds: exposure.scrollerBounds,
          scrollTop: exposure.scrollTop,
          scrollHeight: exposure.scrollHeight,
          clientHeight: exposure.clientHeight,
          rendererViewport: exposure.rendererViewport,
          tolerance: 1
        });
        assert.equal(
          plan.currentFullyVisible,
          true,
          `The generated-code ${subject} line must be fully visible in the exact Code Preview scroller: ${actual}.`
        );
      }
    } catch (error) {
      failure = { error };
      throw error;
    } finally {
      await releaseExactCodePreviewHandlesAfterFailure(
        [operationLine, resultLine],
        failure,
        "Revealing the generated-code operation and releasing its line handles both failed."
      );
    }
  });
}

export async function revealCodePreviewText(
  codePreview: Locator | ExactCodePreviewTarget,
  expectedText: string
): Promise<string> {
  const initial = await exactCodePreviewTarget(codePreview);
  return runExactCodePreviewGenerations(initial, "Revealing generated-code text", async (target) => {
    let line: ExactCodePreviewHandle | undefined;
    let failure: Readonly<{ error: unknown }> | undefined;
    try {
      line = await settleExactCodePreviewLine(target, expectedText, "first");
      return target.code;
    } catch (error) {
      failure = { error };
      throw error;
    } finally {
      await releaseExactCodePreviewHandlesAfterFailure(
        [line],
        failure,
        "Revealing generated-code text and releasing its line handle both failed."
      );
    }
  });
}

export async function revealCodePreviewExactLogicalLine(
  codePreview: Locator | ExactCodePreviewTarget,
  expectedLine: string
): Promise<string> {
  const initial = await exactCodePreviewTarget(codePreview);
  return runExactCodePreviewGenerations(initial, "Revealing an exact generated-code logical line", async (target) => {
    let line: ExactCodePreviewHandle | undefined;
    let failure: Readonly<{ error: unknown }> | undefined;
    try {
      line = await settleExactCodePreviewLine(target, expectedLine, "first", "exact-logical-line");
      return target.code;
    } catch (error) {
      failure = { error };
      throw error;
    } finally {
      await releaseExactCodePreviewHandlesAfterFailure(
        [line],
        failure,
        "Revealing an exact generated-code logical line and releasing its line handle both failed."
      );
    }
  });
}

async function exactCodePreviewTarget(codePreview: Locator | ExactCodePreviewTarget): Promise<ExactCodePreviewTarget> {
  return "preview" in codePreview && "scroller" in codePreview && "code" in codePreview
    ? codePreview
    : pinExactCodePreview(codePreview);
}

async function releaseExactCodePreview(target: {
  readonly preview: ExactCodePreviewHandle;
  readonly scroller: ExactCodePreviewHandle | undefined;
}): Promise<void> {
  await releaseExactCodePreviewHandles([target.preview, target.scroller]);
}

async function releaseExactCodePreviewHandles(
  handles: readonly (DisposableCodePreviewHandle | undefined)[]
): Promise<void> {
  const results = await Promise.allSettled(
    handles.filter((handle) => handle !== undefined).map((handle) => handle.dispose())
  );
  const failures = results.flatMap((result) => (result.status === "rejected" ? [result.reason] : []));
  if (failures.length > 0) throw new AggregateError(failures, "Releasing the exact Code Preview handles failed.");
}

export async function releaseExactCodePreviewHandlesAfterFailure(
  handles: readonly (DisposableCodePreviewHandle | undefined)[],
  failure: Readonly<{ error: unknown }> | undefined,
  aggregateMessage: string
): Promise<void> {
  try {
    await releaseExactCodePreviewHandles(handles);
  } catch (cleanupError) {
    if (failure) throw new AggregateError([failure.error, cleanupError], aggregateMessage);
    throw cleanupError;
  }
}

export async function ensureCodePreviewHeight(
  workbench: Page,
  codePreview: Locator,
  minimumHeight: number
): Promise<ExactCodePreviewTarget> {
  assert.ok(
    Number.isFinite(minimumHeight) && minimumHeight >= 120,
    "The generated-code preview minimum height must be a useful finite CSS-pixel value."
  );
  const expectedCode = await codePreview.evaluate((element) => {
    const content = element as unknown as { cmTile?: { view?: { state: { doc: { toString(): string } } } } };
    return content.cmTile?.view?.state.doc.toString();
  });
  assert.ok(
    typeof expectedCode === "string",
    "The generated-code preview must expose its complete document before sizing."
  );
  const expectedCodeReceipt = codePreviewDocumentReceipt(expectedCode);
  const label = await codePreview.getAttribute("aria-label");
  assert.ok(
    label === "Editable generated R code preview" || label === "Editable generated Python code preview",
    "The generated-code preview must retain one exact supported language label before sizing."
  );
  const language = label === "Editable generated R code preview" ? "R" : "Python";
  let lastIdentity: ExactCodePreviewIdentity | undefined;
  const commands = new Set(await vscode.commands.getCommands(true));
  assert.ok(
    commands.has("openWrangler.codePreview.focus") &&
      commands.has("workbench.action.focusPanel") &&
      commands.has("workbench.action.increaseViewSize"),
    "The workbench must expose its exact Code Preview focus and resize commands."
  );
  const maximumResizeAttempts = 24;
  const deadline = Date.now() + WORKBENCH_PLAYWRIGHT_TIMEOUT_MS;
  for (let attempt = 0; attempt <= maximumResizeAttempts; attempt += 1) {
    // Workbench focus/resize commands may replace the iframe generation. No
    // exact DOM handle survives either boundary: focus the panel first, focus
    // Code Preview last, then acquire the current generation from live frames.
    await vscode.commands.executeCommand("workbench.action.focusPanel");
    await vscode.commands.executeCommand("openWrangler.codePreview.focus");
    const target = await acquireCurrentExactCodePreviewGeneration(workbench, language, expectedCodeReceipt, deadline);
    let transferred = false;
    let failure: Readonly<{ error: unknown }> | undefined;
    try {
      await waitForExactCodePreviewAnimationFrames(target.scroller);
      lastIdentity = await readExactCodePreviewIdentity(target.preview, target.scroller);
      assertExactCodePreviewIdentity(lastIdentity, target.codeReceipt);
      const usableHeight = exactCodePreviewUsableScrollerHeight(lastIdentity, 1);
      if (usableHeight >= minimumHeight) {
        transferred = true;
        return target;
      }
    } catch (error) {
      failure = { error };
      throw error;
    } finally {
      if (!transferred) {
        await releaseExactCodePreviewHandlesAfterFailure(
          [target.preview, target.scroller],
          failure,
          "Sizing the exact Code Preview and releasing its current generation both failed."
        );
      }
    }
    if (attempt === maximumResizeAttempts || Date.now() >= deadline) break;
    await vscode.commands.executeCommand("workbench.action.increaseViewSize");
    await workbench.waitForTimeout(100);
  }
  throw new Error(
    `The exact Code Preview scroller must be at least ${minimumHeight} CSS pixels high within its renderer viewport: ${JSON.stringify(lastIdentity)}.`
  );
}
