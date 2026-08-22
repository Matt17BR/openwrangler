import * as assert from "node:assert/strict";
import { Buffer } from "node:buffer";
import type { Frame } from "playwright-core";

export interface PackagedGridRangeCopyHostClipboard {
  readText(): Thenable<string>;
  writeText(value: string): Thenable<void>;
}

export interface PackagedGridRangeCopyJourneyOptions {
  readonly frame: Frame;
  readonly hostClipboard: PackagedGridRangeCopyHostClipboard;
  readonly platform: NodeJS.Platform;
  readonly recordProgress: (checkpoint: string) => void;
}

const expectedRangeText = "2400001\tBenelux\n2400002\tNordics";
const keyboardPendingClipboard = "open-wrangler-grid-range-copy-keyboard-pending";
const menuPendingClipboard = "open-wrangler-grid-range-copy-menu-pending";
const clipboardWaitMs = 10_000;
const maximumPriorClipboardBytes = 4 * 1024 * 1024;
export const packagedGridClipboardOperationTimeoutMs = 2_000;
const packagedGridClipboardSettlementPollMs = 25;
const packagedGridClipboardSettlementSelector = '[data-grid-clipboard-settlement-receipt="true"]';

type PackagedGridClipboardSettlementStatus = "idle" | "pending" | "success" | "failure";

export interface PackagedGridClipboardSettlementReceipt {
  readonly id: number;
  readonly mode: "none" | "cell" | "row" | "range";
  readonly status: PackagedGridClipboardSettlementStatus;
}

interface RawPackagedGridClipboardSettlementReceipt {
  readonly id: unknown;
  readonly mode: unknown;
  readonly status: unknown;
}

class PackagedGridClipboardOperationFailure extends Error {
  constructor() {
    super("The packaged grid range-copy clipboard operation did not complete safely.");
    this.name = "PackagedGridClipboardOperationFailure";
  }
}

export class PackagedGridRangeCopyFailure extends Error {
  readonly cleanupFailed: boolean;
  readonly clipboardInterference: boolean;
  readonly productFailed: boolean;

  constructor(productFailed: boolean, cleanupFailed: boolean, clipboardInterference = false) {
    super(
      `The packaged grid range-copy journey failed. Product stage: ${productFailed ? "failed" : "passed"}; cleanup stage: ${cleanupFailed ? "failed" : "passed"}; clipboard interference: ${clipboardInterference ? "detected" : "none"}; clipboard text retained: no.`
    );
    this.name = "PackagedGridRangeCopyFailure";
    this.productFailed = productFailed;
    this.cleanupFailed = cleanupFailed;
    this.clipboardInterference = clipboardInterference;
  }
}

export function packagedGridCopyShortcut(platform: NodeJS.Platform): "Meta+c" | "Control+c" {
  return platform === "darwin" ? "Meta+c" : "Control+c";
}

export function validatePackagedGridClipboardSettlementReceipt(
  value: RawPackagedGridClipboardSettlementReceipt
): PackagedGridClipboardSettlementReceipt {
  const id = typeof value.id === "string" && /^(?:0|[1-9]\d{0,15})$/u.test(value.id) ? Number(value.id) : NaN;
  if (
    !Number.isSafeInteger(id) ||
    id < 0 ||
    (value.mode !== "none" && value.mode !== "cell" && value.mode !== "row" && value.mode !== "range") ||
    (value.status !== "idle" && value.status !== "pending" && value.status !== "success" && value.status !== "failure")
  ) {
    throw new PackagedGridClipboardOperationFailure();
  }
  return { id, mode: value.mode, status: value.status };
}

export async function waitForFreshPackagedGridRangeCopySettlement(
  readReceipt: () => Thenable<RawPackagedGridClipboardSettlementReceipt>,
  priorReceiptId: number
): Promise<number> {
  let actionReceiptId: number | undefined;
  for (;;) {
    let receipt: PackagedGridClipboardSettlementReceipt | undefined;
    try {
      receipt = validatePackagedGridClipboardSettlementReceipt(await readReceipt());
    } catch {
      // Once the product action has started, an unreadable receipt is not proof that its noncancelable write stopped.
    }
    if (receipt && actionReceiptId === undefined && receipt.id > priorReceiptId) {
      actionReceiptId = receipt.id;
    }
    if (receipt && receipt.id === actionReceiptId && receipt.mode === "range") {
      if (receipt.status === "success") return receipt.id;
      if (receipt.status === "failure") throw new PackagedGridClipboardOperationFailure();
    }
    await new Promise<void>((resolve) => setTimeout(resolve, packagedGridClipboardSettlementPollMs));
  }
}

export async function waitForPackagedGridClipboardActionAvailability(
  readReceipt: () => Thenable<RawPackagedGridClipboardSettlementReceipt>
): Promise<number> {
  let pendingReceiptId: number | undefined;
  for (;;) {
    let receipt: PackagedGridClipboardSettlementReceipt | undefined;
    try {
      receipt = validatePackagedGridClipboardSettlementReceipt(await readReceipt());
    } catch {
      if (pendingReceiptId === undefined) throw new PackagedGridClipboardOperationFailure();
    }
    if (receipt && pendingReceiptId === undefined) {
      if (receipt.status !== "pending") return receipt.id;
      pendingReceiptId = receipt.id;
    } else if (receipt && receipt.id === pendingReceiptId && receipt.status !== "pending") {
      return receipt.id;
    }
    await new Promise<void>((resolve) => setTimeout(resolve, packagedGridClipboardSettlementPollMs));
  }
}

export async function runPackagedGridClipboardAction(
  readReceipt: () => Thenable<RawPackagedGridClipboardSettlementReceipt>,
  action: () => Thenable<void>
): Promise<number> {
  const priorReceiptId = await waitForPackagedGridClipboardActionAvailability(readReceipt);
  await action();
  return waitForFreshPackagedGridRangeCopySettlement(readReceipt, priorReceiptId);
}

export async function runPackagedGridRangeCopyLifecycle(
  exercise: () => Promise<void>,
  cleanup: () => Promise<void>
): Promise<void> {
  let productFailed = false;
  let cleanupFailed = false;
  const clipboardInterference = false;
  try {
    try {
      await exercise();
    } catch {
      productFailed = true;
    }
  } finally {
    try {
      await cleanup();
    } catch {
      cleanupFailed = true;
    }
  }

  if (productFailed || cleanupFailed) {
    throw new PackagedGridRangeCopyFailure(productFailed, cleanupFailed, clipboardInterference);
  }
}

export function validatePackagedGridClipboardText(value: unknown): string {
  if (
    typeof value !== "string" ||
    value.length > maximumPriorClipboardBytes ||
    Buffer.byteLength(value, "utf8") > maximumPriorClipboardBytes
  ) {
    throw new Error("The host clipboard value is invalid or exceeds the 4 MiB limit.");
  }
  return value;
}

function normalizeClipboardText(value: string): string {
  return value.replaceAll("\r\n", "\n");
}

export async function waitForPackagedGridClipboard(
  hostClipboard: PackagedGridRangeCopyHostClipboard,
  expected: string
): Promise<void> {
  try {
    const normalizedExpected = normalizeClipboardText(validatePackagedGridClipboardText(expected));
    const deadline = Date.now() + clipboardWaitMs;
    do {
      const remainingMs = deadline - Date.now();
      if (remainingMs <= 0) break;
      const observed = await readPackagedGridClipboard(
        hostClipboard,
        Math.min(packagedGridClipboardOperationTimeoutMs, remainingMs)
      );
      if (normalizeClipboardText(observed) === normalizedExpected) return;
      await new Promise<void>((resolve) => setTimeout(resolve, 25));
    } while (Date.now() < deadline);
  } catch {
    throw new PackagedGridRangeCopyFailure(true, false);
  }
  throw new PackagedGridRangeCopyFailure(true, false);
}

export async function exercisePackagedGridRangeCopyJourney({
  frame,
  hostClipboard,
  platform,
  recordProgress
}: PackagedGridRangeCopyJourneyOptions): Promise<void> {
  const start = frame.locator('td[data-grid-row="0"][data-grid-column="0"]').first();
  const endpoint = frame.locator('td[data-grid-row="1"][data-grid-column="1"]').first();
  await start.waitFor({ state: "visible", timeout: 10_000 });
  await endpoint.waitFor({ state: "visible", timeout: 10_000 });
  assert.equal((await start.innerText()).trim(), "2400001");
  assert.equal((await endpoint.innerText()).trim(), "Nordics");

  const startBounds = await start.boundingBox();
  const endpointBounds = await endpoint.boundingBox();
  assert.ok(startBounds && endpointBounds, "The packaged grid range must expose two visible pointer targets.");
  recordProgress("platform-smoke:grid-range-copy:pointer");
  const mouse = frame.page().mouse;
  await mouse.move(startBounds.x + startBounds.width / 2, startBounds.y + startBounds.height / 2);
  await mouse.down();
  await mouse.move(endpointBounds.x + endpointBounds.width / 2, endpointBounds.y + endpointBounds.height / 2, {
    steps: 4
  });
  await mouse.up();

  await frame.getByText("2 rows by 2 columns selected", { exact: true }).waitFor({ timeout: 10_000 });
  await frame
    .locator('td[data-grid-row="1"][data-grid-column="1"]:focus')
    .waitFor({ state: "visible", timeout: 5_000 });
  assert.equal(await frame.locator('td[data-clipboard-selected="true"]').count(), 4);

  await runPackagedGridRangeCopyLifecycle(
    async () => {
      recordProgress(`platform-smoke:grid-range-copy:${platform === "darwin" ? "cmd" : "ctrl"}`);
      await writePackagedGridClipboard(hostClipboard, keyboardPendingClipboard);
      await runPackagedGridClipboardAction(
        () => readRawPackagedGridClipboardSettlementReceipt(frame),
        () => endpoint.press(packagedGridCopyShortcut(platform))
      );
      await waitForPackagedGridClipboard(hostClipboard, expectedRangeText);
      await frame.getByText("Copied 2 by 2 cell range.", { exact: true }).waitFor({ timeout: 5_000 });

      recordProgress("platform-smoke:grid-range-copy:context-menu");
      await writePackagedGridClipboard(hostClipboard, menuPendingClipboard);
      await start.click({ button: "right" });
      const menu = frame.getByRole("menu", { name: "Cell and range actions for order_id", exact: true });
      await menu.waitFor({ state: "visible", timeout: 5_000 });
      assert.equal(
        await menu.getByRole("menuitem").count(),
        3,
        "The mixed menu must expose two filters and one copy action."
      );
      const copySelection = menu.getByRole("menuitem", { name: "Copy selection", exact: true });
      await runPackagedGridClipboardAction(
        () => readRawPackagedGridClipboardSettlementReceipt(frame),
        () => copySelection.click()
      );
      await waitForPackagedGridClipboard(hostClipboard, expectedRangeText);
      await frame
        .locator('td[data-grid-row="1"][data-grid-column="1"]:focus')
        .waitFor({ state: "visible", timeout: 5_000 });
      assert.equal(await frame.locator('td[data-clipboard-selected="true"]').count(), 4);
    },
    async () => undefined
  );
}

async function readRawPackagedGridClipboardSettlementReceipt(
  frame: Frame
): Promise<RawPackagedGridClipboardSettlementReceipt> {
  return frame.locator(packagedGridClipboardSettlementSelector).evaluate(
    (element) => ({
      id: element.getAttribute("data-grid-clipboard-settlement-id"),
      mode: element.getAttribute("data-grid-clipboard-settlement-mode"),
      status: element.getAttribute("data-grid-clipboard-settlement-status")
    }),
    undefined,
    { timeout: 0 }
  );
}

async function readPackagedGridClipboard(
  hostClipboard: PackagedGridRangeCopyHostClipboard,
  timeoutMs = packagedGridClipboardOperationTimeoutMs
): Promise<string> {
  return validatePackagedGridClipboardText(
    await runPackagedGridClipboardOperation(() => hostClipboard.readText(), timeoutMs)
  );
}

export async function writePackagedGridClipboard(
  hostClipboard: PackagedGridRangeCopyHostClipboard,
  value: string,
  timeoutMs = packagedGridClipboardOperationTimeoutMs
): Promise<void> {
  const boundedValue = validatePackagedGridClipboardText(value);
  await runNoncancelablePackagedGridClipboardWrite(() => hostClipboard.writeText(boundedValue), timeoutMs);
}

function runNoncancelablePackagedGridClipboardWrite<T>(operation: () => Thenable<T>, timeoutMs: number): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    let softDeadlineReached = false;
    let settled = false;
    // Clipboard writes cannot be cancelled. The soft deadline classifies the operation, but the journey retains
    // ownership until settlement; a write that never settles is left to the outer editor/process deadline.
    const timeout = setTimeout(
      () => {
        softDeadlineReached = true;
      },
      Math.max(1, timeoutMs)
    );
    const finish = (complete: () => void): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timeout);
      complete();
    };

    let pending: PromiseLike<T>;
    try {
      pending = operation();
    } catch {
      finish(() => reject(new PackagedGridClipboardOperationFailure()));
      return;
    }
    void Promise.resolve(pending).then(
      (value) =>
        finish(() => {
          if (softDeadlineReached) {
            reject(new PackagedGridClipboardOperationFailure());
          } else {
            resolve(value);
          }
        }),
      () => finish(() => reject(new PackagedGridClipboardOperationFailure()))
    );
  });
}

function runPackagedGridClipboardOperation<T>(operation: () => Thenable<T>, timeoutMs: number): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    let active = true;
    const finish = (complete: () => void): void => {
      if (!active) return;
      active = false;
      clearTimeout(timeout);
      complete();
    };
    const timeout = setTimeout(
      () => finish(() => reject(new PackagedGridClipboardOperationFailure())),
      Math.max(1, timeoutMs)
    );
    let pending: PromiseLike<T>;
    try {
      pending = operation();
    } catch {
      finish(() => reject(new PackagedGridClipboardOperationFailure()));
      return;
    }
    void Promise.resolve(pending).then(
      (value) => finish(() => resolve(value)),
      () => finish(() => reject(new PackagedGridClipboardOperationFailure()))
    );
  });
}
