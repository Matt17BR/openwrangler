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
      adapterCase("navigator rejection", "reject", "success", 1, 0, 1, 1, true),
      adapterCase("navigator synchronous throw", "throw", "success", 1, 0, 1, 1, true),
      adapterCase("navigator rejection with execCommand false", "reject", "false", 1, 0, 1, 0, false),
      adapterCase("navigator throw with execCommand throw", "throw", "throw", 1, 0, 1, 0, false)
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
  } finally {
    await page.close();
  }

  console.log(
    "Grid clipboard formula neutralization, adapter failure fallback, focus restoration, payload redaction, and oversized rejection verified in Chromium."
  );
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
  Object.defineProperty(document, "execCommand", {
    configurable: true,
    value(command) {
      if (command !== "copy") return false;
      const active = document.activeElement;
      const text = active instanceof HTMLTextAreaElement ? active.value : undefined;
      boundary.fallbackAttempts.push(text);
      if (boundary.fallbackMode === "throw") throw new Error(`deterministic fallback throw for ${text}`);
      if (boundary.fallbackMode === "false") return false;
      boundary.fallbackWrites.push(text);
      return true;
    }
  });
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
