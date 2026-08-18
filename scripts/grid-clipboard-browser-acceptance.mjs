import { resolve } from "node:path";
import { pathToFileURL } from "node:url";

const clipboardLimitReason = "Copy is limited to 4 MiB of displayed text. Select a smaller range.";
const hostileCell = " \u0000=SUM(A1:A2)";
const hostileRowLabel = "\t\uFEFF@ROW()";
const expectedRow = `"'${hostileRowLabel}"\t'${hostileCell}\t-2024\t-10.5\tfalse`;
const oversizedMarker = "=OW_BROWSER_OVERSIZED:";
const clipboardDeniedReason = "Could not write to the clipboard. Check this editor's clipboard permissions.";

export async function verifyGridClipboardBrowserAcceptance(browser, harnessDirectory) {
  const page = await browser.newPage({ viewport: { width: 1280, height: 760 } });
  page.setDefaultTimeout(15_000);
  page.setDefaultNavigationTimeout(15_000);
  await page.addInitScript(installClipboardBoundary);

  try {
    await page.goto(pathToFileURL(resolve(harnessDirectory, "grid-view.html")).href, { waitUntil: "load" });
    const firstCell = page.locator('td[data-grid-row="0"][data-grid-column="0"]');
    await firstCell.waitFor();
    await publishClipboardFixture(page, { oversized: false });
    await page.waitForFunction(
      (expected) => document.querySelector('td[data-grid-row="0"][data-grid-column="0"]')?.textContent === expected,
      hostileCell
    );

    await firstCell.click();
    const copyRow = page.getByRole("button", { name: "Copy row" });
    const adapterCases = [
      adapterCase("navigator success", "success", "success", 1, 1, 0, 0, true),
      adapterCase("navigator unavailable", "unavailable", "success", 0, 0, 1, 1, true),
      adapterCase("navigator writeText missing", "missing", "success", 0, 0, 1, 1, true),
      adapterCase("navigator writeText non-function", "non-function", "success", 0, 0, 1, 1, true),
      adapterCase("navigator rejection", "reject", "success", 1, 0, 1, 1, true),
      adapterCase("navigator synchronous throw", "throw", "success", 1, 0, 1, 1, true),
      adapterCase("navigator rejection with execCommand false", "reject", "false", 1, 0, 1, 0, false),
      adapterCase("navigator throw with execCommand throw", "throw", "throw", 1, 0, 1, 0, false),
      adapterCase("missing writeText with absent execCommand", "missing", "absent", 0, 0, 0, 0, false),
      adapterCase(
        "non-function writeText with non-function execCommand",
        "non-function",
        "non-function",
        0,
        0,
        0,
        0,
        false
      )
    ];
    for (const scenario of adapterCases) {
      await exerciseAdapterCase(page, copyRow, scenario);
    }

    await publishClipboardFixture(page, { oversized: true });
    const lastCell = page.locator('td[data-grid-row="15"][data-grid-column="3"]');
    try {
      await page.waitForFunction((marker) => {
        const text = document.querySelector('td[data-grid-row="0"][data-grid-column="0"]')?.textContent;
        return (
          text?.startsWith(marker) === true &&
          document.querySelectorAll("td[data-grid-row][data-grid-column]").length === 64
        );
      }, oversizedMarker);
    } catch (cause) {
      const diagnostic = await page.evaluate((marker) => {
        const cells = document.querySelectorAll("td[data-grid-row][data-grid-column]");
        const first = cells[0]?.textContent ?? "";
        return {
          cellCount: cells.length,
          firstLength: first.length,
          firstStartsWithMarker: first.startsWith(marker)
        };
      }, oversizedMarker);
      throw new Error(`The production grid rejected its bounded multi-cell fixture: ${JSON.stringify(diagnostic)}.`, {
        cause
      });
    }
    await lastCell.waitFor();
    await configureClipboardBoundary(page, { navigatorMode: "throw", fallbackMode: "throw" });
    await firstCell.click();
    await lastCell.click({ modifiers: ["Shift"] });
    await page.getByText("16 rows by 4 columns selected", { exact: true }).waitFor();
    await page.keyboard.press("Control+C");
    const announcement = page.getByRole("status", { name: "Clipboard copy result" });
    await announcement.filter({ hasText: clipboardLimitReason }).waitFor();
    const rejection = await readClipboardRejection(page);
    if (
      rejection.navigatorAttemptCount !== 0 ||
      rejection.navigatorWriteCount !== 0 ||
      rejection.fallbackAttemptCount !== 0 ||
      rejection.fallbackWriteCount !== 0
    ) {
      throw new Error(
        `Oversized clipboard rejection reached a platform adapter: ${JSON.stringify({
          navigatorAttemptCount: rejection.navigatorAttemptCount,
          navigatorWriteCount: rejection.navigatorWriteCount,
          fallbackAttemptCount: rejection.fallbackAttemptCount,
          fallbackWriteCount: rejection.fallbackWriteCount
        })}.`
      );
    }
    if (rejection.announcement !== clipboardLimitReason || rejection.announcement.includes(oversizedMarker)) {
      throw new Error(
        `Oversized clipboard rejection exposed unexpected text: ${JSON.stringify(rejection.announcement)}.`
      );
    }
    const copyRange = page.getByRole("button", { name: "Copy range" });
    if ((await copyRange.isEnabled()) || (await copyRange.getAttribute("title")) !== clipboardLimitReason) {
      throw new Error("The oversized clipboard fixture did not retain the bounded disabled control contract.");
    }

    await exerciseWholeColumnClipboard(page, harnessDirectory);
  } finally {
    await page.close();
  }

  console.log(
    "Grid clipboard formula neutralization, whole filtered-column paging, exact caps, adapter fallback, focus restoration, payload redaction, and oversized rejection verified in Chromium."
  );
}

async function exerciseWholeColumnClipboard(page, harnessDirectory) {
  await page.goto(pathToFileURL(resolve(harnessDirectory, "grid-column-clipboard.html")).href, { waitUntil: "load" });
  const copyColumn = page.getByRole("button", { name: "Copy column" });
  const headers = page.locator("th[data-grid-column]");
  await headers.first().waitFor();

  await headers.nth(0).locator(".columnTitle").click();
  await copyColumn.waitFor();
  await page.waitForFunction(
    () => document.querySelector('[aria-label="Copy column"]')?.hasAttribute("disabled") === false
  );
  await configureClipboardBoundary(page, { navigatorMode: "unavailable", fallbackMode: "success" });
  await copyColumn.click();
  const hostileExpected = wholeColumnHostileExpected();
  await page.waitForFunction(
    (expected) =>
      globalThis.openWranglerClipboardBoundary.fallbackWrites[0] === expected &&
      document.activeElement?.getAttribute("aria-label") === "Copy column",
    hostileExpected
  );
  const hostileActual = await readClipboardBoundary(page);
  if (
    !arraysEqual(hostileActual.fallbackAttempts, [hostileExpected]) ||
    !arraysEqual(hostileActual.fallbackWrites, [hostileExpected]) ||
    hostileActual.navigatorAttempts.length !== 0 ||
    hostileActual.announcement !== "Copied 64 cells from column hostile_text." ||
    hostileActual.fallbackTextareaCount !== 0
  ) {
    throw new Error("Whole-column fallback copy did not preserve the exact hostile TSV and focus contract.");
  }

  await headers.nth(1).focus();
  await page.keyboard.press("Control+Space");
  await page.waitForFunction(
    () =>
      document.querySelector('[aria-label="Grid selection"]')?.textContent ===
      "Whole filtered and sorted column typed_negative selected, 64 rows."
  );
  await configureClipboardBoundary(page, { navigatorMode: "success", fallbackMode: "throw" });
  await page.keyboard.press("Control+C");
  const typedExpected = Array.from({ length: 64 }, (_, index) => String(-(index + 1))).join("\n");
  await page.waitForFunction(
    (expected) =>
      globalThis.openWranglerClipboardBoundary.navigatorWrites[0] === expected &&
      document.activeElement?.getAttribute("data-grid-column") === "1",
    typedExpected
  );

  await headers.nth(2).locator(".columnTitle").click();
  await page.waitForFunction(
    () => document.querySelector('[aria-label="Copy column"]')?.hasAttribute("disabled") === false
  );
  await configureClipboardBoundary(page, { navigatorMode: "success", fallbackMode: "throw" });
  await copyColumn.click();
  await page.waitForFunction(() => globalThis.openWranglerClipboardBoundary.navigatorWrites.length === 1);
  const exactCap = await page.evaluate(() => {
    const boundary = globalThis.openWranglerClipboardBoundary;
    return {
      attemptCount: boundary.navigatorAttempts.length,
      attemptLength: boundary.navigatorAttempts[0]?.length,
      fallbackAttemptCount: boundary.fallbackAttempts.length,
      writeCount: boundary.navigatorWrites.length,
      writeLength: boundary.navigatorWrites[0]?.length,
      announcement: document.querySelector('[aria-label="Clipboard copy result"]')?.textContent ?? "",
      activeAriaLabel: document.activeElement?.getAttribute("aria-label")
    };
  });
  if (
    exactCap.attemptCount !== 1 ||
    exactCap.writeCount !== 1 ||
    exactCap.attemptLength !== 4 * 1024 * 1024 ||
    exactCap.writeLength !== 4 * 1024 * 1024 ||
    exactCap.fallbackAttemptCount !== 0 ||
    exactCap.announcement !== "Copied 64 cells from column exact_cap." ||
    exactCap.activeAriaLabel !== "Copy column"
  ) {
    throw new Error(`The exact-cap whole-column copy failed: ${JSON.stringify(exactCap)}.`);
  }

  await configureClipboardBoundary(page, { navigatorMode: "throw", fallbackMode: "throw" });
  await headers.nth(3).locator(".columnTitle").click();
  await page.waitForFunction(
    (reason) =>
      document.querySelector('[aria-label="Clipboard copy result"]')?.textContent === reason &&
      document.querySelector('[aria-label="Copy column"]')?.getAttribute("title") === reason,
    clipboardLimitReason
  );
  const rejection = await readClipboardRejection(page);
  if (
    rejection.navigatorAttemptCount !== 0 ||
    rejection.navigatorWriteCount !== 0 ||
    rejection.fallbackAttemptCount !== 0 ||
    rejection.fallbackWriteCount !== 0 ||
    rejection.announcement !== clipboardLimitReason
  ) {
    throw new Error(`The oversized whole-column rejection reached an adapter: ${JSON.stringify(rejection)}.`);
  }

  const paging = await page.evaluate(() => ({
    errors: [...globalThis.openWranglerHarnessErrors],
    responses: globalThis.openWranglerProjectedResponses.map((response) => ({
      offset: response.offset,
      limit: response.limit,
      columnOffset: response.columnOffset,
      columnLimit: response.columnLimit,
      rowWidths: response.rowWidths
    }))
  }));
  const expectedWindows = [
    { offset: 0, limit: 25 },
    { offset: 25, limit: 25 },
    { offset: 50, limit: 14 }
  ];
  for (const columnOffset of [0, 1, 2, 3]) {
    const responses = paging.responses.filter((response) => response.columnOffset === columnOffset);
    if (
      responses.length !== expectedWindows.length ||
      !responses.every(
        (response, index) =>
          response.offset === expectedWindows[index].offset &&
          response.limit === expectedWindows[index].limit &&
          response.columnLimit === 1 &&
          response.rowWidths.every((width) => width === 1)
      )
    ) {
      throw new Error(`Whole-column paging for column ${columnOffset} was not sequential and projected.`);
    }
  }
  if (paging.errors.length !== 0) {
    throw new Error(`Whole-column harness errors: ${JSON.stringify(paging.errors)}.`);
  }
}

function wholeColumnHostileExpected() {
  return Array.from({ length: 64 }, (_, rowNumber) => {
    if (rowNumber === 0) return "' \u0000=SUM(A1:A2)";
    if (rowNumber === 1) return '"\'\t\uFEFF@IMPORT()"';
    if (rowNumber === 2) return '"contains\t""quote"""';
    return `value-${rowNumber + 1}`;
  }).join("\n");
}

function installClipboardBoundary() {
  const boundary = {
    navigatorAttempts: [],
    navigatorWrites: [],
    fallbackAttempts: [],
    fallbackWrites: [],
    navigatorMode: "success",
    fallbackMode: "success"
  };
  Object.defineProperty(globalThis, "openWranglerClipboardBoundary", {
    configurable: false,
    value: boundary
  });
  Object.defineProperty(navigator, "clipboard", {
    configurable: true,
    get() {
      if (boundary.navigatorMode === "unavailable") return undefined;
      if (boundary.navigatorMode === "missing") return {};
      if (boundary.navigatorMode === "non-function") return { writeText: { callable: false } };
      return {
        writeText(text) {
          boundary.navigatorAttempts.push(text);
          if (boundary.navigatorMode === "reject") {
            return Promise.reject(new Error(`deterministic rejection of ${text}`));
          }
          if (boundary.navigatorMode === "throw") throw new Error(`deterministic throw for ${text}`);
          boundary.navigatorWrites.push(text);
          return Promise.resolve();
        }
      };
    }
  });
  boundary.execCommand = (command) => {
    if (command !== "copy") return false;
    const active = document.activeElement;
    const text = active instanceof HTMLTextAreaElement ? active.value : undefined;
    boundary.fallbackAttempts.push(text);
    if (boundary.fallbackMode === "throw") throw new Error(`deterministic fallback throw for ${text}`);
    if (boundary.fallbackMode === "false") return false;
    boundary.fallbackWrites.push(text);
    return true;
  };
  Object.defineProperty(document, "execCommand", { configurable: true, value: boundary.execCommand });
}

function adapterCase(
  label,
  navigatorMode,
  fallbackMode,
  navigatorAttemptCount,
  navigatorWriteCount,
  fallbackAttemptCount,
  fallbackWriteCount,
  succeeds
) {
  return {
    label,
    navigatorMode,
    fallbackMode,
    navigatorAttemptCount,
    navigatorWriteCount,
    fallbackAttemptCount,
    fallbackWriteCount,
    succeeds
  };
}

async function exerciseAdapterCase(page, copyRow, scenario) {
  await configureClipboardBoundary(page, scenario);
  await copyRow.click();
  await page.waitForFunction(({ fallbackAttemptCount, navigatorAttemptCount }) => {
    const boundary = globalThis.openWranglerClipboardBoundary;
    return (
      boundary.navigatorAttempts.length === navigatorAttemptCount &&
      boundary.fallbackAttempts.length === fallbackAttemptCount
    );
  }, scenario);
  const expectedAnnouncement = scenario.succeeds ? "Copied row with its row label." : clipboardDeniedReason;
  await page.waitForFunction(
    (expected) =>
      document.querySelector('[aria-label="Clipboard copy result"]')?.textContent === expected &&
      document.activeElement?.getAttribute("aria-label") === "Copy row",
    expectedAnnouncement
  );

  const actual = await readClipboardBoundary(page);
  assertAdapterCase(actual, scenario, expectedAnnouncement);
}

async function configureClipboardBoundary(page, { navigatorMode, fallbackMode }) {
  await page.evaluate(
    ({ nextFallbackMode, nextNavigatorMode }) => {
      const boundary = globalThis.openWranglerClipboardBoundary;
      boundary.navigatorAttempts.length = 0;
      boundary.navigatorWrites.length = 0;
      boundary.fallbackAttempts.length = 0;
      boundary.fallbackWrites.length = 0;
      boundary.navigatorMode = nextNavigatorMode;
      boundary.fallbackMode = nextFallbackMode;
      Object.defineProperty(document, "execCommand", {
        configurable: true,
        value:
          nextFallbackMode === "absent"
            ? undefined
            : nextFallbackMode === "non-function"
              ? { callable: false }
              : boundary.execCommand
      });

      const clipboard = navigator.clipboard;
      if (nextNavigatorMode === "missing" && (!clipboard || "writeText" in clipboard)) {
        throw new Error("The clipboard boundary did not install a present object with missing writeText.");
      }
      if (
        nextNavigatorMode === "non-function" &&
        (!clipboard || !("writeText" in clipboard) || typeof clipboard.writeText === "function")
      ) {
        throw new Error("The clipboard boundary did not install a non-function writeText value.");
      }
      if (nextFallbackMode === "absent" && document.execCommand !== undefined) {
        throw new Error("The clipboard boundary did not make execCommand unavailable.");
      }
      if (
        nextFallbackMode === "non-function" &&
        (document.execCommand === undefined || typeof document.execCommand === "function")
      ) {
        throw new Error("The clipboard boundary did not install a non-function execCommand value.");
      }
    },
    { nextFallbackMode: fallbackMode, nextNavigatorMode: navigatorMode }
  );
}

async function publishClipboardFixture(page, { oversized }) {
  await page.evaluate(
    ({ marker, ordinaryDisplay, oversizedFixture, rowLabel }) => {
      const current = globalThis.openWranglerSessionPayload;
      if (current.metadata.schema.length !== 4) throw new Error("The clipboard harness requires four grid columns.");
      const oversizedDisplay = marker + "x".repeat(65_536 - marker.length);
      const ordinaryValues = [
        { kind: "string", raw: ordinaryDisplay, display: ordinaryDisplay, isNull: false, isNaN: false },
        { kind: "integer", raw: "-2024", display: "-2024", isNull: false, isNaN: false },
        { kind: "number", raw: -10.5, display: "-10.5", isNull: false, isNaN: false },
        { kind: "boolean", raw: false, display: "false", isNull: false, isNaN: false }
      ];
      const rows = Array.from({ length: oversizedFixture ? 16 : 1 }, (_, rowNumber) => ({
        id: `r:clipboard:${rowNumber}`,
        rowNumber,
        rowLabel: oversizedFixture ? `row-${rowNumber + 1}` : rowLabel,
        values: oversizedFixture
          ? current.metadata.schema.map(() => ({
              kind: "string",
              display: oversizedDisplay,
              isNull: false,
              isNaN: false
            }))
          : ordinaryValues
      }));
      const response = {
        ...current,
        metadata: {
          ...current.metadata,
          shape: { rows: rows.length, columns: current.metadata.schema.length },
          filteredShape: { rows: rows.length, columns: current.metadata.schema.length }
        },
        page: {
          offset: 0,
          limit: rows.length,
          totalRows: rows.length,
          columnIds: current.metadata.schema.map((column) => column.id),
          rows
        },
        summaries: []
      };
      globalThis.openWranglerSessionPayload = response;
      window.dispatchEvent(
        new MessageEvent("message", {
          data: response,
          origin: window.location.origin
        })
      );
    },
    {
      marker: oversizedMarker,
      ordinaryDisplay: hostileCell,
      oversizedFixture: oversized,
      rowLabel: hostileRowLabel
    }
  );
}

async function readClipboardBoundary(page) {
  return page.evaluate(() => {
    const boundary = globalThis.openWranglerClipboardBoundary;
    const announcement = document.querySelector('[aria-label="Clipboard copy result"]')?.textContent ?? "";
    return {
      navigatorAttempts: [...boundary.navigatorAttempts],
      navigatorWrites: [...boundary.navigatorWrites],
      fallbackAttempts: [...boundary.fallbackAttempts],
      fallbackWrites: [...boundary.fallbackWrites],
      activeAriaLabel: document.activeElement?.getAttribute("aria-label"),
      announcement,
      fallbackTextareaCount: document.querySelectorAll('textarea[aria-hidden="true"]').length
    };
  });
}

async function readClipboardRejection(page) {
  return page.evaluate(() => {
    const boundary = globalThis.openWranglerClipboardBoundary;
    return {
      navigatorAttemptCount: boundary.navigatorAttempts.length,
      navigatorWriteCount: boundary.navigatorWrites.length,
      fallbackAttemptCount: boundary.fallbackAttempts.length,
      fallbackWriteCount: boundary.fallbackWrites.length,
      announcement: document.querySelector('[aria-label="Clipboard copy result"]')?.textContent ?? ""
    };
  });
}

function assertAdapterCase(actual, expected, expectedAnnouncement) {
  const expectedNavigatorAttempts = Array.from({ length: expected.navigatorAttemptCount }, () => expectedRow);
  const expectedNavigatorWrites = Array.from({ length: expected.navigatorWriteCount }, () => expectedRow);
  const expectedFallbackAttempts = Array.from({ length: expected.fallbackAttemptCount }, () => expectedRow);
  const expectedFallbackWrites = Array.from({ length: expected.fallbackWriteCount }, () => expectedRow);
  if (
    !arraysEqual(actual.navigatorAttempts, expectedNavigatorAttempts) ||
    !arraysEqual(actual.navigatorWrites, expectedNavigatorWrites) ||
    !arraysEqual(actual.fallbackAttempts, expectedFallbackAttempts) ||
    !arraysEqual(actual.fallbackWrites, expectedFallbackWrites) ||
    actual.navigatorWrites.length + actual.fallbackWrites.length !==
      expected.navigatorWriteCount + expected.fallbackWriteCount ||
    actual.activeAriaLabel !== "Copy row" ||
    actual.fallbackTextareaCount !== 0 ||
    actual.announcement !== expectedAnnouncement ||
    (!expected.succeeds &&
      [hostileCell, hostileRowLabel, expectedRow, "deterministic"].some((text) => actual.announcement.includes(text)))
  ) {
    throw new Error(
      `The ${expected.label} clipboard case violated its bounded adapter contract: ${JSON.stringify({
        navigatorAttemptLengths: actual.navigatorAttempts.slice(0, 8).map((text) => text?.length),
        navigatorWriteLengths: actual.navigatorWrites.slice(0, 8).map((text) => text?.length),
        fallbackAttemptLengths: actual.fallbackAttempts.slice(0, 8).map((text) => text?.length),
        fallbackWriteLengths: actual.fallbackWrites.slice(0, 8).map((text) => text?.length),
        navigatorAttemptCount: actual.navigatorAttempts.length,
        navigatorWriteCount: actual.navigatorWrites.length,
        fallbackAttemptCount: actual.fallbackAttempts.length,
        fallbackWriteCount: actual.fallbackWrites.length
      })}.`
    );
  }
}

function arraysEqual(actual, expected) {
  return actual.length === expected.length && actual.every((text, index) => text === expected[index]);
}
