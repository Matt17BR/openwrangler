import * as assert from "node:assert/strict";
import type { Frame, Locator, Page } from "playwright-core";
import type * as vscode from "vscode";
import type { FilterModel } from "../../shared/protocol";
import type { TestApi } from "./extensionHostTestApi";

const FIXTURE_ROWS = 2_005;
const FILTERED_ROWS = 1_003;
const NARROW_VIEWPORT = Object.freeze({ width: 640, height: 800 });
const GRID_COPY_SENTINEL = "open-wrangler-grid-copy-sentinel";
const GRID_SHORTCUT_SENTINEL = "open-wrangler-grid-shortcut-sentinel";
const MAXIMUM_CLIPBOARD_BYTES = 4 * 1024 * 1024;

interface MonotonicDeadline {
  readonly expiresAt: number;
}

export interface PackagedGridColumnCopySurface {
  readonly restoreViewport: () => Promise<void>;
  activateHeaderCopy(
    column: string,
    retainReceipt: (receipt: PackagedGridColumnCopyWriteReceipt) => void
  ): Promise<PackagedGridColumnCopyWriteReceipt>;
  assertHeaderFocused(column: string): Promise<void>;
  pressHeaderCopyShortcut(
    column: string,
    platform: NodeJS.Platform,
    retainReceipt: (receipt: PackagedGridColumnCopyWriteReceipt) => void
  ): Promise<PackagedGridColumnCopyWriteReceipt>;
  waitForColumnValues(columnPosition: number, expected: readonly string[]): Promise<void>;
  waitForHeaderCopyState(column: string, state: "copying" | "ready", rowCount: number): Promise<void>;
}

export interface PackagedGridColumnCopyWriteReceipt {
  readonly waitForSettlement: () => Promise<void>;
}

export interface PackagedGridColumnCopyJourneyDependencies {
  readonly closeAllEditors: () => Promise<void>;
  readonly connectToEditorWorkbench: () => Promise<Page>;
  readonly createSurface: (
    workbench: Page,
    testing: TestApi,
    sessionId: string
  ) => Promise<PackagedGridColumnCopySurface>;
  readonly openFixture: (fixture: vscode.Uri) => Promise<void>;
  readonly readClipboardText: () => Promise<string>;
  readonly readFixture: (fixture: vscode.Uri) => Promise<Uint8Array>;
  readonly recordProgress: (checkpoint: string) => void;
  readonly waitFor: (
    predicate: () => boolean,
    timeoutMs: number,
    expectation: string,
    diagnostics?: () => string
  ) => Promise<void>;
  readonly writeClipboardText: (text: string) => Promise<void>;
  readonly sessionTimeoutMs: number;
}

export function createPackagedGridColumnCopyJourney(dependencies: PackagedGridColumnCopyJourneyDependencies) {
  const {
    closeAllEditors,
    connectToEditorWorkbench,
    createSurface,
    openFixture,
    readClipboardText,
    readFixture,
    recordProgress,
    sessionTimeoutMs,
    waitFor,
    writeClipboardText
  } = dependencies;

  return async function exercisePackagedGridColumnCopy(testing: TestApi, fixture: vscode.Uri): Promise<void> {
    assert.ok(
      process.env.OPEN_WRANGLER_EDITOR_CDP_PORT,
      "The packaged whole-column journey requires the isolated native editor workbench."
    );
    assert.equal(testing.diagnostics().sessionCount, 0, "The whole-column journey must start without another session.");
    assert.equal(testing.runtimeRunning(), false, "The whole-column journey must start without a live runtime.");

    const sourceBytes = await readFixture(fixture);
    let lastTestOwnedClipboard: string | undefined;
    let surface: PackagedGridColumnCopySurface | undefined;
    let failurePresent = false;
    let failure: unknown;
    try {
      await readBoundedClipboardText(readClipboardText, "initial", createMonotonicDeadline(sessionTimeoutMs));
      recordProgress("grid-column-copy:open");
      await openFixture(fixture);
      await waitFor(
        () => testing.activeSession()?.metadata.source.uri === fixture.toString(),
        sessionTimeoutMs,
        "the packaged whole-column fixture to open",
        () => JSON.stringify(testing.diagnostics())
      );
      const active = testing.activeSession();
      assert.ok(active, "The packaged whole-column journey requires one active dataframe session.");
      assert.deepEqual(active.metadata.shape, { rows: FIXTURE_ROWS, columns: 4 });
      assert.equal(
        await testing.ensurePanelSynchronized(active.sessionId, sessionTimeoutMs),
        true,
        "The packaged whole-column journey requires a synchronized production webview."
      );

      const filterModel = packagedGridColumnCopyFilterModel();
      const filteredPage = await testing.request({
        kind: "getPage",
        viewRequestId: "packaged-grid-column-copy-filter",
        sessionId: active.sessionId,
        revision: active.metadata.revision,
        offset: 0,
        limit: 2,
        columnOffset: 0,
        columnLimit: 4,
        filterModel
      });
      assert.equal(filteredPage.kind, "page", "The packaged whole-column filter must return one real page.");
      if (filteredPage.kind !== "page") throw new Error("The packaged whole-column filter did not return a page.");
      assert.equal(filteredPage.page.totalRows, FILTERED_ROWS);
      const viewState = {
        ...active.viewState,
        selectedColumnId: active.metadata.schema.find((column) => column.name === "city")?.id
      };
      assert.ok(viewState.selectedColumnId, "The packaged fixture must expose the city column.");
      await testing.updateViewState(active.sessionId, viewState);
      assert.equal(await testing.synchronizePanel(active.sessionId), true);
      await waitFor(
        () => {
          const current = testing.activeSession();
          return (
            current?.sessionId === active.sessionId &&
            current.metadata.filteredShape.rows === FILTERED_ROWS &&
            JSON.stringify(current.metadata.filterModel) === JSON.stringify(filterModel)
          );
        },
        sessionTimeoutMs,
        "the exact filtered and sorted view to become authoritative",
        () => JSON.stringify(testing.activeSession())
      );

      const workbench = await connectToEditorWorkbench();
      const activeSurface = await createSurface(workbench, testing, active.sessionId);
      surface = activeSurface;
      const city = active.metadata.schema.find((column) => column.name === "city");
      const sales = active.metadata.schema.find((column) => column.name === "sales");
      assert.ok(city && sales, "The packaged fixture must expose city and sales columns.");
      await activeSurface.waitForColumnValues(sales.position, ["2004", "2002"]);

      recordProgress("grid-column-copy:header-action");
      await writeOwnedClipboardText(writeClipboardText, GRID_COPY_SENTINEL, createMonotonicDeadline(sessionTimeoutMs));
      lastTestOwnedClipboard = GRID_COPY_SENTINEL;
      const cityText = await dispatchAndRetainClipboardWriteSettlement(
        (retainReceipt) => activeSurface.activateHeaderCopy("city", retainReceipt),
        async () => {
          await activeSurface.waitForHeaderCopyState("city", "copying", FILTERED_ROWS);
          const expected = packagedGridColumnCopyExpectedCityText();
          await waitForClipboardText(
            readClipboardText,
            expected,
            createMonotonicDeadline(sessionTimeoutMs),
            "the visible header action to copy the exact filtered and sorted city column"
          );
          lastTestOwnedClipboard = expected;
          await activeSurface.waitForHeaderCopyState("city", "ready", FILTERED_ROWS);
          return expected;
        }
      );
      assert.equal(cityText.startsWith("city\n"), false, "The explicit column contract must exclude its header.");

      recordProgress("grid-column-copy:first-shortcut");
      await writeOwnedClipboardText(
        writeClipboardText,
        GRID_SHORTCUT_SENTINEL,
        createMonotonicDeadline(sessionTimeoutMs)
      );
      lastTestOwnedClipboard = GRID_SHORTCUT_SENTINEL;
      const salesText = await dispatchAndRetainClipboardWriteSettlement(
        (retainReceipt) => activeSurface.pressHeaderCopyShortcut("sales", process.platform, retainReceipt),
        async () => {
          const expected = packagedGridColumnCopyExpectedSalesText();
          await waitForClipboardText(
            readClipboardText,
            expected,
            createMonotonicDeadline(sessionTimeoutMs),
            "one first platform shortcut to prepare and copy the exact filtered and sorted sales column"
          );
          lastTestOwnedClipboard = expected;
          await activeSurface.waitForHeaderCopyState("sales", "ready", FILTERED_ROWS);
          await activeSurface.assertHeaderFocused("sales");
          return expected;
        }
      );
      assert.equal(salesText.startsWith("sales\n"), false, "The shortcut contract must also exclude its header.");
      assert.deepEqual(
        await readFixture(fixture),
        sourceBytes,
        "Whole-column copy must not modify the source fixture."
      );
      recordProgress("grid-column-copy:complete");
    } catch (error) {
      failurePresent = true;
      failure = error;
    }

    const cleanupFailures: unknown[] = [];
    const cleanupDeadline = createMonotonicDeadline(sessionTimeoutMs);
    const closeEditors = settleBeforeDeadline(
      closeAllEditors,
      cleanupDeadline,
      "Timed out closing editors after the packaged whole-column journey."
    );
    const closeSession = settleBeforeDeadline(
      () =>
        waitFor(
          () => testing.diagnostics().sessionCount === 0 && !testing.runtimeRunning(),
          remainingDeadlineMs(cleanupDeadline),
          "the packaged whole-column session and runtime to close"
        ),
      cleanupDeadline,
      "Timed out waiting for the packaged whole-column session and runtime to close."
    );
    const restoreViewport = surface
      ? settleBeforeDeadline(
          surface.restoreViewport,
          cleanupDeadline,
          "Timed out restoring the packaged whole-column viewport."
        )
      : Promise.resolve();
    const cleanupSettlements = await Promise.allSettled([restoreViewport, closeEditors, closeSession]);
    for (const settlement of cleanupSettlements) {
      if (settlement.status === "rejected") cleanupFailures.push(settlement.reason);
    }
    if (lastTestOwnedClipboard !== undefined) {
      try {
        const currentClipboard = await readBoundedClipboardText(
          readClipboardText,
          "cleanup",
          createMonotonicDeadline(sessionTimeoutMs)
        );
        if (currentClipboard !== lastTestOwnedClipboard) {
          throw new Error(
            "Clipboard changed outside the packaged whole-column journey; the foreign value was preserved."
          );
        }
      } catch (error) {
        cleanupFailures.push(error);
      }
    }
    const failures = failurePresent ? [failure, ...cleanupFailures] : cleanupFailures;
    if (failures.length === 1) throw failures[0];
    if (failures.length > 1) {
      throw new AggregateError(failures, "The packaged whole-column journey and its cleanup both failed.");
    }
  };
}

export async function createPlaywrightGridColumnCopySurface(
  workbench: Page,
  frame: Frame
): Promise<PackagedGridColumnCopySurface> {
  const previousViewport = await workbench.evaluate(() => {
    const pageWindow = globalThis as unknown as { innerHeight: number; innerWidth: number };
    return { width: pageWindow.innerWidth, height: pageWindow.innerHeight };
  });
  await workbench.setViewportSize(NARROW_VIEWPORT);

  const header = (column: string): Locator => frame.locator(`th[data-column=${JSON.stringify(column)}]`).first();
  const copyAction = (column: string, name: RegExp): Locator => header(column).getByRole("button", { name }).first();
  return {
    restoreViewport: () => workbench.setViewportSize(previousViewport),
    activateHeaderCopy: async (column, retainReceipt) => {
      const action = copyAction(column, new RegExp(`^Copy column ${escapeRegExp(column)}; header excluded$`, "u"));
      await action.waitFor({ state: "visible", timeout: 10_000 });
      assert.equal(await action.isEnabled(), true, "The narrow header copy action must be enabled.");
      const previousGeneration = await readClipboardOperationGeneration(header(column));
      const receipt = createClipboardWriteReceipt(header(column), previousGeneration);
      const dispatchSettlement = action.click();
      retainReceipt(receipt);
      await dispatchSettlement;
      return receipt;
    },
    assertHeaderFocused: async (column) => {
      assert.equal(await header(column).evaluate((element) => element === element.ownerDocument.activeElement), true);
    },
    pressHeaderCopyShortcut: async (column, platform, retainReceipt) => {
      const target = header(column);
      await target.waitFor({ state: "visible", timeout: 10_000 });
      await target.focus();
      const previousGeneration = await readClipboardOperationGeneration(target);
      const receipt = createClipboardWriteReceipt(target, previousGeneration);
      const dispatchSettlement = target.press(platform === "darwin" ? "Meta+c" : "Control+c");
      retainReceipt(receipt);
      await dispatchSettlement;
      return receipt;
    },
    waitForColumnValues: async (columnPosition, expected) => {
      const cells = frame.locator(`td[data-grid-column=${JSON.stringify(String(columnPosition))}][data-grid-row]`);
      await cells.nth(expected.length - 1).waitFor({ state: "visible", timeout: 10_000 });
      assert.deepEqual(
        (await cells.allInnerTexts()).slice(0, expected.length).map((value) => value.trim()),
        expected
      );
    },
    waitForHeaderCopyState: async (column, state, rowCount) => {
      const name =
        state === "copying"
          ? new RegExp(`^Copying column ${escapeRegExp(column)}(?: when ready)?; header excluded$`, "u")
          : new RegExp(
              `^Copy column ${escapeRegExp(column)}; ${rowCount.toLocaleString()} values ready; header excluded$`,
              "u"
            );
      const action = copyAction(column, name);
      await action.waitFor({ state: "visible", timeout: 10_000 });
      assert.equal(await action.getAttribute("aria-busy"), state === "copying" ? "true" : "false");
    }
  };
}

async function readClipboardOperationGeneration(header: Locator): Promise<number> {
  const value = await header.getAttribute("data-clipboard-operation-generation");
  assert.match(value ?? "", /^(?:0|[1-9][0-9]*)$/u, "The header clipboard generation must be canonical.");
  const generation = Number(value);
  assert.ok(Number.isSafeInteger(generation), "The header clipboard generation must be a safe integer.");
  return generation;
}

function createClipboardWriteReceipt(header: Locator, previousGeneration: number): PackagedGridColumnCopyWriteReceipt {
  return {
    waitForSettlement: async () => {
      await header.waitFor({ state: "attached", timeout: 0 });
      await header.evaluate((element, previous) => {
        const readGeneration = (): number => Number(element.getAttribute("data-clipboard-operation-generation"));
        const settled = (): boolean =>
          Number.isSafeInteger(readGeneration()) &&
          readGeneration() > previous &&
          element.getAttribute("data-clipboard-operation-pending") === "false";
        if (settled()) return;
        return new Promise<void>((resolve, reject) => {
          const MutationObserverConstructor = element.ownerDocument.defaultView?.MutationObserver;
          if (!MutationObserverConstructor) {
            reject(new Error("The packaged whole-column clipboard action cannot observe its exact settlement."));
            return;
          }
          const observer = new MutationObserverConstructor(() => {
            const generation = readGeneration();
            if (!Number.isSafeInteger(generation) || generation <= previous) return;
            if (element.getAttribute("data-clipboard-operation-pending") !== "false") return;
            observer.disconnect();
            resolve();
          });
          observer.observe(element, {
            attributeFilter: ["data-clipboard-operation-generation", "data-clipboard-operation-pending"],
            attributes: true
          });
          if (!element.isConnected) {
            observer.disconnect();
            reject(new Error("The packaged whole-column clipboard action lost its exact header before settlement."));
          } else if (settled()) {
            observer.disconnect();
            resolve();
          }
        });
      }, previousGeneration);
    }
  };
}

export function packagedGridColumnCopyFixtureCsv(): string {
  const rows = ["row_id,city,sales,active"];
  for (let index = 0; index < FIXTURE_ROWS; index += 1) {
    rows.push(`${index},${index % 2 === 0 ? "München" : "Paris"},${index},true`);
  }
  return `${rows.join("\n")}\n`;
}

export function packagedGridColumnCopyFilterModel(): FilterModel {
  return {
    logic: "and",
    filters: [
      {
        column: "city",
        type: "string",
        logic: "and",
        predicates: [{ kind: "predicate", operator: "startsWith", value: "M" }]
      }
    ],
    sort: [{ column: "sales", direction: "desc", nulls: "last" }]
  };
}

export function packagedGridColumnCopyExpectedCityText(): string {
  return Array.from({ length: FILTERED_ROWS }, () => "München").join("\n");
}

export function packagedGridColumnCopyExpectedSalesText(): string {
  return Array.from({ length: FILTERED_ROWS }, (_, index) => String(2_004 - index * 2)).join("\n");
}

async function waitForClipboardText(
  readClipboardText: () => Promise<string>,
  expected: string,
  deadline: MonotonicDeadline,
  expectation: string
): Promise<void> {
  do {
    if ((await readBoundedClipboardText(readClipboardText, "poll", deadline)) === expected) return;
    await settleBeforeDeadline(
      () => new Promise<void>((resolve) => setTimeout(resolve, 50)),
      deadline,
      `Timed out waiting for ${expectation}.`
    );
  } while (remainingDeadlineMs(deadline) > 0);
  throw new Error(`Timed out waiting for ${expectation}.`);
}

async function readBoundedClipboardText(
  readClipboardText: () => Promise<string>,
  phase: "initial" | "poll" | "cleanup",
  deadline: MonotonicDeadline
): Promise<string> {
  let value: unknown;
  try {
    value = await settleBeforeDeadline(
      readClipboardText,
      deadline,
      `Packaged whole-column clipboard ${phase} read timed out.`
    );
  } catch {
    throw new Error(`Packaged whole-column clipboard ${phase} read failed.`);
  }
  if (
    typeof value !== "string" ||
    value.length > MAXIMUM_CLIPBOARD_BYTES ||
    Buffer.byteLength(value, "utf8") > MAXIMUM_CLIPBOARD_BYTES
  ) {
    throw new Error(`Packaged whole-column clipboard ${phase} read exceeded its fixed bound.`);
  }
  return value;
}

async function writeOwnedClipboardText(
  writeClipboardText: (text: string) => Promise<void>,
  text: string,
  deadline: MonotonicDeadline
): Promise<void> {
  const writeSettlement = Promise.resolve().then(() => writeClipboardText(text));
  void writeSettlement.catch(() => undefined);
  try {
    await settleBeforeDeadline(() => writeSettlement, deadline, "Packaged whole-column clipboard write timed out.");
  } catch {
    // Host clipboard writes are not cancellable. Keep the phase owned until the
    // write settles; the packaged runner's outer process deadline remains the
    // terminal bound when the host never settles.
    await writeSettlement.catch(() => undefined);
    throw new Error("Packaged whole-column clipboard write failed.");
  }
}

type FailureState = { readonly present: false } | { readonly present: true; readonly value: unknown };

function noFailure(): FailureState {
  return { present: false };
}

function capturedFailure(value: unknown): FailureState {
  return { present: true, value };
}

async function retainClipboardWriteSettlements<T>(
  receipts: readonly PackagedGridColumnCopyWriteReceipt[],
  operation: () => Promise<T>,
  priorFailures: readonly unknown[]
): Promise<T> {
  let result!: T;
  let operationFailure = noFailure();
  if (priorFailures.length === 0) {
    try {
      result = await operation();
    } catch (error) {
      operationFailure = capturedFailure(error);
    }
  }

  const settlementFailures = await Promise.all(
    receipts.map(async (receipt): Promise<FailureState> => {
      try {
        await receipt.waitForSettlement();
        return noFailure();
      } catch (error) {
        return capturedFailure(error);
      }
    })
  );
  const failures: unknown[] = [...priorFailures];
  if (operationFailure.present) failures.push(operationFailure.value);
  for (const failure of settlementFailures) {
    if (failure.present) failures.push(failure.value);
  }
  if (failures.length > 1) {
    throw new AggregateError(
      failures,
      "The packaged whole-column clipboard action and its settlement proof both failed."
    );
  }
  if (failures.length === 1) throw failures[0];
  return result;
}

export async function dispatchAndRetainClipboardWriteSettlement<T>(
  dispatch: (
    retainReceipt: (receipt: PackagedGridColumnCopyWriteReceipt) => void
  ) => Promise<PackagedGridColumnCopyWriteReceipt>,
  operation: () => Promise<T>
): Promise<T> {
  const receipts = new Set<PackagedGridColumnCopyWriteReceipt>();
  let callbackCount = 0;
  let callbackReceipt: PackagedGridColumnCopyWriteReceipt | undefined;
  let returnedReceipt: PackagedGridColumnCopyWriteReceipt | undefined;
  let dispatchFailure = noFailure();
  try {
    returnedReceipt = await dispatch((dispatchedReceipt) => {
      callbackCount += 1;
      callbackReceipt ??= dispatchedReceipt;
      receipts.add(dispatchedReceipt);
    });
    receipts.add(returnedReceipt);
  } catch (error) {
    dispatchFailure = capturedFailure(error);
  }

  let protocolFailure = noFailure();
  if (callbackCount > 1) {
    protocolFailure = capturedFailure(
      new Error("The packaged whole-column clipboard action reported multiple settlement receipts.")
    );
  } else if (callbackCount === 1 && returnedReceipt !== undefined && returnedReceipt !== callbackReceipt) {
    protocolFailure = capturedFailure(
      new Error("The packaged whole-column clipboard action returned a different settlement receipt.")
    );
  } else if (!dispatchFailure.present && receipts.size === 0) {
    protocolFailure = capturedFailure(
      new Error("The packaged whole-column clipboard action did not report a settlement receipt.")
    );
  }
  const priorFailures: unknown[] = [];
  if (dispatchFailure.present) priorFailures.push(dispatchFailure.value);
  if (protocolFailure.present) priorFailures.push(protocolFailure.value);
  if (receipts.size === 0) {
    if (priorFailures.length > 1) {
      throw new AggregateError(
        priorFailures,
        "The packaged whole-column clipboard action and its settlement proof both failed."
      );
    }
    throw priorFailures[0];
  }
  return retainClipboardWriteSettlements([...receipts], operation, priorFailures);
}

function createMonotonicDeadline(timeoutMs: number): MonotonicDeadline {
  return { expiresAt: performance.now() + Math.max(1, timeoutMs) };
}

function remainingDeadlineMs(deadline: MonotonicDeadline): number {
  return Math.max(0, Math.ceil(deadline.expiresAt - performance.now()));
}

async function settleBeforeDeadline<T>(
  operation: () => Promise<T>,
  deadline: MonotonicDeadline,
  timeoutMessage: string
): Promise<T> {
  const remainingMs = remainingDeadlineMs(deadline);
  if (remainingMs === 0) throw new Error(timeoutMessage);
  const operationSettlement = Promise.resolve().then(operation);
  void operationSettlement.catch(() => undefined);
  let timeout: NodeJS.Timeout | undefined;
  const timeoutSettlement = new Promise<never>((_resolve, reject) => {
    timeout = setTimeout(() => reject(new Error(timeoutMessage)), remainingMs);
  });
  try {
    return await Promise.race([operationSettlement, timeoutSettlement]);
  } finally {
    if (timeout !== undefined) clearTimeout(timeout);
  }
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&");
}
