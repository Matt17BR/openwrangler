import { createRequire } from "node:module";
import { chmodSync, mkdirSync, mkdtempSync, readdirSync, rmSync, symlinkSync } from "node:fs";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { chromium } from "playwright-core";

const root = resolve(import.meta.dirname, "..");
const harnessDir = resolve(root, "tmp", "screenshots");
const require = createRequire(import.meta.url);
const axePath = require.resolve("axe-core/axe.min.js");
const executablePath = process.env.CHROME_BIN;
const harnesses = readdirSync(harnessDir)
  .filter((file) => file.endsWith(".html"))
  .sort();

if (harnesses.length === 0) {
  throw new Error("No generated webview harnesses found. Run capture:screenshots first.");
}

const workspaceTmp = resolve(root, "tmp");
mkdirSync(workspaceTmp, { recursive: true });
const browserRoot = mkdtempSync(join(workspaceTmp, "accessibility-browser-"));
chmodSync(browserRoot, 0o700);
const browserTemp = join(browserRoot, "temp");
mkdirSync(browserTemp, { recursive: true, mode: 0o700 });
// Chrome places its process-singleton socket below TMPDIR on POSIX. A long
// checkout path can exceed the Unix-domain socket limit, so expose the private
// workspace directory through a short, disposable alias without moving browser
// data into the shared system temp area.
const socketAliasRoot = process.platform === "win32" ? undefined : mkdtempSync("/tmp/ow-a11y-");
const browserTempPath = socketAliasRoot ? join(socketAliasRoot, "t") : browserTemp;
if (socketAliasRoot) {
  chmodSync(socketAliasRoot, 0o700);
  symlinkSync(browserTemp, browserTempPath, "dir");
}
const browserEnvironment = {
  ...process.env,
  HOME: join(browserRoot, "home"),
  XDG_CACHE_HOME: join(browserRoot, "cache"),
  XDG_CONFIG_HOME: join(browserRoot, "config"),
  XDG_DATA_HOME: join(browserRoot, "data"),
  XDG_RUNTIME_DIR: join(browserRoot, "runtime"),
  TEMP: browserTempPath,
  TMP: browserTempPath,
  TMPDIR: browserTempPath
};
for (const directory of Object.values(browserEnvironment).filter(
  (value) => typeof value === "string" && value.startsWith(browserRoot)
)) {
  mkdirSync(directory, { recursive: true, mode: 0o700 });
}
let browser;
const failures = [];

try {
  if (
    process.platform !== "win32" &&
    Buffer.byteLength(join(browserTempPath, "com.google.Chrome.XXXXXX", "SingletonSocket"), "utf8") >= 104
  ) {
    throw new Error("The private Chrome temp alias is too long for a POSIX process-singleton socket.");
  }
  browser = await chromium.launchPersistentContext(join(browserRoot, "profile"), {
    ...(executablePath ? { executablePath } : {}),
    headless: true,
    args: ["--no-sandbox", "--disable-dev-shm-usage", "--allow-file-access-from-files"],
    env: browserEnvironment,
    timeout: 30_000
  });
  for (const harness of harnesses) {
    console.log(`Accessibility checking: ${harness}`);
    const page = await browser.newPage({ viewport: { width: harness.includes("-800") ? 800 : 1280, height: 760 } });
    page.setDefaultTimeout(15_000);
    page.setDefaultNavigationTimeout(15_000);
    await page.goto(pathToFileURL(resolve(harnessDir, harness)).href, { waitUntil: "load", timeout: 15_000 });
    await page.waitForTimeout(500);
    if (harness === "filter-panel.html") {
      await page.getByRole("checkbox").first().waitFor();
    }
    await page.addScriptTag({ path: axePath });
    const result = await withTimeout(
      page.evaluate(async () => {
        return globalThis.axe.run(document, {
          runOnly: {
            type: "tag",
            values: ["wcag2a", "wcag2aa", "wcag21a", "wcag21aa", "wcag22aa"]
          }
        });
      }),
      30_000,
      `${harness} axe scan`
    );
    const violations = result.violations.filter((violation) => violation.impact !== "minor");
    if (violations.length === 0) {
      console.log(`Accessibility verified: ${harness}`);
    } else {
      failures.push({ harness, violations });
    }
    await page.close();
  }
  await verifyNotebookPreviewDisclosure(browser);
  await verifyCodePreviewOrigin(browser);
  await verifyCompactDraftReview(browser);
  await verifyCleaningKeyboardShortcuts(browser);
  await verifyAppliedPlanToolbarLayout(browser);
  await verifyStepInspectionWorkflow(browser);
  await verifyFilterKeyboardWorkflow(browser);
  await verifyInsightsDrawerWorkflow(browser);
  await verifyRProfileAccessibility(browser);
  await verifyGridStatusBar(browser);
  await verifyGridKeyboardWorkflow(browser);
  await verifyWideGridPerformance(browser);
} finally {
  try {
    await browser?.close();
  } finally {
    try {
      if (socketAliasRoot) {
        rmSync(socketAliasRoot, { recursive: true, force: true });
      }
    } finally {
      rmSync(browserRoot, { recursive: true, force: true });
    }
  }
}

async function verifyNotebookPreviewDisclosure(browser) {
  const harness = "notebook-preview.html";
  const page = await browser.newPage({ viewport: { width: 1280, height: 760 } });
  await page.goto(pathToFileURL(resolve(harnessDir, harness)).href, { waitUntil: "load" });
  const status = await page.getByTestId("inline-preview-page").textContent();
  const match = /^1-([0-9,]+) of ([0-9,]+) captured · ([0-9,]+) total$/u.exec(status ?? "");
  const visibleRows = Number(match?.[1]?.replaceAll(",", ""));
  const capturedRows = Number(match?.[2]?.replaceAll(",", ""));
  const totalRows = Number(match?.[3]?.replaceAll(",", ""));
  if (
    !match ||
    !Number.isInteger(visibleRows) ||
    !Number.isInteger(capturedRows) ||
    !Number.isInteger(totalRows) ||
    visibleRows !== Math.min(20, capturedRows) ||
    capturedRows >= totalRows
  ) {
    throw new Error(`${harness} did not label the captured-row limit in its compact pager.`);
  }
  if ((await page.getByRole("button", { name: "Open in Open Wrangler" }).count()) !== 0) {
    throw new Error(`${harness} exposed a workbench action for an unlinked saved preview.`);
  }
  const guidance = await page.locator(".openwrangler-notebook").textContent();
  if (!guidance?.includes("Run this cell again to open the current dataframe in Open Wrangler.")) {
    throw new Error(`${harness} did not explain how to open the complete live dataframe.`);
  }
  const messages = await page.evaluate(() => globalThis.openWranglerNotebookMessages);
  if (messages.length !== 0) {
    throw new Error(`${harness} sent a renderer action for an unlinked saved preview.`);
  }
  await page.close();
  console.log("Notebook MIME v2 truncation disclosure and live-only opening guidance verified.");
}

async function verifyCodePreviewOrigin(browser) {
  const page = await browser.newPage({ viewport: { width: 1280, height: 420 } });
  await page.goto(pathToFileURL(resolve(harnessDir, "code-preview.html")).href, { waitUntil: "load" });
  await page.waitForFunction(() => document.querySelector(".cm-content")?.textContent?.includes("def clean_data"));
  const before = await page.locator(".cm-content").textContent();
  await page.evaluate(() => {
    window.dispatchEvent(
      new MessageEvent("message", {
        data: {
          kind: "codePreview",
          code: "# untrusted replacement",
          editable: true,
          runtimeIdentity: {
            runtimeLanguage: "python",
            dataframeFlavor: "polars",
            codeDialect: "python.polars"
          }
        },
        origin: "https://untrusted.invalid"
      })
    );
  });
  const after = await page.locator(".cm-content").textContent();
  if (after !== before) {
    throw new Error("Code preview accepted a message from another origin.");
  }

  await page.evaluate(() => {
    window.dispatchEvent(
      new MessageEvent("message", {
        data: {
          kind: "codePreview",
          code: "# malformed private identity",
          editable: true,
          runtimeIdentity: {
            runtimeLanguage: "python",
            dataframeFlavor: "pyspark",
            codeDialect: "python.polars"
          }
        },
        origin: window.location.origin
      })
    );
  });
  if ((await page.locator(".cm-content").textContent()) !== before) {
    throw new Error("Code preview accepted an inconsistent private runtime identity.");
  }

  await page.evaluate(() => {
    window.dispatchEvent(
      new MessageEvent("message", {
        data: {
          kind: "codePreview",
          code: "# unexpected private field",
          editable: true,
          runtimeIdentity: {
            runtimeLanguage: "python",
            dataframeFlavor: "polars",
            codeDialect: "python.polars"
          },
          unexpected: true
        },
        origin: window.location.origin
      })
    );
  });
  if ((await page.locator(".cm-content").textContent()) !== before) {
    throw new Error("Code preview accepted a host message with unknown fields.");
  }

  const readOnlyCode = "# Read-only saved notebook snapshot.";
  await page.evaluate((code) => {
    window.dispatchEvent(
      new MessageEvent("message", {
        data: {
          kind: "codePreview",
          code,
          editable: false,
          runtimeIdentity: {
            runtimeLanguage: "python",
            dataframeFlavor: "polars",
            codeDialect: "python.polars"
          }
        },
        origin: window.location.origin
      })
    );
  }, readOnlyCode);
  const content = page.locator(".cm-content");
  await page.waitForFunction((code) => document.querySelector(".cm-content")?.textContent === code, readOnlyCode);
  if ((await content.getAttribute("aria-label")) !== "Read-only generated Python code preview") {
    throw new Error("Code preview did not publish its read-only accessible label.");
  }
  if ((await content.getAttribute("contenteditable")) !== "false") {
    throw new Error("Code preview remained editable after a read-only host update.");
  }
  await content.click({ force: true });
  await page.keyboard.type("\nraise RuntimeError('must not be inserted')");
  if ((await content.textContent()) !== readOnlyCode) {
    throw new Error("Read-only Code Preview accepted keyboard input.");
  }

  const noDialectCode = "def distributed_frame():\n    return None";
  await page.evaluate((code) => {
    window.dispatchEvent(
      new MessageEvent("message", {
        data: {
          kind: "codePreview",
          code,
          editable: false,
          runtimeIdentity: {
            runtimeLanguage: "python",
            dataframeFlavor: "pyspark",
            codeDialect: null
          }
        },
        origin: window.location.origin
      })
    );
  }, noDialectCode);
  await page.waitForFunction(
    (code) =>
      document.querySelector(".cm-content")?.textContent === code.replaceAll("\n", "") &&
      document.querySelectorAll(".cm-content .cm-line span").length === 0,
    noDialectCode
  );
  const noDialectIdentity = await page.locator("#root").evaluate((root) => ({ ...root.dataset }));
  if (
    noDialectIdentity.runtimeLanguage !== "python" ||
    noDialectIdentity.dataframeFlavor !== "pyspark" ||
    noDialectIdentity.codeDialect !== ""
  ) {
    throw new Error(`Code preview published the wrong viewing-only identity: ${JSON.stringify(noDialectIdentity)}.`);
  }
  if ((await content.getAttribute("aria-label")) !== "Read-only Open Wrangler code preview") {
    throw new Error("Code preview labeled a viewing-only backend as generated Python code.");
  }
  if ((await content.getAttribute("contenteditable")) !== "false") {
    throw new Error("Code preview made a null-dialect backend editable.");
  }

  const pandasCode = "def clean_data(df):\n    return df.dropna()";
  await page.evaluate((code) => {
    window.dispatchEvent(
      new MessageEvent("message", {
        data: {
          kind: "codePreview",
          code,
          editable: true,
          runtimeIdentity: {
            runtimeLanguage: "python",
            dataframeFlavor: "pandas",
            codeDialect: "python.pandas"
          }
        },
        origin: window.location.origin
      })
    );
  }, pandasCode);
  await page.waitForFunction(
    (code) =>
      document.querySelector(".cm-content")?.textContent === code.replaceAll("\n", "") &&
      document.querySelectorAll(".cm-content .cm-line span").length > 0,
    pandasCode
  );
  const pandasIdentity = await page.locator("#root").evaluate((root) => ({ ...root.dataset }));
  if (
    pandasIdentity.runtimeLanguage !== "python" ||
    pandasIdentity.dataframeFlavor !== "pandas" ||
    pandasIdentity.codeDialect !== "python.pandas"
  ) {
    throw new Error(`Code preview published the wrong generated-code identity: ${JSON.stringify(pandasIdentity)}.`);
  }
  if ((await content.getAttribute("aria-label")) !== "Editable generated Python code preview") {
    throw new Error("Code preview did not restore its generated Python label.");
  }
  await page.close();
  console.log("Code-preview identity, parser, host origin, and read-only behavior verified.");
}

async function verifyCompactDraftReview(browser) {
  const cases = [
    {
      harness: "draft-preview.html",
      width: 1920,
      operation: "Formula column",
      diff: ["+1 column", "2 values added in this block"],
      warnings: false,
      expectSingleRowToolbar: true
    },
    {
      harness: "draft-preview.html",
      width: 1280,
      operation: "Formula column",
      diff: ["+1 column", "2 values added in this block"],
      warnings: false,
      expectSingleRowToolbar: true
    },
    {
      harness: "draft-preview-dark-800.html",
      width: 800,
      operation: "Formula column",
      diff: ["+1 column", "2 values added in this block"],
      warnings: false
    },
    {
      harness: "by-example-preview.html",
      width: 1280,
      operation: "Transform by example",
      diff: ["+1 column", "10 values added in this block"],
      warnings: false,
      expectSingleRowToolbar: true
    },
    {
      harness: "by-example-preview.html",
      width: 620,
      operation: "Transform by example",
      diff: ["+1 column", "10 values added in this block"],
      warnings: false
    },
    {
      harness: "by-example-preview.html",
      width: 320,
      operation: "Transform by example",
      diff: ["+1 column", "10 values added in this block"],
      warnings: false
    },
    {
      harness: "by-example-preview-dark-zoom-200.html",
      width: 1280,
      operation: "Transform by example",
      diff: ["+1 column", "10 values added in this block"],
      warnings: false
    }
  ];

  for (const { harness, width, operation, diff, warnings, expectSingleRowToolbar = false } of cases) {
    const page = await browser.newPage({ viewport: { width, height: 760 } });
    await page.goto(pathToFileURL(resolve(harnessDir, harness)).href, { waitUntil: "load" });

    const reviews = page.getByRole("region", { name: "Draft review" });
    await reviews.first().waitFor();
    if ((await reviews.count()) !== 1) {
      throw new Error(`${harness} did not render exactly one Draft review.`);
    }
    const review = reviews.first();
    await review.getByText(operation, { exact: true }).waitFor();

    const actualDiff = (await review.getByLabel("Data diff summary").locator(":scope > span").allTextContents()).map(
      (value) => value.trim()
    );
    if (actualDiff.length !== diff.length || actualDiff.some((value, index) => value !== diff[index])) {
      throw new Error(
        `${harness} rendered the wrong draft diff: expected ${JSON.stringify(diff)}, received ${JSON.stringify(actualDiff)}.`
      );
    }

    const payloadWarnings = await page.evaluate(() => globalThis.openWranglerSessionPayload.warnings ?? []);
    const warningRegion = review.getByRole("alert");
    if (!warnings) {
      if (payloadWarnings.length !== 0 || (await warningRegion.count()) !== 0) {
        throw new Error(`${harness} rendered a warning for an unambiguous draft.`);
      }
    } else {
      if (payloadWarnings.length === 0 || (await warningRegion.count()) !== 1) {
        throw new Error(`${harness} did not render its by-example warning exactly once.`);
      }
      const actualWarnings = (await warningRegion.locator(":scope > span").allTextContents()).map((value) =>
        value.trim()
      );
      if (
        actualWarnings.length !== payloadWarnings.length ||
        actualWarnings.some((value, index) => value !== payloadWarnings[index])
      ) {
        throw new Error(
          `${harness} did not preserve its exact warning text: expected ${JSON.stringify(
            payloadWarnings
          )}, received ${JSON.stringify(actualWarnings)}.`
        );
      }
    }

    for (const name of ["Discard", "Apply step"]) {
      const buttons = page.getByRole("button", { name, exact: true });
      if ((await buttons.count()) !== 1) {
        throw new Error(`${harness} did not expose exactly one ${name} action.`);
      }
      if (!(await buttons.first().isEnabled())) {
        throw new Error(`${harness} exposed a disabled ${name} action after the draft settled.`);
      }
    }
    if (
      (await page.locator(".draftCode").count()) !== 0 ||
      (await page.getByLabel("Generated Python code preview").count()) !== 0
    ) {
      throw new Error(`${harness} duplicated generated code inside the workbench.`);
    }

    const grid = page.getByRole("grid").first();
    await grid.waitFor();
    await page.locator('[data-grid-row="0"]').first().waitFor();
    const layout = await page.evaluate(() => {
      const review = document.querySelector('[aria-label="Draft review"]');
      const grid = document.querySelector('[role="grid"]');
      const scroller = document.querySelector('[data-testid="data-grid-scroller"]');
      const toolbar = document.querySelector(".toolbar");
      const toolbarActions = document.querySelector(".toolbarActions");
      if (!review || !grid || !scroller || !toolbar || !toolbarActions) return undefined;
      const reviewBounds = review.getBoundingClientRect();
      const gridBounds = grid.getBoundingClientRect();
      const viewportWidth = document.documentElement.clientWidth;
      const viewportHeight = document.documentElement.clientHeight;
      const clippedToolbarItems = [...document.querySelectorAll(".toolbar > *, .toolbarActions > *")].flatMap(
        (element) => {
          const bounds = element.getBoundingClientRect();
          if (bounds.left >= -1 && bounds.right <= viewportWidth + 1) return [];
          return [
            {
              element:
                element.getAttribute("aria-label") ??
                element.getAttribute("class") ??
                element.textContent?.trim().slice(0, 40) ??
                element.tagName,
              left: bounds.left,
              right: bounds.right
            }
          ];
        }
      );
      const sharesRow = (elements) => {
        const centers = elements
          .map((element) => element.getBoundingClientRect())
          .filter((bounds) => bounds.width > 0 && bounds.height > 0)
          .map((bounds) => bounds.top + bounds.height / 2);
        return centers.length > 0 && Math.max(...centers) - Math.min(...centers) <= 1;
      };
      const draftActions = [...review.querySelectorAll(":scope > .cleaningActions > button")].map((element) =>
        element.getBoundingClientRect()
      );
      return {
        documentOverflow: Math.max(document.documentElement.scrollWidth, document.body.scrollWidth) - viewportWidth,
        toolbarOverflow: Math.max(
          toolbar.scrollWidth - toolbar.clientWidth,
          toolbarActions.scrollWidth - toolbarActions.clientWidth
        ),
        clippedToolbarItems,
        toolbarSingleRow: sharesRow([...toolbar.children]) && sharesRow([...toolbarActions.children]),
        reviewOverflow: review.scrollWidth - review.clientWidth,
        reviewWithinViewport:
          reviewBounds.left >= -1 &&
          reviewBounds.right <= viewportWidth + 1 &&
          reviewBounds.top >= -1 &&
          reviewBounds.bottom <= viewportHeight + 1,
        draftActionsWithinViewport:
          draftActions.length === 2 &&
          draftActions.every(
            (bounds) =>
              bounds.width > 0 &&
              bounds.height > 0 &&
              bounds.left >= Math.max(0, reviewBounds.left) - 1 &&
              bounds.right <= Math.min(viewportWidth, reviewBounds.right) + 1 &&
              bounds.top >= Math.max(0, reviewBounds.top) - 1 &&
              bounds.bottom <= Math.min(viewportHeight, reviewBounds.bottom) + 1
          ),
        gridVisible:
          gridBounds.width > 0 &&
          gridBounds.height > 0 &&
          gridBounds.left < viewportWidth &&
          gridBounds.right > 0 &&
          gridBounds.top < viewportHeight &&
          gridBounds.bottom > 0,
        internalHorizontalOverflow: scroller.scrollWidth >= scroller.clientWidth
      };
    });
    if (!layout) {
      throw new Error(`${harness} did not expose the Draft review and grid layout.`);
    }
    if (
      layout.documentOverflow > 1 ||
      layout.toolbarOverflow > 1 ||
      layout.clippedToolbarItems.length > 0 ||
      layout.reviewOverflow > 1 ||
      !layout.reviewWithinViewport ||
      !layout.draftActionsWithinViewport ||
      (expectSingleRowToolbar && !layout.toolbarSingleRow) ||
      !layout.gridVisible ||
      !layout.internalHorizontalOverflow
    ) {
      throw new Error(`${harness} at ${width}px overflowed or obscured the draft grid: ${JSON.stringify(layout)}.`);
    }
    await page.close();
  }

  console.log("Compact draft review, exact diff/warnings, actions, grid visibility, and narrow/zoom layout verified.");
}

async function verifyInsightsDrawerWorkflow(browser) {
  for (const [harness, width] of [
    ["summary-families-dark-800.html", 800],
    ["summary-families-dark-zoom-200.html", 1280]
  ]) {
    const page = await browser.newPage({ viewport: { width, height: 760 } });
    await page.goto(pathToFileURL(resolve(harnessDir, harness)).href, { waitUntil: "load" });

    for (const name of [
      /numeric distribution/u,
      /boolean distribution/u,
      /categorical distribution/u,
      /datetime distribution/u
    ]) {
      const charts = page.getByRole("img", { name });
      await charts.first().waitFor();
    }
    await page.getByText("True 4", { exact: true }).waitFor();
    await page.getByText("False 2", { exact: true }).waitFor();
    await page.getByText("Min 1", { exact: true }).waitFor();
    await page.getByText("Max 6", { exact: true }).waitFor();

    const numericChart = page.getByRole("img", { name: /numeric distribution/u }).first();
    const histogram = numericChart.locator("xpath=..");
    const histogramBins = histogram.locator(".numericHistogramHitTarget");
    const firstBin = histogramBins.first();
    const secondBin = histogramBins.nth(1);
    const firstBar = histogram.locator(".numericHistogramBar").first();
    await firstBar.evaluate((bar) => {
      const chartHeight = bar.ownerSVGElement?.viewBox.baseVal.height;
      if (!chartHeight) throw new Error("Histogram bar has no owning SVG view box.");
      bar.setAttribute("height", "2");
      bar.setAttribute("y", String(chartHeight - 2));
    });
    const [chartBounds, firstHitBounds, firstBarBounds] = await Promise.all([
      numericChart.boundingBox(),
      firstBin.boundingBox(),
      firstBar.boundingBox()
    ]);
    if (
      !chartBounds ||
      !firstHitBounds ||
      !firstBarBounds ||
      firstHitBounds.width <= 0 ||
      firstHitBounds.height < chartBounds.height - 1 ||
      firstHitBounds.height > chartBounds.height + 3 ||
      firstBarBounds.height > chartBounds.height * 0.08
    ) {
      throw new Error(
        `${harness} did not preserve a full-chart-height pointer target above a two-pixel bar: ` +
          `${JSON.stringify({ chartBounds, firstHitBounds, firstBarBounds })}.`
      );
    }
    const firstLabel = await firstBin.getAttribute("aria-label");
    const initialFill = await firstBar.evaluate((bar) => getComputedStyle(bar).fill);
    await firstBin.hover({ position: { x: firstHitBounds.width / 2, y: 1 } });
    const tooltip = histogram.getByRole("tooltip");
    await tooltip.waitFor();
    if ((await tooltip.textContent())?.trim() !== firstLabel) {
      throw new Error(`${harness} did not show the hovered bin's exact interval and row count immediately.`);
    }
    const hoveredFill = await firstBar.evaluate((bar) => getComputedStyle(bar).fill);
    if (hoveredFill === initialFill) {
      throw new Error(`${harness} did not visibly highlight the hovered histogram bin.`);
    }
    await page.locator(".backendBadge").first().hover();
    await tooltip.waitFor({ state: "detached" });
    await firstBin.focus();
    await tooltip.waitFor();
    if ((await tooltip.textContent())?.trim() !== firstLabel) {
      throw new Error(`${harness} did not show the keyboard-focused bin's exact interval and row count.`);
    }
    await page.locator(".backendBadge").first().hover();
    if ((await tooltip.textContent())?.trim() !== firstLabel) {
      throw new Error(`${harness} let pointer exit hide the still-keyboard-focused histogram bin.`);
    }
    await page.keyboard.press("Tab");
    if (!(await secondBin.evaluate(isActiveTab))) {
      throw new Error(`${harness} did not expose adjacent histogram bins in keyboard order.`);
    }
    if ((await tooltip.textContent())?.trim() !== (await secondBin.getAttribute("aria-label"))) {
      throw new Error(`${harness} did not update the tooltip for the next keyboard-focused histogram bin.`);
    }
    await page.locator('input[placeholder="Search columns"]').focus();
    await tooltip.waitFor({ state: "detached" });
    if (width === 800) {
      await page.emulateMedia({ forcedColors: "active" });
      const forcedRestingColors = await firstBar.evaluate((bar) => {
        const probe = document.createElement("span");
        probe.style.color = "CanvasText";
        document.body.append(probe);
        const canvasText = getComputedStyle(probe).color;
        probe.remove();
        return { bar: getComputedStyle(bar).fill, canvasText };
      });
      if (forcedRestingColors.bar !== forcedRestingColors.canvasText) {
        throw new Error(
          `${harness} kept an author blue histogram fill instead of the forced-color CanvasText: ` +
            `${JSON.stringify(forcedRestingColors)}.`
        );
      }
      await firstBin.hover({ position: { x: firstHitBounds.width / 2, y: 1 } });
      const forcedActiveColors = await firstBar.evaluate((bar) => {
        const probe = document.createElement("span");
        probe.style.color = "Highlight";
        document.body.append(probe);
        const highlight = getComputedStyle(probe).color;
        probe.remove();
        return { bar: getComputedStyle(bar).fill, highlight };
      });
      if (forcedActiveColors.bar !== forcedActiveColors.highlight) {
        throw new Error(
          `${harness} did not map the active histogram bin to the forced-color Highlight: ` +
            `${JSON.stringify(forcedActiveColors)}.`
        );
      }
      await page.locator(".backendBadge").first().hover();
      await page.emulateMedia({ forcedColors: "none" });
    }

    const headerLayout = await page.locator("th[data-column]").evaluateAll((headers) =>
      headers.flatMap((header) => {
        const scroller = header.closest('[data-testid="data-grid-scroller"]');
        const title = header.querySelector(".columnTitle");
        const metadata = header.querySelector(".columnMetaRow");
        if (!scroller || !title || !metadata) return [];
        const scrollerBounds = scroller.getBoundingClientRect();
        const headerBounds = header.getBoundingClientRect();
        if (
          headerBounds.left < scrollerBounds.left - 1 ||
          headerBounds.right > scrollerBounds.right + 1 ||
          headerBounds.width <= 0
        ) {
          return [];
        }
        const titleBounds = title.getBoundingClientRect();
        const metadataBounds = metadata.getBoundingClientRect();
        return [
          {
            column: header.getAttribute("data-column") ?? "",
            headerWidth: header.clientWidth,
            titleWidth: title.clientWidth,
            titleScrollWidth: title.scrollWidth,
            titleBottom: titleBounds.bottom,
            metadataTop: metadataBounds.top
          }
        ];
      })
    );
    if (headerLayout.length < 2) {
      throw new Error(`${harness} did not expose enough complete column headers for layout verification.`);
    }
    const crampedHeaders = headerLayout.filter(
      ({ headerWidth, titleWidth }) => titleWidth < Math.max(1, headerWidth * 0.72)
    );
    if (crampedHeaders.length > 0) {
      throw new Error(
        `${harness} let metadata controls consume column-name space: ${crampedHeaders
          .map(({ column, headerWidth, titleWidth }) => `${column} (${titleWidth}/${headerWidth}px)`)
          .join(", ")}.`
      );
    }
    const clippedHeaders = headerLayout.filter(({ titleScrollWidth, titleWidth }) => titleScrollWidth > titleWidth + 1);
    if (clippedHeaders.length > 0) {
      throw new Error(
        `${harness} clipped realistic column names despite the dedicated title row: ${clippedHeaders
          .map(({ column }) => column)
          .join(", ")}.`
      );
    }
    const overlappingHeaders = headerLayout.filter(({ titleBottom, metadataTop }) => titleBottom > metadataTop + 1);
    if (overlappingHeaders.length > 0) {
      throw new Error(
        `${harness} overlapped column names and metadata controls: ${overlappingHeaders
          .map(({ column }) => column)
          .join(", ")}.`
      );
    }

    const toggle = page.getByRole("button", { name: "Column profiles and filters" });
    if ((await toggle.getAttribute("aria-controls")) !== "openwrangler-insights-panel") {
      throw new Error(`${harness} did not connect the Column profiles toggle to its drawer.`);
    }
    await toggle.focus();
    await page.keyboard.press("Enter");
    const panel = page.getByRole("complementary", { name: "Column profiles and filters" });
    await panel.waitFor();
    if ((await panel.getAttribute("aria-modal")) !== null) {
      throw new Error(`${harness} incorrectly exposed the narrow Column profiles drawer as modal.`);
    }
    await page.getByRole("button", { name: "Close panel" }).waitFor();
    await page.waitForFunction(() => document.activeElement?.getAttribute("aria-label") === "Close panel");
    const summaryPanel = panel.locator("section.summaryPanel");
    const tabs = summaryPanel.getByRole("tab");
    if ((await tabs.allTextContents()).map((text) => text.trim()).join(",") !== "Column,Dataset,Filters / Sorts") {
      throw new Error(`${harness} did not expose the Column, Dataset, and Filters / Sorts profile tabs.`);
    }

    const columnTab = summaryPanel.getByRole("tab", { name: "Column" });
    const datasetTab = summaryPanel.getByRole("tab", { name: "Dataset" });
    const filtersTab = summaryPanel.getByRole("tab", { name: "Filters / Sorts" });
    if ((await columnTab.getAttribute("aria-selected")) !== "true") {
      throw new Error(`${harness} did not open Column profiles on the selected-column view.`);
    }
    const columnPanel = summaryPanel.getByRole("tabpanel", { name: "Column" });
    await columnPanel.getByRole("heading", { name: "value (column 1)" }).waitFor();
    if (await columnPanel.getByRole("heading", { name: "value (column 2)" }).count()) {
      throw new Error(`${harness} rendered an unselected duplicate column in the selected-column view.`);
    }

    await page.addScriptTag({ path: axePath });
    await scanPageAccessibility(page, `${harness} (Column tab)`);

    await columnTab.focus();
    await page.keyboard.press("ArrowRight");
    await summaryPanel.getByRole("tabpanel", { name: "Dataset" }).waitFor();
    if ((await datasetTab.getAttribute("aria-selected")) !== "true" || !(await datasetTab.evaluate(isActiveTab))) {
      throw new Error(`${harness} did not keyboard-select and focus the Dataset tab.`);
    }
    await summaryPanel.getByRole("heading", { name: "Dataset" }).waitFor();
    await scanPageAccessibility(page, `${harness} (Dataset tab)`);

    await page.keyboard.press("ArrowRight");
    const filtersPanel = panel.getByRole("tabpanel", { name: "Filters / Sorts" });
    await filtersPanel.waitFor();
    if ((await filtersTab.getAttribute("aria-selected")) !== "true" || !(await filtersTab.evaluate(isActiveTab))) {
      throw new Error(`${harness} did not keyboard-select and focus the Filters / Sorts tab.`);
    }
    await filtersPanel.getByRole("heading", { name: "Filters / Sorts" }).waitFor();
    await filtersPanel.getByRole("status").filter({ hasText: '2 columns share the displayed name "value"' }).waitFor();
    for (const optionName of ["value (column 1)", "value (column 2)"]) {
      const options = filtersPanel.locator("option", { hasText: optionName });
      if ((await options.count()) !== 2) {
        throw new Error(`${harness} did not preserve positional duplicate labels in both column selectors.`);
      }
    }
    await filtersPanel
      .locator("summary")
      .filter({ hasText: /^SORTS$/u })
      .click();
    await filtersPanel.getByLabel("Sort direction").waitFor();
    await filtersPanel.getByRole("button", { name: "Add to sort" }).waitFor();
    await scanPageAccessibility(page, `${harness} (Filters / Sorts tab)`);

    await filtersTab.focus();
    await page.keyboard.press("Home");
    await summaryPanel.getByRole("tabpanel", { name: "Column" }).waitFor();
    if ((await columnTab.getAttribute("aria-selected")) !== "true" || !(await columnTab.evaluate(isActiveTab))) {
      throw new Error(`${harness} did not return keyboard focus to the Column tab.`);
    }
    await page.keyboard.press("Escape");
    await panel.waitFor({ state: "detached" });
    await page.waitForFunction(
      () =>
        document.activeElement instanceof HTMLButtonElement &&
        document.activeElement.getAttribute("aria-label") === "Column profiles and filters"
    );
    if (!(await toggle.evaluate((element) => document.activeElement === element))) {
      throw new Error(`${harness} did not restore focus to the exact Column profiles opener.`);
    }
    await page.close();
  }

  const textPage = await browser.newPage({ viewport: { width: 800, height: 760 } });
  const textHarness = "summary-text-dark-800.html";
  await textPage.goto(pathToFileURL(resolve(harnessDir, textHarness)).href, { waitUntil: "load" });
  const textToggle = textPage.getByRole("button", { name: "Column profiles and filters" });
  if ((await textToggle.getAttribute("aria-expanded")) !== "true") {
    await textToggle.focus();
    await textPage.keyboard.press("Enter");
  }
  const textPanel = textPage.getByRole("complementary", { name: "Column profiles and filters" });
  await textPanel.getByRole("heading", { name: "account_note" }).waitFor();
  for (const [label, value] of [
    ["Null", "1"],
    ["Empty", "1"],
    ["Min length", "0"],
    ["Max length", "2"],
    ["Mean length", "1"]
  ]) {
    const term = textPanel.locator("dt", { hasText: new RegExp(`^${label}$`, "u") });
    if (
      (await term.count()) !== 1 ||
      (await term.locator("xpath=following-sibling::dd[1]").textContent())?.trim() !== value
    ) {
      throw new Error(`${textHarness} did not expose exact ${label.toLowerCase()} ${value}.`);
    }
  }
  if (await textPanel.locator("dt", { hasText: /^NaN$/u }).count()) {
    throw new Error(`${textHarness} exposed an irrelevant NaN row for a text column.`);
  }
  await textPage.addScriptTag({ path: axePath });
  await scanPageAccessibility(textPage, `${textHarness} (Column tab)`);
  await textPage.keyboard.press("Escape");
  await textPanel.waitFor({ state: "detached" });
  if (!(await textToggle.evaluate((element) => document.activeElement === element))) {
    throw new Error(`${textHarness} did not restore focus to the exact Column profiles opener.`);
  }
  await textPage.close();

  const extremaPage = await browser.newPage({ viewport: { width: 800, height: 760 } });
  const extremaHarness = "summary-extrema-limit.html";
  await extremaPage.goto(pathToFileURL(resolve(harnessDir, extremaHarness)).href, { waitUntil: "load" });
  const extremaPanel = extremaPage.getByRole("complementary", { name: "Column profiles and filters" });
  await extremaPanel.getByRole("heading", { name: "wide_contract_value" }).waitFor();
  const expectedExtrema = [
    ["Min", "Minimum", `-${"9".repeat(65_535)}`],
    ["Max", "Maximum", "9".repeat(65_536)]
  ];
  for (const [termLabel, accessibleLabel, fullValue] of expectedExtrema) {
    const term = extremaPanel.locator("dt", { hasText: new RegExp(`^${termLabel}$`, "u") });
    const value = term.locator("xpath=following-sibling::dd[1]");
    const visibleText = (await value.textContent()) ?? "";
    const bounds = await value.boundingBox();
    if (
      visibleText.length !== 96 ||
      !visibleText.includes("…") ||
      (await value.getAttribute("title")) !== `${accessibleLabel}: ${fullValue}` ||
      (await value.getAttribute("aria-label")) !== `${accessibleLabel} ${fullValue}` ||
      !bounds ||
      bounds.height > 120
    ) {
      throw new Error(`${extremaHarness} did not bound visible ${termLabel} text while preserving its full semantics.`);
    }
  }
  await extremaPage.addScriptTag({ path: axePath });
  await scanPageAccessibility(extremaPage, `${extremaHarness} (protocol-limit exact extrema)`);
  await extremaPage.close();

  console.log(
    "Column profiles drawer focus, duplicate labels, histogram pointer/keyboard inspection, numeric/text summary-family semantics, and bounded exact extrema verified."
  );
}

async function verifyRProfileAccessibility(browser) {
  const harness = "r-profile-accessibility.html";
  const page = await browser.newPage({ viewport: { width: 1280, height: 760 } });
  await page.goto(pathToFileURL(resolve(harnessDir, harness)).href, { waitUntil: "load" });

  const backendBadge = page.locator('[data-session-badge="backend"]');
  const modeBadge = page.locator('[data-session-badge="mode"]');
  await backendBadge.waitFor();
  await modeBadge.waitFor();
  if (
    (await backendBadge.textContent())?.trim() !== "R" ||
    (await modeBadge.textContent())?.trim() !== "viewing"
  ) {
    throw new Error(`${harness} did not expose the R backend and viewing-mode badges.`);
  }
  await page.getByRole("rowheader", { name: "Row 1, label baseline" }).waitFor();

  const headerProfiles = page.getByRole("button", { name: "Header profiles", exact: true });
  if ((await headerProfiles.getAttribute("aria-pressed")) !== "false") {
    throw new Error(`${harness} started R header profiles without an explicit request.`);
  }
  await headerProfiles.focus();
  await page.keyboard.press("Space");
  if ((await headerProfiles.getAttribute("aria-pressed")) !== "true") {
    throw new Error(`${harness} did not let a keyboard user request R header profiles.`);
  }
  await page.keyboard.press("Space");
  if ((await headerProfiles.getAttribute("aria-pressed")) !== "false") {
    throw new Error(`${harness} did not let a keyboard user turn R header profiles off again.`);
  }

  const toggle = page.getByRole("button", { name: "Column profiles and sorts", exact: true });
  await toggle.focus();
  await page.keyboard.press("Enter");
  const drawer = page.getByRole("complementary", { name: "Column profiles and sorts", exact: true });
  await drawer.waitFor();
  const tablist = drawer.getByRole("tablist", { name: "Column profiles and sorts view", exact: true });
  await tablist.waitFor();
  const tabs = tablist.getByRole("tab");
  if ((await tabs.allTextContents()).map((text) => text.trim()).join(",") !== "Column,Dataset,Sorts") {
    throw new Error(`${harness} did not expose the exact R profile and sort tabs.`);
  }
  if ((await drawer.getByRole("tab", { name: "Filters", exact: true }).count()) !== 0) {
    throw new Error(`${harness} advertised a Filters tab for an R session without native filters.`);
  }

  const columnTab = drawer.getByRole("tab", { name: "Column", exact: true });
  const datasetTab = drawer.getByRole("tab", { name: "Dataset", exact: true });
  const sortsTab = drawer.getByRole("tab", { name: "Sorts", exact: true });
  const columnPanel = drawer.getByRole("tabpanel", { name: "Column", exact: true });
  await columnPanel.getByRole("heading", { name: "value (column 1)", exact: true }).waitFor();
  await columnPanel.getByRole("heading", { name: "Distribution", exact: true }).waitFor();
  await page.addScriptTag({ path: axePath });
  await scanPageAccessibility(page, `${harness} (Column profile)`);

  await columnTab.focus();
  await page.keyboard.press("ArrowRight");
  await drawer.getByRole("tabpanel", { name: "Dataset", exact: true }).waitFor();
  if ((await datasetTab.getAttribute("aria-selected")) !== "true" || !(await datasetTab.evaluate(isActiveTab))) {
    throw new Error(`${harness} did not move keyboard focus to the Dataset tab.`);
  }
  await page.keyboard.press("ArrowRight");
  await drawer.getByRole("tabpanel", { name: "Sorts", exact: true }).waitFor();
  if ((await sortsTab.getAttribute("aria-selected")) !== "true" || !(await sortsTab.evaluate(isActiveTab))) {
    throw new Error(`${harness} did not move keyboard focus to the Sorts tab.`);
  }

  const flagHeader = page.locator('th[data-column="flag"]');
  const menuToggle = flagHeader.getByLabel("Column actions for flag", { exact: true });
  const filterAction = flagHeader.getByRole("button", { name: "Filter…", exact: true });
  const sortAction = flagHeader.getByRole("button", { name: "Sort ascending", exact: true });
  await menuToggle.focus();
  await page.keyboard.press("Enter");
  await filterAction.waitFor({ state: "visible" });
  await sortAction.waitFor({ state: "visible" });
  if (!(await filterAction.isDisabled()) || (await sortAction.isDisabled())) {
    throw new Error(`${harness} did not disable only the unsupported R filter action.`);
  }
  const filterDescriptionId = await filterAction.getAttribute("aria-describedby");
  if (
    !filterDescriptionId ||
    (await page.locator(`#${filterDescriptionId}`).textContent())?.trim() !==
      "Filtering is unavailable for this dataframe."
  ) {
    throw new Error(`${harness} did not explain why its R filter action is unavailable.`);
  }
  await scanPageAccessibility(page, `${harness} (Sorts and column menu)`);

  await menuToggle.focus();
  await page.keyboard.press("Enter");
  await filterAction.waitFor({ state: "hidden" });
  await sortAction.waitFor({ state: "hidden" });
  await sortsTab.focus();
  await page.keyboard.press("Escape");
  await drawer.waitFor({ state: "detached" });
  await page.waitForFunction(
    () =>
      document.activeElement instanceof HTMLButtonElement &&
      document.activeElement.getAttribute("aria-label") === "Column profiles and sorts"
  );
  if (!(await toggle.evaluate((element) => document.activeElement === element))) {
    throw new Error(`${harness} did not restore focus to the R profile drawer opener.`);
  }

  await page.close();
  console.log("R profile/sort capabilities, keyboard navigation, focus restoration, and axe verified.");
}

async function verifyGridStatusBar(browser) {
  for (const { harness, width, expectedDataGridWidth, range, previousDisabled, nextDisabled, expectSecondRow } of [
    {
      harness: "wide-view.html",
      width: 320,
      expectedDataGridWidth: 320,
      range: "Rows 1\u2013200 of 1,000",
      previousDisabled: true,
      nextDisabled: false,
      expectSecondRow: true
    },
    {
      harness: "grid-zoom-2.html",
      width: 1280,
      expectedDataGridWidth: 640,
      range: "Rows 1\u20134 of 4",
      previousDisabled: true,
      nextDisabled: true,
      expectSecondRow: false
    },
    {
      harness: "grid-terminal-range-dark-320.html",
      width: 320,
      expectedDataGridWidth: 320,
      range: "Rows 99,999,801\u2013100,000,000 of 100,000,000",
      previousDisabled: false,
      nextDisabled: true,
      expectSecondRow: true
    },
    {
      harness: "grid-terminal-range-dark-320.html",
      width: 400,
      expectedDataGridWidth: 400,
      range: "Rows 99,999,801\u2013100,000,000 of 100,000,000",
      previousDisabled: false,
      nextDisabled: true,
      expectSecondRow: true
    },
    {
      harness: "grid-terminal-range-dark-zoom-200.html",
      width: 800,
      expectedDataGridWidth: 400,
      range: "Rows 99,999,801\u2013100,000,000 of 100,000,000",
      previousDisabled: false,
      nextDisabled: true,
      expectSecondRow: true
    }
  ]) {
    const page = await browser.newPage();
    await page.setViewportSize({ width, height: 760 });
    await page.goto(pathToFileURL(resolve(harnessDir, harness)).href, { waitUntil: "load" });
    const statusBar = page.locator(".gridStatusBar");
    await statusBar.waitFor();
    const visibleRows = statusBar.getByRole("status", { name: "Visible rows" });
    if ((await visibleRows.textContent())?.trim() !== range) {
      throw new Error(`${harness} did not expose the exact visible-row range ${JSON.stringify(range)}.`);
    }
    if (
      (await visibleRows.getAttribute("aria-live")) !== "polite" ||
      (await visibleRows.getAttribute("aria-atomic")) !== "true"
    ) {
      throw new Error(`${harness} did not keep the visible-row range as one polite, atomic status.`);
    }
    const previous = statusBar.getByRole("button", { name: "Previous block" });
    const next = statusBar.getByRole("button", { name: "Next block" });
    const actualPreviousDisabled = await previous.evaluate(
      (button) => button instanceof HTMLButtonElement && button.disabled
    );
    const actualNextDisabled = await next.evaluate((button) => button instanceof HTMLButtonElement && button.disabled);
    if (
      actualPreviousDisabled !== previousDisabled ||
      actualNextDisabled !== nextDisabled ||
      (await previous.getAttribute("aria-disabled")) !== null ||
      (await next.getAttribute("aria-disabled")) !== null
    ) {
      throw new Error(
        `${harness} did not preserve exact native disabled semantics for block navigation: ${JSON.stringify({
          actualPreviousDisabled,
          actualNextDisabled,
          previousDisabled,
          nextDisabled
        })}.`
      );
    }
    if ((await previous.locator(".codicon-chevron-left").count()) !== 1) {
      throw new Error(`${harness} did not render the Previous block Codicon.`);
    }
    if ((await next.locator(".codicon-chevron-right").count()) !== 1) {
      throw new Error(`${harness} did not render the Next block Codicon.`);
    }
    const headerProfiles = statusBar.getByRole("button", { name: "Header profiles", exact: true });
    if ((await headerProfiles.getAttribute("aria-pressed")) !== "true") {
      throw new Error(`${harness} did not expose the default pressed Header profiles state.`);
    }
    const layout = await statusBar.evaluate((bar) => {
      const bounds = bar.getBoundingClientRect();
      const scroller = bar.previousElementSibling;
      const rangeStatus = bar.querySelector('[role="status"][aria-label="Visible rows"]');
      const headerProfiles = bar.querySelector(".headerProfilesButton");
      const app = bar.closest(".app");
      const dataGrid = bar.closest(".dataGrid");
      const actions = [
        bar.querySelector('[aria-label="Previous block"]'),
        bar.querySelector('[aria-label="Next block"]'),
        headerProfiles
      ];
      const rangeBounds = rangeStatus?.getBoundingClientRect();
      const actionBottom = Math.max(
        ...actions.map((action) => action?.getBoundingClientRect().bottom ?? Number.POSITIVE_INFINITY)
      );
      const headerProfilesBounds = headerProfiles?.getBoundingClientRect();
      const rangeStyle = rangeStatus ? getComputedStyle(rangeStatus) : undefined;
      return {
        position: getComputedStyle(bar).position,
        followsScroller: scroller?.matches('[data-testid="data-grid-scroller"]') === true,
        overflow: bar.scrollWidth - bar.clientWidth,
        dataGridWidth: dataGrid?.clientWidth ?? Number.POSITIVE_INFINITY,
        appOverflow: app ? app.scrollWidth - app.clientWidth : Number.POSITIVE_INFINITY,
        documentOverflow: document.documentElement.scrollWidth - document.documentElement.clientWidth,
        rangeClipped: rangeStatus
          ? rangeStatus.scrollWidth > rangeStatus.clientWidth + 1 ||
            rangeStatus.scrollHeight > rangeStatus.clientHeight + 1
          : true,
        rangeOnSecondRow: Boolean(rangeBounds && rangeBounds.top >= actionBottom - 1),
        rangeSingleLine: Boolean(
          rangeStatus && rangeStyle && rangeStatus.clientHeight <= Number.parseFloat(rangeStyle.fontSize) * 1.5
        ),
        headerProfilesReachable: Boolean(
          headerProfilesBounds &&
          headerProfilesBounds.left >= bounds.left - 1 &&
          headerProfilesBounds.right <= bounds.right + 1 &&
          headerProfilesBounds.top >= bounds.top - 1 &&
          headerProfilesBounds.bottom <= bounds.bottom + 1
        ),
        headerProfilesBackground: headerProfiles ? getComputedStyle(headerProfiles).backgroundColor : "transparent",
        clippedChildren: [...bar.children].flatMap((child) => {
          const childBounds = child.getBoundingClientRect();
          return childBounds.left >= bounds.left - 1 && childBounds.right <= bounds.right + 1
            ? []
            : [child.getAttribute("aria-label") ?? child.textContent?.trim() ?? child.tagName];
        })
      };
    });
    if (
      layout.position === "sticky" ||
      layout.position === "fixed" ||
      !layout.followsScroller ||
      layout.overflow > 1 ||
      layout.dataGridWidth !== expectedDataGridWidth ||
      layout.appOverflow > 1 ||
      layout.documentOverflow > 1 ||
      layout.rangeClipped ||
      layout.rangeOnSecondRow !== expectSecondRow ||
      !layout.rangeSingleLine ||
      !layout.headerProfilesReachable ||
      layout.headerProfilesBackground === "transparent" ||
      layout.headerProfilesBackground === "rgba(0, 0, 0, 0)" ||
      layout.clippedChildren.length > 0
    ) {
      throw new Error(`${harness} clipped, moved, or made the grid status bar sticky: ${JSON.stringify(layout)}.`);
    }
    await headerProfiles.click();
    if ((await headerProfiles.getAttribute("aria-pressed")) !== "false") {
      throw new Error(`${harness} did not keep Header profiles reachable as a pressed toggle.`);
    }
    await page.close();
  }

  const forcedPage = await browser.newPage();
  await forcedPage.setViewportSize({ width: 320, height: 760 });
  await forcedPage.emulateMedia({ forcedColors: "active" });
  await forcedPage.goto(pathToFileURL(resolve(harnessDir, "grid-terminal-range-dark-320.html")).href, {
    waitUntil: "load"
  });
  const forcedStatusBar = forcedPage.locator(".gridStatusBar");
  await forcedStatusBar.waitFor();
  const forcedHeaderProfiles = forcedStatusBar.getByRole("button", { name: "Header profiles", exact: true });
  await forcedHeaderProfiles.focus();
  const forcedStyles = await forcedStatusBar.evaluate((bar) => {
    const bounds = bar.getBoundingClientRect();
    const app = bar.closest(".app");
    const navigation = [...bar.querySelectorAll(".gridNavigationButton")].map((button) => {
      const style = getComputedStyle(button);
      const iconBounds = button.querySelector(".codicon")?.getBoundingClientRect();
      return {
        borderStyle: style.borderStyle,
        borderWidth: style.borderWidth,
        forcedColorAdjust: style.forcedColorAdjust,
        opacity: style.opacity,
        iconVisible: Boolean(iconBounds && iconBounds.width > 0 && iconBounds.height > 0)
      };
    });
    const header = bar.querySelector(".headerProfilesButton");
    const headerStyle = header ? getComputedStyle(header) : undefined;
    return {
      barOverflow: bar.scrollWidth - bar.clientWidth,
      appOverflow: app ? app.scrollWidth - app.clientWidth : Number.POSITIVE_INFINITY,
      documentOverflow: document.documentElement.scrollWidth - document.documentElement.clientWidth,
      clippedChildren: [...bar.children].filter((child) => {
        const childBounds = child.getBoundingClientRect();
        return childBounds.left < bounds.left - 1 || childBounds.right > bounds.right + 1;
      }).length,
      navigation,
      header: headerStyle
        ? {
            backgroundColor: headerStyle.backgroundColor,
            color: headerStyle.color,
            forcedColorAdjust: headerStyle.forcedColorAdjust,
            outlineColor: headerStyle.outlineColor,
            outlineStyle: headerStyle.outlineStyle,
            outlineWidth: headerStyle.outlineWidth
          }
        : undefined
    };
  });
  if (
    forcedStyles.barOverflow > 1 ||
    forcedStyles.appOverflow > 1 ||
    forcedStyles.documentOverflow > 1 ||
    forcedStyles.clippedChildren > 0 ||
    forcedStyles.navigation.length !== 2 ||
    forcedStyles.navigation.some(
      ({ borderStyle, borderWidth, forcedColorAdjust, opacity, iconVisible }) =>
        borderStyle !== "solid" ||
        Number.parseFloat(borderWidth) < 1 ||
        forcedColorAdjust !== "none" ||
        opacity !== "1" ||
        !iconVisible
    ) ||
    !forcedStyles.header ||
    forcedStyles.header.backgroundColor === "transparent" ||
    forcedStyles.header.backgroundColor === "rgba(0, 0, 0, 0)" ||
    forcedStyles.header.color === forcedStyles.header.backgroundColor ||
    forcedStyles.header.forcedColorAdjust !== "none" ||
    forcedStyles.header.outlineColor === "transparent" ||
    forcedStyles.header.outlineStyle === "none" ||
    Number.parseFloat(forcedStyles.header.outlineWidth) < 1
  ) {
    throw new Error(`Forced colors did not preserve the grid status controls: ${JSON.stringify(forcedStyles)}.`);
  }
  await forcedPage.close();
  console.log("Bottom grid status, narrow/200%-zoom range visibility, Codicon navigation, and forced colors verified.");
}

async function scanPageAccessibility(page, harness, selector) {
  const result = await withTimeout(
    page.evaluate(async (contextSelector) => {
      const context = contextSelector === undefined ? document : document.querySelector(contextSelector);
      if (!context) throw new Error(`Missing axe context ${contextSelector}.`);
      return globalThis.axe.run(context, {
        runOnly: {
          type: "tag",
          values: ["wcag2a", "wcag2aa", "wcag21a", "wcag21aa", "wcag22aa"]
        }
      });
    }, selector),
    30_000,
    `${harness} axe scan`
  );
  const violations = result.violations.filter((violation) => violation.impact !== "minor");
  if (violations.length === 0) {
    console.log(`Accessibility verified: ${harness}`);
  } else {
    failures.push({ harness, violations });
  }
}

function isActiveTab(element) {
  return element === document.activeElement;
}

if (failures.length > 0) {
  const detail = failures
    .flatMap(({ harness, violations }) =>
      violations.map(
        (violation) =>
          `${harness}: [${violation.impact ?? "unknown"}] ${violation.id}: ${violation.help}\n` +
          violation.nodes
            .slice(0, 5)
            .map((node) => `  ${node.target.join(" ")}: ${node.failureSummary ?? "failed"}`)
            .join("\n")
      )
    )
    .join("\n");
  throw new Error(`Webview accessibility scan failed:\n${detail}`);
}

console.log(`Accessibility verified for ${harnesses.length} production webview harnesses.`);

async function withTimeout(promise, timeoutMs, label) {
  let timer;
  try {
    return await Promise.race([
      promise,
      new Promise((_, reject) => {
        timer = setTimeout(() => reject(new Error(`${label} exceeded ${timeoutMs}ms.`)), timeoutMs);
      })
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

async function verifyWideGridPerformance(browser) {
  const page = await browser.newPage({ viewport: { width: 1280, height: 760 } });
  await page.goto(pathToFileURL(resolve(harnessDir, "wide-view.html")).href, { waitUntil: "load" });
  await page.waitForSelector('[data-grid-row="0"]');

  const cached = [];
  for (const row of [1, 4, 8, 12, 16, 20, 24, 28]) {
    cached.push(
      await page.evaluate(async (targetRow) => {
        const scroller = document.querySelector("[data-testid='data-grid-scroller']");
        const started = performance.now();
        scroller.scrollTop = targetRow * 29;
        await new Promise((resolveFrame) => requestAnimationFrame(() => requestAnimationFrame(resolveFrame)));
        return performance.now() - started;
      }, row)
    );
  }

  const uncached = [];
  for (const row of [200, 400, 600, 800]) {
    const started = performance.now();
    await page.locator("[data-testid='data-grid-scroller']").evaluate((scroller, targetRow) => {
      scroller.scrollTop = targetRow * 29;
    }, row);
    await page.waitForSelector(`[data-grid-row="${row}"]`);
    uncached.push(performance.now() - started);
  }
  await assertProjectedHarnessClean(page, "wide-grid performance");
  await page.close();

  const cachedP95 = percentile(cached, 0.95);
  const uncachedP95 = percentile(uncached, 0.95);
  if (cachedP95 > 100 || uncachedP95 > 500) {
    throw new Error(
      `Wide-grid performance failed: cached p95 ${cachedP95.toFixed(1)}ms (limit 100ms), uncached p95 ${uncachedP95.toFixed(1)}ms (limit 500ms).`
    );
  }
  console.log(
    `Wide-grid performance verified: cached p95 ${cachedP95.toFixed(1)}ms, uncached p95 ${uncachedP95.toFixed(1)}ms.`
  );
}

async function verifyCleaningKeyboardShortcuts(browser) {
  const page = await browser.newPage({ viewport: { width: 1280, height: 760 } });
  await page.goto(pathToFileURL(resolve(harnessDir, "draft-preview.html")).href, { waitUntil: "load" });
  const apply = page.getByRole("button", { name: "Apply step" });
  await apply.waitFor();
  await apply.focus();
  await page.keyboard.press("Control+Enter");
  await waitForRuntimeRequest(page, "applyDraft");

  await resetDraftHarness(page);
  const discard = page.getByRole("button", { name: "Discard" });
  await discard.focus();
  await page.keyboard.press("Escape");
  await waitForRuntimeRequest(page, "discardDraft");

  await resetDraftHarness(page);
  await showAppliedStep(page);
  const undo = page.getByRole("button", { name: "Undo" });
  await undo.waitFor();
  await undo.focus();
  await page.keyboard.press("Control+Alt+z");
  await waitForRuntimeRequest(page, "undoStep");

  await resetDraftHarness(page);
  await showAppliedStep(page);
  const edit = page.getByRole("button", { name: "Edit latest" });
  await edit.waitFor();
  await edit.focus();
  await page.keyboard.press("Control+Shift+e");
  await page.getByRole("dialog", { name: "Edit cleaning step" }).waitFor();
  await page.keyboard.press("Escape");
  if (await page.getByRole("dialog", { name: "Edit cleaning step" }).isVisible()) {
    throw new Error("Escape did not close the operation dialog.");
  }
  await page.close();
  console.log("Cleaning-plan keyboard shortcuts verified.");
}

async function verifyAppliedPlanToolbarLayout(browser) {
  const cases = [
    { harness: "draft-preview.html", width: 1280, label: "wide" },
    { harness: "draft-preview.html", width: 620, label: "narrow" },
    { harness: "draft-preview.html", width: 320, label: "compact" },
    { harness: "by-example-preview-dark-zoom-200.html", width: 1280, label: "200% zoom" },
    { harness: "draft-preview.html", width: 620, label: "forced colors", forcedColors: true }
  ];

  for (const { harness, width, label, forcedColors = false } of cases) {
    console.log(`Applied-plan toolbar checking: ${harness} (${label}).`);
    const page = await browser.newPage({ viewport: { width, height: 760 } });
    if (forcedColors) await page.emulateMedia({ forcedColors: "active" });
    await page.goto(pathToFileURL(resolve(harnessDir, harness)).href, { waitUntil: "load" });
    await page.getByRole("button", { name: "Apply step" }).waitFor();
    await showAppliedStep(page);

    const plan = page.getByRole("group", { name: "Cleaning plan" });
    await plan.waitFor();
    if ((await page.locator(".cleaningBar").count()) !== 0) {
      throw new Error(`${harness} (${label}) retained the obsolete second cleaning-plan bar.`);
    }
    if (!(await plan.evaluate((element) => element.parentElement?.classList.contains("toolbarActions") === true))) {
      throw new Error(`${harness} (${label}) did not place the named cleaning-plan group in the primary toolbar.`);
    }
    await plan.getByText("1 applied step", { exact: true }).waitFor();
    for (const name of ["Edit latest", "Undo"]) {
      const actions = plan.getByRole("button", { name, exact: true });
      if ((await actions.count()) !== 1 || !(await actions.isEnabled())) {
        throw new Error(`${harness} (${label}) did not expose one enabled ${name} action.`);
      }
    }

    const layout = await page.evaluate(() => {
      const toolbar = document.querySelector(".toolbar");
      const toolbarActions = document.querySelector(".toolbarActions");
      const plan = document.querySelector(".toolbarPlan");
      const grid = document.querySelector('[role="grid"]');
      if (!toolbar || !toolbarActions || !plan || !grid) return undefined;
      const backendBadge = toolbar.querySelector(".backendBadge");
      const columnSearch = toolbar.querySelector('input[placeholder="Search columns"]');
      const viewportWidth = document.documentElement.clientWidth;
      const toolbarBounds = toolbar.getBoundingClientRect();
      const planBounds = plan.getBoundingClientRect();
      const childBounds = [...plan.children].map((child) => child.getBoundingClientRect());
      const actionLabels = [...toolbarActions.querySelectorAll("button, input")].map(
        (element) => element.getAttribute("aria-label") ?? element.textContent?.trim() ?? ""
      );
      return {
        documentOverflow: Math.max(document.documentElement.scrollWidth, document.body.scrollWidth) - viewportWidth,
        toolbarOverflow: toolbar.scrollWidth - toolbar.clientWidth,
        actionOverflow: toolbarActions.scrollWidth - toolbarActions.clientWidth,
        planOverflow: plan.scrollWidth - plan.clientWidth,
        planContained:
          planBounds.left >= Math.max(0, toolbarBounds.left) - 1 &&
          planBounds.right <= Math.min(viewportWidth, toolbarBounds.right) + 1 &&
          planBounds.top >= toolbarBounds.top - 1 &&
          planBounds.bottom <= toolbarBounds.bottom + 1,
        childrenContained: childBounds.every(
          (bounds) =>
            bounds.width > 0 &&
            bounds.height > 0 &&
            bounds.left >= planBounds.left - 1 &&
            bounds.right <= planBounds.right + 1 &&
            bounds.top >= planBounds.top - 1 &&
            bounds.bottom <= planBounds.bottom + 1
        ),
        gridVisible: grid.getBoundingClientRect().height > 0,
        actionLabels,
        forcedColorAdjust: {
          plan: getComputedStyle(plan).forcedColorAdjust,
          toolbar: getComputedStyle(toolbar).forcedColorAdjust,
          backendBadge: backendBadge ? getComputedStyle(backendBadge).forcedColorAdjust : undefined,
          columnSearch: columnSearch ? getComputedStyle(columnSearch).forcedColorAdjust : undefined
        }
      };
    });
    if (
      !layout ||
      layout.documentOverflow > 1 ||
      layout.toolbarOverflow > 1 ||
      layout.actionOverflow > 1 ||
      layout.planOverflow > 1 ||
      !layout.planContained ||
      !layout.childrenContained ||
      !layout.gridVisible
    ) {
      throw new Error(`${harness} (${label}) overflowed the applied-plan toolbar: ${JSON.stringify(layout)}.`);
    }
    if (
      forcedColors &&
      (layout.forcedColorAdjust.plan !== "none" ||
        layout.forcedColorAdjust.toolbar === "none" ||
        layout.forcedColorAdjust.backendBadge === "none" ||
        layout.forcedColorAdjust.columnSearch === "none")
    ) {
      throw new Error(
        `${harness} (${label}) leaked the cleaning-plan forced-color opt-out to toolbar siblings: ` +
          `${JSON.stringify(layout.forcedColorAdjust)}.`
      );
    }
    const addIndex = layout.actionLabels.indexOf("Add step");
    const editIndex = layout.actionLabels.indexOf("Edit latest");
    const undoIndex = layout.actionLabels.indexOf("Undo");
    const exportIndex = layout.actionLabels.indexOf("Export");
    if (!(addIndex >= 0 && addIndex < editIndex && editIndex < undoIndex && undoIndex < exportIndex)) {
      throw new Error(
        `${harness} (${label}) exposed an unexpected cleaning-plan tab order: ${layout.actionLabels.join(", ")}.`
      );
    }

    const addStep = page.getByRole("button", { name: "Add step", exact: true });
    const editLatest = plan.getByRole("button", { name: "Edit latest", exact: true });
    const undo = plan.getByRole("button", { name: "Undo", exact: true });
    const exportData = page.getByRole("button", { name: "Export", exact: true });
    await addStep.focus();
    for (const [name, target] of [
      ["Edit latest", editLatest],
      ["Undo", undo],
      ["Export", exportData]
    ]) {
      await page.keyboard.press("Tab");
      if (!(await target.evaluate(isActiveTab))) {
        throw new Error(`${harness} (${label}) did not move Tab focus to ${name}.`);
      }
    }

    await page.addScriptTag({ path: axePath });
    await scanPageAccessibility(
      page,
      `${harness} (${label} applied-plan toolbar)`,
      forcedColors ? ".toolbarPlan" : undefined
    );
    await page.close();
  }

  console.log("Applied cleaning-plan command row, responsive layout, forced colors, tab order, and axe verified.");
}

async function verifyStepInspectionWorkflow(browser) {
  const page = await browser.newPage({ viewport: { width: 1280, height: 760 } });
  await page.goto(pathToFileURL(resolve(harnessDir, "step-inspection.html")).href, { waitUntil: "load" });
  await waitForRuntimeRequest(page, "inspectStep");

  const inspection = page.getByLabel("Selected applied-step inspection");
  await inspection.waitFor();
  const filters = page.getByRole("button", { name: "Filters paused during inspection" });
  if (!(await filters.isDisabled())) {
    throw new Error("Applied-step inspection did not disable filters and column profiles.");
  }

  const diffSummary = page.getByLabel("Selected step data diff summary");
  await diffSummary.waitFor();
  if (!(await diffSummary.textContent())?.includes("+1 columns")) {
    throw new Error("Applied-step inspection did not report its added column.");
  }

  const addedHeader = page.getByRole("columnheader", { name: "adjusted_sales, added column" });
  await addedHeader.waitFor();
  if ((await addedHeader.getAttribute("data-diff-state")) !== "added") {
    throw new Error("Applied-step inspection did not expose the added-column diff state.");
  }
  const addedCell = page.getByRole("gridcell", {
    name: /adjusted_sales, row 1: added column; before column absent; after/u
  });
  await addedCell.waitFor();
  if ((await addedCell.getAttribute("data-diff-state")) !== "added") {
    throw new Error("Applied-step inspection did not expose an accessible added-cell diff state.");
  }

  const pageRequestsBeforeClear = await runtimeRequestCount(page, "getPage");
  const showConfirmed = page.getByRole("button", { name: "Show confirmed data" });
  await showConfirmed.focus();
  await page.keyboard.press("Escape");
  await inspection.waitFor({ state: "detached" });
  await page.waitForFunction(() =>
    globalThis.openWranglerMessages.some((message) => message.kind === "clearStepInspection")
  );

  if ((await runtimeRequestCount(page, "getPage")) !== pageRequestsBeforeClear) {
    throw new Error("Clearing applied-step inspection fetched the confirmed grid again.");
  }
  const restoredFilters = page.getByRole("button", { name: "Column profiles and filters" });
  await restoredFilters.waitFor();
  if (await restoredFilters.isDisabled()) {
    throw new Error("Clearing applied-step inspection did not restore filter controls.");
  }
  const restoredHeader = page.locator('th[data-column="adjusted_sales"]');
  await restoredHeader.waitFor();
  if (await restoredHeader.getAttribute("data-diff-state")) {
    throw new Error("Clearing applied-step inspection left diff state on the confirmed grid.");
  }
  if ((await page.locator("[data-diff-state]").count()) !== 0) {
    throw new Error("Clearing applied-step inspection left diff annotations in the confirmed grid.");
  }

  await page.close();
  console.log("Applied-step diff, accessibility, Escape clear, and local confirmed-grid restoration verified.");
}

async function verifyFilterKeyboardWorkflow(browser) {
  const page = await browser.newPage({ viewport: { width: 1280, height: 760 } });
  await page.goto(pathToFileURL(resolve(harnessDir, "filter-panel.html")).href, { waitUntil: "load" });
  await page.bringToFront();
  await page.waitForFunction(() => document.hasFocus());
  await page.getByRole("complementary", { name: "Column profiles and filters" }).waitFor();
  await waitForRuntimeRequestCount(page, "getColumnValues", 1);
  await page.getByRole("checkbox").first().waitFor();

  const columnAction = page.locator('th[data-column="year"] details.columnMenu summary');
  await columnAction.focus();
  await page.keyboard.press("Enter");
  const columnMenu = page.locator('th[data-column="year"] details.columnMenu[open] .columnMenuContent');
  await columnMenu.waitFor();
  const menuBackground = await columnMenu.evaluate((element) => {
    const color = getComputedStyle(element).backgroundColor;
    const alpha = color.match(/^rgba\([^,]+,[^,]+,[^,]+,\s*([\d.]+)\)$/u)?.[1];
    return { color, alpha: color === "transparent" ? 0 : alpha === undefined ? 1 : Number(alpha) };
  });
  if (menuBackground.alpha < 1) {
    throw new Error(`Column menu background is not opaque (${menuBackground.color}).`);
  }
  await columnAction.focus();
  await page.keyboard.press("Enter");
  await columnMenu.waitFor({ state: "hidden" });

  const search = page.getByRole("textbox", { name: /Search values for/ });
  await search.focus();
  await page.keyboard.type("ber");
  await page.keyboard.press("Enter");
  await waitForRuntimeRequestCount(page, "getColumnValues", 2);

  const predicate = page.getByRole("textbox", { name: /predicate value/ });
  await predicate.focus();
  await page.keyboard.type("Berlin");
  await page.keyboard.press("Tab");
  await page.keyboard.press("Enter");
  await waitForRuntimeRequestCount(page, "getPage", 1);

  const sorts = page.locator("details").filter({ hasText: "SORTS" });
  if (!(await sorts.evaluate((element) => element.open))) {
    await sorts.locator("summary").focus();
    await page.keyboard.press("Enter");
    await page.waitForFunction(() =>
      [...document.querySelectorAll("details")].some(
        (element) => element.textContent?.includes("SORTS") && element.open
      )
    );
  }
  const direction = page.getByRole("combobox", { name: "Sort direction" });
  await direction.focus();
  await page.keyboard.press("End");
  if (!(await sorts.evaluate((element) => element.open))) {
    throw new Error("Changing sort direction closed the sort disclosure.");
  }
  const addSort = page.getByRole("button", { name: /Add to sort|Update sort/ });
  await addSort.focus();
  await page.keyboard.press("Enter");
  if (!(await sorts.evaluate((element) => element.open))) {
    throw new Error("Adding a sort closed the sort disclosure.");
  }
  const applySort = page.getByRole("button", { name: "Apply sort order" });
  await applySort.focus();
  await page.keyboard.press("Enter");
  await waitForRuntimeRequestCount(page, "getPage", 2);

  await page.bringToFront();
  await page.waitForFunction(() => document.hasFocus());
  const close = page.getByRole("button", { name: "Close panel" });
  await close.focus();
  await page.keyboard.press("Enter");
  await page.getByRole("complementary", { name: "Column profiles and filters" }).waitFor({ state: "detached" });
  try {
    await page.waitForFunction(
      () => {
        const active = document.activeElement;
        if (!(active instanceof HTMLButtonElement)) return false;
        return (
          active.textContent?.trim() === "Filter…" ||
          active.getAttribute("aria-label") === "Column profiles and filters"
        );
      },
      undefined,
      { timeout: 2_000 }
    );
  } catch {
    const focus = await page.evaluate(() => {
      const active = document.activeElement;
      return {
        tag: active?.tagName,
        text: active?.textContent?.trim(),
        ariaLabel: active?.getAttribute("aria-label"),
        className: active?.getAttribute("class")
      };
    });
    throw new Error(`Closing the filter drawer did not restore a valid opener: ${JSON.stringify(focus)}.`);
  }
  await page.close();
  console.log("Filter, sort, and drawer-focus keyboard workflow verified.");
}

async function verifyGridKeyboardWorkflow(browser) {
  const page = await browser.newPage({ viewport: { width: 1280, height: 760 } });
  const cdp = await page.context().newCDPSession(page);
  await cdp.send("Emulation.setCPUThrottlingRate", { rate: 4 });
  await page.goto(pathToFileURL(resolve(harnessDir, "wide-view.html")).href, { waitUntil: "load" });
  const scroller = page.locator("[data-testid='data-grid-scroller']");
  const firstCell = page.locator('[data-grid-row="0"][data-grid-column="0"]');
  await firstCell.waitFor();
  const initialProjectionIsExact = await page.evaluate(() => {
    const payload = globalThis.openWranglerSessionPayload;
    const expected = payload.metadata.schema.slice(0, 16).map((column) => column.id);
    return (
      payload.page.columnIds.length === expected.length &&
      payload.page.columnIds.every((columnId, index) => columnId === expected[index]) &&
      payload.page.rows.every((row) => row.values.length === expected.length)
    );
  });
  if (!initialProjectionIsExact) {
    throw new Error("Wide-grid browser harness did not start from an exact 16-column projected page.");
  }
  await firstCell.focus();
  await waitForFocusedGridCell(page, 0, 0);

  await page.keyboard.press("ArrowRight");
  await waitForFocusedGridCell(page, 0, 1);
  await page.keyboard.press("ArrowDown");
  await waitForFocusedGridCell(page, 1, 1);
  await page.keyboard.press("ArrowLeft");
  await waitForFocusedGridCell(page, 1, 0);
  await page.keyboard.press("ArrowUp");
  await waitForFocusedGridCell(page, 0, 0);

  await page.keyboard.press("End");
  await waitForFocusedGridCell(page, 0, 39);
  await page.waitForFunction(() => {
    const cell = document.querySelector('td[data-grid-row="0"][data-grid-column="39"]');
    return (
      cell?.textContent?.trim() === "39" &&
      globalThis.openWranglerProjectedResponses.some(
        (response) =>
          response.columnOffset > 0 &&
          response.columnOffset + response.columnIds.length ===
            globalThis.openWranglerSessionPayload.metadata.schema.length
      )
    );
  });
  const farProjection = await page.evaluate(() => {
    const schema = globalThis.openWranglerSessionPayload.metadata.schema;
    return globalThis.openWranglerProjectedResponses.find(
      (response) => response.columnOffset > 0 && response.columnOffset + response.columnIds.length === schema.length
    );
  });
  const expectedFarIds = await page.evaluate(
    ({ columnOffset, columnLimit }) =>
      globalThis.openWranglerSessionPayload.metadata.schema
        .slice(columnOffset, columnOffset + columnLimit)
        .map((column) => column.id),
    farProjection
  );
  const maximumPrefetchWidth = 2 * 16;
  if (
    !farProjection ||
    farProjection.columnLimit > maximumPrefetchWidth ||
    farProjection.columnIds.length > farProjection.columnLimit ||
    farProjection.columnIds.some((columnId, index) => columnId !== expectedFarIds[index]) ||
    farProjection.rowWidths.some((width) => width !== farProjection.columnIds.length)
  ) {
    throw new Error(`Far-column projection was not exact and bounded: ${JSON.stringify(farProjection)}.`);
  }
  if ((await scroller.evaluate((element) => element.scrollLeft)) <= 0) {
    throw new Error("End did not horizontally virtualize and focus the final grid column.");
  }
  await page.keyboard.press("Home");
  await waitForFocusedGridCell(page, 0, 0);
  await page.waitForFunction(
    () => document.querySelector('td[data-grid-row="0"][data-grid-column="0"]')?.textContent?.trim() === "0"
  );

  await scroller.evaluate((element) => {
    element.style.flex = "none";
    element.style.height = "560px";
  });
  const pageRowCount = await scroller.evaluate((element) => Math.max(1, Math.floor(element.clientHeight / 29)));
  await page.keyboard.press("PageDown");
  await waitForFocusedGridCell(page, pageRowCount, 0);
  const pageDownRow = await focusedGridRow(page);
  await page.keyboard.press("PageUp");
  await waitForFocusedGridCell(page, 0, 0);
  if (pageDownRow !== pageRowCount) {
    throw new Error(`PageDown focused row ${pageDownRow}; expected one visible page (${pageRowCount} rows).`);
  }
  await scroller.evaluate((element) => {
    element.style.removeProperty("flex");
    element.style.removeProperty("height");
    window.dispatchEvent(new Event("resize"));
  });

  await scroller.evaluate((element) => {
    element.scrollTop = 199 * 29;
  });
  const finalCellInBlock = page.locator('[data-grid-row="199"][data-grid-column="0"]');
  await finalCellInBlock.waitFor();
  await finalCellInBlock.focus();
  await waitForFocusedGridCell(page, 199, 0);
  await page.keyboard.press("ArrowDown");
  await waitForFocusedGridCell(page, 200, 0);
  await page.waitForFunction(() =>
    globalThis.openWranglerMessages.some(
      (message) =>
        message.kind === "runtimeRequest" && message.request?.kind === "getPage" && message.request.offset === 200
    )
  );

  await scroller.evaluate((element) => {
    element.scrollTop = 230 * 29;
    element.scrollLeft = 3000;
    element.dispatchEvent(new Event("scroll"));
  });
  await page.waitForFunction(() => {
    const roving = document.querySelectorAll('td[tabindex="0"]');
    return roving.length === 1 && document.activeElement === roving[0];
  });
  const rovingCell = page.locator('td[tabindex="0"]');
  const rovingRow = Number(await rovingCell.getAttribute("data-grid-row"));
  const rovingColumn = Number(await rovingCell.getAttribute("data-grid-column"));
  if (rovingRow <= 200 || rovingColumn <= 0) {
    throw new Error(`Mouse virtualization left an unexpected roving cell at ${rovingRow}, ${rovingColumn}.`);
  }
  await page.keyboard.press("ArrowRight");
  await waitForFocusedGridCell(page, rovingRow, rovingColumn + 1);

  await assertProjectedHarnessClean(page, "wide-grid keyboard workflow");
  await page.close();
  console.log(
    "Grid arrows, two-dimensional projected paging, exact far-column rendering, and cross-block focus verified."
  );
}

async function assertProjectedHarnessClean(page, label) {
  const errors = await page.evaluate(() => [...globalThis.openWranglerHarnessErrors]);
  if (errors.length) throw new Error(`${label} reported projected-page fixture errors: ${errors.join(" ")}`);
}

async function resetDraftHarness(page) {
  await page.reload({ waitUntil: "load" });
  await page.getByRole("button", { name: "Apply step" }).waitFor();
}

async function showAppliedStep(page) {
  await page.evaluate(() => {
    const payload = globalThis.openWranglerSessionPayload;
    const step = payload.metadata.draftStep;
    const metadata = { ...payload.metadata, draftStep: undefined, steps: [step] };
    window.dispatchEvent(
      new MessageEvent("message", {
        data: { kind: "planUpdated", revision: metadata.revision, metadata, page: payload.page, code: payload.code },
        origin: window.location.origin
      })
    );
  });
}

async function waitForFocusedGridCell(page, row, column) {
  await page.waitForFunction(
    ({ expectedRow, expectedColumn }) => {
      const active = document.activeElement;
      return (
        active instanceof HTMLElement &&
        active.dataset.gridRow === String(expectedRow) &&
        active.dataset.gridColumn === String(expectedColumn)
      );
    },
    { expectedRow: row, expectedColumn: column }
  );
}

async function focusedGridRow(page) {
  return page.evaluate(() => Number(document.activeElement?.getAttribute("data-grid-row")));
}

async function waitForRuntimeRequest(page, kind) {
  await page.waitForFunction(
    (requestKind) =>
      globalThis.openWranglerMessages.some(
        (message) => message.kind === "runtimeRequest" && message.request?.kind === requestKind
      ),
    kind
  );
}

async function waitForRuntimeRequestCount(page, kind, count) {
  await page.waitForFunction(
    ({ requestKind, minimum }) =>
      globalThis.openWranglerMessages.filter(
        (message) => message.kind === "runtimeRequest" && message.request?.kind === requestKind
      ).length >= minimum,
    { requestKind: kind, minimum: count }
  );
}

async function runtimeRequestCount(page, kind) {
  return page.evaluate(
    (requestKind) =>
      globalThis.openWranglerMessages.filter(
        (message) => message.kind === "runtimeRequest" && message.request?.kind === requestKind
      ).length,
    kind
  );
}

function percentile(values, ratio) {
  const ordered = [...values].sort((left, right) => left - right);
  return ordered[Math.max(0, Math.ceil(ordered.length * ratio) - 1)];
}
