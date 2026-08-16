import { resolve } from "node:path";
import { pathToFileURL } from "node:url";

const clipboardLimitReason = "Copy is limited to 4 MiB of displayed text. Select a smaller range.";
const hostileCell = " \u0000=SUM(A1:A2)";
const hostileRowLabel = "\t\uFEFF@ROW()";
const expectedRow = `"'${hostileRowLabel}"\t'${hostileCell}\t-2024\t-10.5\tfalse`;
const oversizedMarker = "=OW_BROWSER_OVERSIZED:";

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
    await copyRow.click();
    await page.waitForFunction(() => globalThis.openWranglerClipboardBoundary.navigatorWrites.length === 1);
    let boundary = await readClipboardBoundary(page);
    assertExactWrites(boundary, { navigatorWrites: [expectedRow], fallbackWrites: [] });

    await page.evaluate(() => {
      globalThis.openWranglerClipboardBoundary.rejectNavigatorWrite = true;
    });
    await copyRow.click();
    await page.waitForFunction(() => globalThis.openWranglerClipboardBoundary.fallbackWrites.length === 1);
    boundary = await readClipboardBoundary(page);
    assertExactWrites(boundary, {
      navigatorWrites: [expectedRow, expectedRow],
      fallbackWrites: [expectedRow]
    });
    if (boundary.activeAriaLabel !== "Copy row") {
      throw new Error(`The clipboard fallback restored focus to ${JSON.stringify(boundary.activeAriaLabel)}.`);
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
    await page.evaluate(() => {
      const boundary = globalThis.openWranglerClipboardBoundary;
      boundary.navigatorWrites.length = 0;
      boundary.fallbackWrites.length = 0;
      boundary.rejectNavigatorWrite = false;
    });
    await firstCell.click();
    await lastCell.click({ modifiers: ["Shift"] });
    await page.getByText("16 rows by 4 columns selected", { exact: true }).waitFor();
    await page.keyboard.press("Control+C");
    const announcement = page.getByRole("status", { name: "Clipboard copy result" });
    await announcement.filter({ hasText: clipboardLimitReason }).waitFor();
    const rejection = await readClipboardRejection(page);
    if (rejection.navigatorWriteCount !== 0 || rejection.fallbackWriteCount !== 0) {
      throw new Error(
        `Oversized clipboard rejection reached a platform adapter: ${JSON.stringify({
          navigatorWriteCount: rejection.navigatorWriteCount,
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
    "Grid clipboard formula neutralization, platform-adapter writes, fallback focus restoration, and payload-free oversized rejection verified in Chromium."
  );
}

function installClipboardBoundary() {
  const boundary = {
    navigatorWrites: [],
    fallbackWrites: [],
    rejectNavigatorWrite: false
  };
  Object.defineProperty(globalThis, "openWranglerClipboardBoundary", {
    configurable: false,
    value: boundary
  });
  Object.defineProperty(navigator, "clipboard", {
    configurable: true,
    value: {
      async writeText(text) {
        boundary.navigatorWrites.push(text);
        if (boundary.rejectNavigatorWrite) throw new Error("deterministic clipboard rejection");
      }
    }
  });
  Object.defineProperty(document, "execCommand", {
    configurable: true,
    value(command) {
      if (command !== "copy") return false;
      const active = document.activeElement;
      boundary.fallbackWrites.push(active instanceof HTMLTextAreaElement ? active.value : undefined);
      return true;
    }
  });
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
      navigatorWrites: [...boundary.navigatorWrites],
      fallbackWrites: [...boundary.fallbackWrites],
      activeAriaLabel: document.activeElement?.getAttribute("aria-label"),
      announcement
    };
  });
}

async function readClipboardRejection(page) {
  return page.evaluate(() => {
    const boundary = globalThis.openWranglerClipboardBoundary;
    return {
      navigatorWriteCount: boundary.navigatorWrites.length,
      fallbackWriteCount: boundary.fallbackWrites.length,
      announcement: document.querySelector('[aria-label="Clipboard copy result"]')?.textContent ?? ""
    };
  });
}

function assertExactWrites(actual, expected) {
  if (
    actual.navigatorWrites.length !== expected.navigatorWrites.length ||
    actual.navigatorWrites.some((text, index) => text !== expected.navigatorWrites[index]) ||
    actual.fallbackWrites.length !== expected.fallbackWrites.length ||
    actual.fallbackWrites.some((text, index) => text !== expected.fallbackWrites[index])
  ) {
    throw new Error(
      `The production clipboard adapters received unexpected writes: ${JSON.stringify({
        navigatorWriteLengths: actual.navigatorWrites.slice(0, 8).map((text) => text?.length),
        fallbackWriteLengths: actual.fallbackWrites.slice(0, 8).map((text) => text?.length),
        navigatorWriteCount: actual.navigatorWrites.length,
        fallbackWriteCount: actual.fallbackWrites.length
      })}.`
    );
  }
}
