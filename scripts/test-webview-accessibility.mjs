import { createRequire } from "node:module";
import { readdirSync } from "node:fs";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { chromium } from "playwright-core";
import { createAxeResultPublication, formatAxeFailureDetail } from "./accessibility-result-classification.mjs";
import { verifyGridClipboardBrowserAcceptance } from "./grid-clipboard-browser-acceptance.mjs";
import { verifyGridColumnHeaderBrowserAcceptance } from "./grid-column-header-browser-acceptance.mjs";
import { verifyGridStatusBarBrowserAcceptance } from "./grid-status-bar-browser-acceptance.mjs";
import { createWebviewBrowserIsolation, resolveWebviewBrowserExecutable } from "./webview-browser.mjs";

const root = resolve(import.meta.dirname, "..");
const harnessDir = resolve(root, "tmp", "screenshots");
const require = createRequire(import.meta.url);
const axePath = require.resolve("axe-core/axe.min.js");
const browserExecutable = resolveWebviewBrowserExecutable({ chromium });
const harnesses = readdirSync(harnessDir)
  .filter((file) => file.endsWith(".html"))
  .sort();

if (harnesses.length === 0) {
  throw new Error("No generated webview harnesses found. Run capture:screenshots first.");
}

const workspaceTmp = resolve(root, "tmp");
const browserIsolation = createWebviewBrowserIsolation({
  workspaceTmp,
  rootPrefix: "accessibility-browser-",
  aliasPrefix: "ow-a11y-"
});
let browser;
const axePublication = createAxeResultPublication(
  (receipt) => process.stdout.write(receipt),
  (receipt) => process.stderr.write(receipt)
);

try {
  browser = await chromium.launchPersistentContext(browserIsolation.createProfile("accessibility"), {
    ...(browserExecutable.explicitOverride ? { executablePath: browserExecutable.executablePath } : {}),
    headless: true,
    args: ["--no-sandbox", "--disable-dev-shm-usage", "--allow-file-access-from-files"],
    env: browserIsolation.childEnvironment,
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
    recordAxeScanResult(harness, result.violations);
    await page.close();
  }
  await verifyNotebookPreviewDisclosure(browser);
  await verifyCodePreviewOrigin(browser);
  await verifyCompactDraftReview(browser);
  await verifyColumnSearchEscapePropagation(browser);
  await verifyAppliedPlanToolbarLayout(browser);
  await verifyStepInspectionWorkflow(browser);
  await verifyFilterKeyboardWorkflow(browser);
  await verifyInsightsDrawerWorkflow(browser);
  await verifyGridStatusBarBrowserAcceptance(browser, harnessDir);
  await verifyGridColumnHeaderBrowserAcceptance(browser, harnessDir);
  await verifySessionModeDisclosure(browser);
  await verifyShortGridProfileResponsiveness(browser);
  await verifyGridClipboardBrowserAcceptance(browser, harnessDir);
  await verifyGridKeyboardWorkflow(browser);
  await verifyWideGridPerformance(browser);
} finally {
  try {
    await browser?.close();
  } finally {
    browserIsolation.cleanup();
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
  const previewText = await page.locator(".openwrangler-notebook").textContent();
  if (previewText?.includes("Run this cell again")) {
    throw new Error(`${harness} exposed stale rerun guidance for a saved preview.`);
  }
  const messages = await page.evaluate(() => globalThis.openWranglerNotebookMessages);
  if (messages.length !== 0) {
    throw new Error(`${harness} sent a renderer action for an unlinked saved preview.`);
  }
  await page.close();
  console.log("Notebook MIME v2 truncation disclosure and unlinked-preview behavior verified.");
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
          bufferId: "00000000-0000-4000-8000-000000000001",
          bufferVersion: 0,
          bufferInvalid: false,
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
          bufferId: "00000000-0000-4000-8000-000000000001",
          bufferVersion: 0,
          bufferInvalid: false,
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
          bufferId: "00000000-0000-4000-8000-000000000001",
          bufferVersion: 0,
          bufferInvalid: false,
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
          bufferId: "00000000-0000-4000-8000-000000000001",
          bufferVersion: 0,
          bufferInvalid: false,
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
          bufferId: "00000000-0000-4000-8000-000000000001",
          bufferVersion: 0,
          bufferInvalid: false,
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
          bufferId: "00000000-0000-4000-8000-000000000001",
          bufferVersion: 0,
          bufferInvalid: false,
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

    await page
      .getByRole("img", { name: /numeric distribution/u })
      .first()
      .waitFor();
    await page
      .getByRole("group", { name: /boolean distribution/u })
      .first()
      .waitFor();
    for (const name of [/categorical distribution/u, /datetime distribution/u]) {
      const charts = page.getByRole("img", { name });
      await charts.first().waitFor();
    }
    await page.getByText("True 4", { exact: true }).waitFor();
    await page.getByText("False 2", { exact: true }).waitFor();
    await page.getByText("Min 1", { exact: true }).waitFor();
    await page.getByText("Max 6", { exact: true }).waitFor();

    const numericChart = page.getByRole("img", { name: /numeric distribution/u }).first();
    const histogram = numericChart.locator("xpath=../..");
    const firstBar = histogram.locator(".numericHistogramBar").first();
    const status = histogram.locator(".miniChartCaption");
    const restingStatus = (await status.textContent())?.trim();
    await firstBar.evaluate((bar) => {
      const chartHeight = bar.ownerSVGElement?.viewBox.baseVal.height;
      if (!chartHeight) throw new Error("Histogram bar has no owning SVG view box.");
      bar.setAttribute("height", "2");
      bar.setAttribute("y", String(chartHeight - 2));
    });
    const [chartBounds, firstBarBounds] = await Promise.all([numericChart.boundingBox(), firstBar.boundingBox()]);
    if (!chartBounds || !firstBarBounds || firstBarBounds.height > chartBounds.height * 0.08) {
      throw new Error(
        `${harness} did not preserve a hoverable chart above a two-pixel bar: ` +
          `${JSON.stringify({ chartBounds, firstBarBounds })}.`
      );
    }
    const initialFill = await firstBar.evaluate((bar) => getComputedStyle(bar).fill);
    await numericChart.hover({ position: { x: firstBarBounds.width / 2, y: 1 } });
    const firstLabel = (await status.textContent())?.trim();
    if (!firstLabel?.includes("row")) {
      throw new Error(`${harness} did not show the hovered bin's exact interval and row count immediately.`);
    }
    const visibleDistribution = await histogram.evaluate((element) => {
      const chart = element.querySelector(".miniChart");
      const caption = element.querySelector(".miniChartCaption");
      const bars = [...element.querySelectorAll(".numericHistogramBar")];
      if (!chart || !caption) return undefined;
      const chartBounds = chart.getBoundingClientRect();
      const captionBounds = caption.getBoundingClientRect();
      return {
        activeBins: element.querySelectorAll(".numericHistogramBin.active").length,
        captionBelowChart: captionBounds.top >= chartBounds.bottom - 1,
        totalBars: bars.length,
        visibleBars: bars.filter((bar) => {
          const bounds = bar.getBoundingClientRect();
          const style = getComputedStyle(bar);
          return bounds.width > 0 && bounds.height > 0 && style.display !== "none" && style.visibility !== "hidden";
        }).length
      };
    });
    if (
      !visibleDistribution ||
      visibleDistribution.activeBins !== 1 ||
      !visibleDistribution.captionBelowChart ||
      visibleDistribution.totalBars === 0 ||
      visibleDistribution.visibleBars !== visibleDistribution.totalBars ||
      (await histogram.getByRole("tooltip").count()) !== 0
    ) {
      throw new Error(
        `${harness} did not keep the complete distribution visible above its active-bin status: ` +
          `${JSON.stringify(visibleDistribution)}.`
      );
    }
    const hoveredFill = await firstBar.evaluate((bar) => getComputedStyle(bar).fill);
    if (hoveredFill === initialFill) {
      throw new Error(`${harness} did not visibly highlight the hovered histogram bin.`);
    }
    await page.locator(".backendBadge").first().hover();
    if ((await status.textContent())?.trim() !== restingStatus) {
      throw new Error(`${harness} did not restore its range caption after histogram hover.`);
    }
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
      await numericChart.hover({ position: { x: firstBarBounds.width / 2, y: 1 } });
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

  const interactivePage = await browser.newPage({ viewport: { width: 1280, height: 760 } });
  const interactiveHarness = "grid-view.html";
  await interactivePage.goto(pathToFileURL(resolve(harnessDir, interactiveHarness)).href, { waitUntil: "load" });
  const interactiveHistogram = interactivePage.getByRole("group", { name: /numeric distribution/u }).first();
  await interactiveHistogram.waitFor();
  const histogramControl = interactiveHistogram.locator(".numericHistogramHitTarget");
  if ((await histogramControl.count()) !== 1) {
    throw new Error(`${interactiveHarness} did not expose exactly one full-chart histogram control.`);
  }
  const [interactiveChartBounds, histogramControlBounds] = await Promise.all([
    interactiveHistogram.locator(".miniChart").boundingBox(),
    histogramControl.boundingBox()
  ]);
  if (
    !interactiveChartBounds ||
    !histogramControlBounds ||
    histogramControlBounds.width < interactiveChartBounds.width - 1 ||
    histogramControlBounds.width > interactiveChartBounds.width + 1 ||
    histogramControlBounds.height < interactiveChartBounds.height - 1 ||
    histogramControlBounds.height > interactiveChartBounds.height + 1
  ) {
    throw new Error(
      `${interactiveHarness} did not stretch its one pointer target across the complete histogram: ` +
        `${JSON.stringify({ interactiveChartBounds, histogramControlBounds })}.`
    );
  }
  await histogramControl.hover({ position: { x: histogramControlBounds.width / 40, y: 1 } });
  const pointerHoverState = await interactiveHistogram.evaluate((element) => {
    const control = element.querySelector(".numericHistogramHitTarget");
    const bars = [...element.querySelectorAll(".numericHistogramBar")];
    if (!control) return undefined;
    return {
      activeBins: element.querySelectorAll(".numericHistogramBin.active").length,
      controlBackground: getComputedStyle(control).backgroundColor,
      totalBars: bars.length
    };
  });
  const pointerStatus = (await interactiveHistogram.locator(".miniChartCaption").textContent())?.trim();
  if (
    !pointerHoverState ||
    pointerHoverState.activeBins !== 1 ||
    !["rgba(0, 0, 0, 0)", "transparent"].includes(pointerHoverState.controlBackground) ||
    pointerHoverState.totalBars === 0 ||
    !pointerStatus?.includes("row")
  ) {
    throw new Error(
      `${interactiveHarness} painted its full-chart pointer target over the histogram distribution: ` +
        `${JSON.stringify({ pointerHoverState, pointerStatus })}.`
    );
  }
  const firstLabel = await histogramControl.getAttribute("aria-label");
  await histogramControl.focus();
  const interactiveStatus = interactiveHistogram.locator(".miniChartCaption");
  const firstStatus = (await interactiveStatus.textContent())?.trim();
  if (
    !firstLabel ||
    !firstStatus?.includes("row") ||
    !firstLabel.startsWith(firstStatus) ||
    (await interactiveStatus.getAttribute("role")) !== null ||
    (await interactiveStatus.getAttribute("aria-live")) !== null ||
    (await interactiveHistogram.getByRole("tooltip").count()) !== 0
  ) {
    throw new Error(`${interactiveHarness} did not expose the focused bin exactly without a noisy live region.`);
  }
  await interactivePage.keyboard.press("End");
  const lastLabel = await histogramControl.getAttribute("aria-label");
  const lastStatus = (await interactiveStatus.textContent())?.trim();
  if (!lastLabel || !lastStatus || lastLabel === firstLabel || !lastLabel.startsWith(lastStatus)) {
    throw new Error(`${interactiveHarness} did not move the histogram control to its final bin with End.`);
  }
  await interactivePage.keyboard.press("Home");
  if ((await histogramControl.getAttribute("aria-label")) !== firstLabel) {
    throw new Error(`${interactiveHarness} did not return the histogram control to its first bin with Home.`);
  }
  await interactivePage.keyboard.press("ArrowRight");
  if (!(await histogramControl.evaluate(isActiveTab))) {
    throw new Error(`${interactiveHarness} moved focus away while changing histogram bins with ArrowRight.`);
  }
  const nextLabel = await histogramControl.getAttribute("aria-label");
  const nextStatus = (await interactiveStatus.textContent())?.trim();
  if (!nextLabel || !nextStatus || !nextLabel.startsWith(nextStatus)) {
    throw new Error(`${interactiveHarness} did not update the status for the next keyboard-selected bin.`);
  }
  await interactivePage.keyboard.press("ArrowLeft");
  if ((await histogramControl.getAttribute("aria-label")) !== firstLabel) {
    throw new Error(`${interactiveHarness} did not return to the previous bin with ArrowLeft.`);
  }
  await interactivePage.close();

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

async function verifySessionModeDisclosure(browser) {
  const page = await browser.newPage();
  await page.setViewportSize({ width: 700, height: 760 });
  await page.emulateMedia({ forcedColors: "active" });
  await page.goto(pathToFileURL(resolve(harnessDir, "wide-view.html")).href, { waitUntil: "load" });
  await page.getByText("wide.csv", { exact: true }).waitFor();
  await page.evaluate(() => {
    const payload = globalThis.openWranglerSessionPayload;
    if (!payload || payload.kind !== "sessionOpened") {
      throw new Error("The live Editing disclosure fixture did not expose its source session payload.");
    }
    const firstColumn = payload.metadata.schema[0];
    if (!firstColumn) throw new Error("The live Editing disclosure fixture requires one column.");
    const metadata = {
      ...payload.metadata,
      backend: "pandas",
      mode: "editing",
      source: {
        kind: "notebookVariable",
        label: "live_orders",
        variableName: "live_orders",
        uri: "file:///workspace/live-orders.ipynb"
      },
      capabilities: { ...payload.metadata.capabilities, editable: true, notebookInsert: true },
      steps: [
        {
          id: "accepted-sort",
          kind: "sortRows",
          params: {
            rules: [
              {
                column: { id: firstColumn.id, name: firstColumn.name },
                direction: "asc",
                nulls: "last"
              }
            ]
          }
        }
      ]
    };
    globalThis.dispatchEvent(
      new MessageEvent("message", {
        data: { ...payload, metadata },
        origin: globalThis.location.origin
      })
    );
  });

  const reverseAction = page.getByRole("button", { name: "Switch to Viewing", exact: true });
  await reverseAction.waitFor();
  if (
    !(await reverseAction.isDisabled()) ||
    !(await reverseAction.getAttribute("title"))?.includes("Undo the applied step")
  ) {
    throw new Error("The live Editing disclosure fixture did not expose its blocked reverse transition.");
  }

  await page.locator('[data-session-badge="mode"]').click();
  const modeHelp = page.locator(".sessionModeHelpText");
  await modeHelp.waitFor({ state: "visible" });
  const layout = await modeHelp.evaluate((help) => {
    const bounds = help.getBoundingClientRect();
    const toolbar = help.closest(".toolbarActions")?.getBoundingClientRect();
    return {
      left: bounds.left,
      right: bounds.right,
      width: bounds.width,
      viewportWidth: window.innerWidth,
      withinToolbar: Boolean(toolbar && bounds.left >= toolbar.left - 1 && bounds.right <= toolbar.right + 1),
      documentOverflow: document.documentElement.scrollWidth - document.documentElement.clientWidth,
      text: help.textContent?.trim() ?? ""
    };
  });
  if (
    layout.left < -1 ||
    layout.right > layout.viewportWidth + 1 ||
    layout.width <= 0 ||
    !layout.withinToolbar ||
    layout.documentOverflow > 1 ||
    !layout.text.includes("Open Wrangler keeps the source unchanged") ||
    !layout.text.includes("Undo the applied step")
  ) {
    throw new Error(
      `The opened live Editing explanation escaped the 700px forced-colors toolbar: ${JSON.stringify(layout)}.`
    );
  }
  await page.emulateMedia({ forcedColors: "none" });
  await page.addScriptTag({ path: axePath });
  await scanPageAccessibility(page, "wide-view.html (700px blocked reverse-mode explanation)");
  await page.close();
  console.log("Live Editing blocked reverse action, compact opened explanation, and forced colors verified.");
}

async function verifyShortGridProfileResponsiveness(browser) {
  const shortViewport = { width: 435, height: 300 };
  const page = await browser.newPage();
  await page.setViewportSize(shortViewport);
  await page.goto(pathToFileURL(resolve(harnessDir, "wide-view.html")).href, { waitUntil: "load" });
  const headerProfiles = page.getByRole("button", { name: "Header profiles", exact: true });
  await page.locator(".columnInsight.compact .exactSummaryStats").first().waitFor();
  await page.waitForFunction(() => {
    const distributions = [...document.querySelectorAll(".summaryDistribution")];
    return (
      distributions.length > 0 &&
      distributions.every((distribution) => getComputedStyle(distribution).display === "none")
    );
  });

  const initial = await shortGridProfileState(page);
  if (
    initial.profilePreference !== "true" ||
    initial.profileDescription !==
      "Header profile distributions are temporarily hidden until the grid has enough room." ||
    initial.profileStatusName !== "Header profile layout" ||
    initial.profileStatusCount !== 1 ||
    initial.profileStatusText !== initial.profileDescription ||
    initial.profileTitle !== initial.profileDescription ||
    initial.insightCount === 0 ||
    initial.compactInsightCount !== initial.insightCount ||
    initial.visibleDistributionCount !== 0 ||
    !initial.exposedCell ||
    !initial.exposedCell.centerHitsCell ||
    !initial.exposedCell.fullyExposedVertically ||
    !initial.exposedCell.rowFullyExposedVertically ||
    !initial.exposedCell.hasRightNeighbor
  ) {
    throw new Error(
      `The 435x300 production grid did not compact distributions while retaining an exposed body target: ${JSON.stringify(initial)}.`
    );
  }

  const exposedCell = page.locator(
    `td[data-grid-row="${initial.exposedCell.row}"][data-grid-column="${initial.exposedCell.column}"]`
  );
  await exposedCell.click();
  await waitForFocusedGridCell(page, initial.exposedCell.row, initial.exposedCell.column);
  await page.keyboard.press("ArrowRight");
  await waitForFocusedGridCell(page, initial.exposedCell.row, initial.exposedCell.column + 1);

  await page.setViewportSize({ width: shortViewport.width, height: 760 });
  await page.waitForFunction(() => {
    const distributions = [...document.querySelectorAll(".summaryDistribution")];
    return (
      document.querySelectorAll(".columnInsight").length > 0 &&
      document.querySelectorAll(".columnInsight.compact").length === 0 &&
      distributions.some((distribution) => getComputedStyle(distribution).display !== "none")
    );
  });
  const tall = await shortGridProfileState(page);
  if (
    tall.profilePreference !== "true" ||
    tall.profileDescription !== undefined ||
    tall.profileStatusCount !== 1 ||
    tall.profileStatusText !== "Header profile distributions are visible again." ||
    tall.compactInsightCount !== 0 ||
    tall.visibleDistributionCount === 0
  ) {
    throw new Error(
      `A taller production grid did not restore requested profile distributions: ${JSON.stringify(tall)}.`
    );
  }

  const distributionControl = page.locator(".numericHistogramHitTarget").first();
  await distributionControl.waitFor();
  await distributionControl.focus();
  if (!(await distributionControl.evaluate((element) => document.activeElement === element))) {
    throw new Error("The restored numeric header distribution could not receive focus before compaction.");
  }
  await page.setViewportSize(shortViewport);
  await page.waitForFunction(() => {
    const insights = [...document.querySelectorAll(".columnInsight")];
    const distributions = [...document.querySelectorAll(".summaryDistribution")];
    return (
      insights.length > 0 &&
      insights.every((insight) => insight.classList.contains("compact")) &&
      distributions.every((distribution) => getComputedStyle(distribution).display === "none")
    );
  });
  const compactAgain = await shortGridProfileState(page);
  if (
    compactAgain.profilePreference !== "true" ||
    !compactAgain.headerProfilesFocused ||
    compactAgain.profileStatusCount !== 1 ||
    compactAgain.profileStatusText !==
      "Header profile distributions are temporarily hidden until the grid has enough room." ||
    compactAgain.insightCount === 0 ||
    compactAgain.compactInsightCount !== compactAgain.insightCount ||
    compactAgain.visibleDistributionCount !== 0 ||
    !compactAgain.exposedCell?.centerHitsCell ||
    !compactAgain.exposedCell.fullyExposedVertically ||
    !compactAgain.exposedCell.rowFullyExposedVertically
  ) {
    throw new Error(
      `The production grid did not compact stably after a second short resize: ${JSON.stringify(compactAgain)}.`
    );
  }

  await page.addScriptTag({ path: axePath });
  await scanPageAccessibility(page, "wide-view.html (435x300 compact header profiles)");
  await headerProfiles.click();
  await page.waitForFunction(() => {
    const toggle = document.querySelector(".headerProfilesButton");
    return toggle?.getAttribute("aria-pressed") === "false" && !document.querySelector(".columnInsight");
  });
  await page.setViewportSize({ width: shortViewport.width, height: 760 });
  await page.waitForFunction(
    () =>
      document.querySelector(".headerProfilesButton")?.getAttribute("aria-pressed") === "false" &&
      !document.querySelector(".columnInsight")
  );
  const disabledAfterResize = await shortGridProfileState(page);
  if (
    disabledAfterResize.profilePreference !== "false" ||
    disabledAfterResize.profileDescription !== undefined ||
    disabledAfterResize.insightCount !== 0 ||
    disabledAfterResize.visibleDistributionCount !== 0
  ) {
    throw new Error(
      `Turning header profiles off in a short grid did not persist across a taller resize: ${JSON.stringify(disabledAfterResize)}.`
    );
  }

  await assertProjectedHarnessClean(page, "short-grid profile responsiveness");
  await page.close();
  console.log(
    "Short-grid profile compaction, exposed pointer/ArrowRight activation, focus transfer, live resize status, and retained preference verified."
  );
}

async function shortGridProfileState(page) {
  return page.evaluate(() => {
    const scroller = document.querySelector("[data-testid='data-grid-scroller']");
    const toggle = document.querySelector(".headerProfilesButton");
    if (!(scroller instanceof HTMLElement) || !(toggle instanceof HTMLButtonElement)) {
      throw new Error("The production grid did not expose its scroller and Header profiles toggle.");
    }
    const scrollerRect = scroller.getBoundingClientRect();
    const headerBottom = Math.max(
      scrollerRect.top,
      ...[...scroller.querySelectorAll("thead th")].map((header) => header.getBoundingClientRect().bottom)
    );
    const profileDescriptionId = toggle.getAttribute("aria-describedby");
    const distributions = [...scroller.querySelectorAll(".summaryDistribution")];
    const cells = [...scroller.querySelectorAll("td[data-grid-row][data-grid-column]")];
    const exposedCell = cells.flatMap((cell) => {
      if (!(cell instanceof HTMLElement)) return [];
      const row = Number(cell.dataset.gridRow);
      const column = Number(cell.dataset.gridColumn);
      const rightNeighbor = scroller.querySelector(`td[data-grid-row="${row}"][data-grid-column="${column + 1}"]`);
      const bounds = cell.getBoundingClientRect();
      const rowBounds = cell.closest("tr")?.getBoundingClientRect();
      const centerX = bounds.left + bounds.width / 2;
      const centerY = bounds.top + bounds.height / 2;
      const centerHit = document.elementFromPoint(centerX, centerY);
      const centerHitsCell = centerHit === cell || cell.contains(centerHit);
      const fullyExposedVertically = bounds.top >= headerBottom - 1 && bounds.bottom <= scrollerRect.bottom + 1;
      const rowFullyExposedVertically = Boolean(
        rowBounds && rowBounds.top >= headerBottom - 1 && rowBounds.bottom <= scrollerRect.bottom + 1
      );
      return centerX >= scrollerRect.left &&
        centerX <= scrollerRect.right &&
        centerY >= headerBottom &&
        centerY <= scrollerRect.bottom &&
        centerHitsCell &&
        rightNeighbor instanceof HTMLElement
        ? [
            {
              bottom: bounds.bottom,
              centerHitsCell,
              column,
              fullyExposedVertically,
              hasRightNeighbor: true,
              row,
              rowBottom: rowBounds?.bottom,
              rowFullyExposedVertically,
              rowTop: rowBounds?.top,
              top: bounds.top
            }
          ]
        : [];
    })[0];
    return {
      compactInsightCount: scroller.querySelectorAll(".columnInsight.compact").length,
      exposedCell,
      headerBottom,
      insightCount: scroller.querySelectorAll(".columnInsight").length,
      headerProfilesFocused: document.activeElement === toggle,
      profileDescription: profileDescriptionId
        ? document.getElementById(profileDescriptionId)?.textContent?.trim()
        : undefined,
      profilePreference: toggle.getAttribute("aria-pressed"),
      profileStatusCount: document.querySelectorAll(".headerProfilesFitStatus").length,
      profileStatusName: document.querySelector(".headerProfilesFitStatus")?.getAttribute("aria-label"),
      profileStatusText: document.querySelector(".headerProfilesFitStatus")?.textContent?.trim(),
      profileTitle: toggle.getAttribute("title") ?? undefined,
      scrollerBottom: scrollerRect.bottom,
      scrollerHeight: scroller.clientHeight,
      visibleDistributionCount: distributions.filter((distribution) => {
        const bounds = distribution.getBoundingClientRect();
        return getComputedStyle(distribution).display !== "none" && bounds.width > 0 && bounds.height > 0;
      }).length
    };
  });
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
  recordAxeScanResult(harness, result.violations);
}

function isActiveTab(element) {
  return element === document.activeElement;
}

const axeReport = axePublication.report();
printAxeMachineResult(axeReport);
if (axeReport.unapprovedFindingCount > 0) {
  throw new Error(`Webview accessibility scan failed:\n${formatAxeFailureDetail(axeReport)}`);
}

console.log(
  `Accessibility verified for ${axeReport.scanCount} scans across ${harnesses.length} production webview harnesses.`
);

function recordAxeScanResult(harness, violations) {
  const result = axePublication.record({ harness, violations });
  if (result.unapprovedFindingCount === 0) {
    console.log(`Accessibility verified: ${harness}`);
  }
}

function printAxeMachineResult(result) {
  axePublication.print(result);
}

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

async function verifyColumnSearchEscapePropagation(browser) {
  const page = await browser.newPage({ viewport: { width: 1280, height: 760 } });
  await page.goto(pathToFileURL(resolve(harnessDir, "draft-preview.html")).href, { waitUntil: "load" });
  await page.getByRole("button", { name: "Apply step" }).waitFor();
  const columnSearch = page.getByRole("combobox", { name: "Column" });
  await columnSearch.focus();
  const columnSearchResults = page.getByRole("listbox", { name: "Matching columns" });
  await columnSearchResults.waitFor();
  const discardCount = await runtimeRequestCount(page, "discardDraft");
  await page.keyboard.press("Escape");
  await columnSearchResults.waitFor({ state: "hidden" });
  if ((await runtimeRequestCount(page, "discardDraft")) !== discardCount) {
    throw new Error("Closing column search with Escape also discarded the draft.");
  }
  await page.keyboard.press("Escape");
  await waitForRuntimeRequestCount(page, "discardDraft", discardCount + 1);

  await page.close();
  console.log("Column-search Escape propagation verified.");
}

async function verifyAppliedPlanToolbarLayout(browser) {
  const cases = [
    { harness: "applied-plan.html", width: 1280, label: "wide" },
    { harness: "applied-plan.html", width: 620, label: "narrow" },
    { harness: "applied-plan.html", width: 320, label: "compact" },
    { harness: "applied-plan-dark-zoom-200.html", width: 1280, label: "200% zoom" },
    { harness: "applied-plan.html", width: 620, label: "forced colors", forcedColors: true }
  ];

  for (const { harness, width, label, forcedColors = false } of cases) {
    console.log(`Applied-plan toolbar checking: ${harness} (${label}).`);
    const page = await browser.newPage({ viewport: { width, height: 760 } });
    if (forcedColors) await page.emulateMedia({ forcedColors: "active" });
    await page.goto(pathToFileURL(resolve(harnessDir, harness)).href, { waitUntil: "load" });

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

  console.log("Applied cleaning-plan command row, responsive layout, forced colors, and tab order verified.");
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
  console.log("Applied-step diff, Escape clear, and local confirmed-grid restoration verified.");
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

  await page.locator('th[data-grid-column="0"] .exactSummaryStats').waitFor();
  const retainedCellScrollTop = 2 * 29;
  const narrowScrollerWidth = 280;
  const narrowGridState = await scroller.evaluate(
    (element, { scrollTop, width }) => {
      const previous = {
        clientWidth: element.clientWidth,
        cssText: element.style.cssText,
        scrollLeft: element.scrollLeft,
        scrollTop: element.scrollTop,
        width: element.getBoundingClientRect().width
      };
      element.style.alignSelf = "flex-start";
      element.style.maxWidth = `${width}px`;
      element.style.width = `${width}px`;
      element.scrollLeft = 0;
      element.scrollTop = scrollTop;
      element.dispatchEvent(new Event("scroll"));
      window.dispatchEvent(new Event("resize"));
      return previous;
    },
    { scrollTop: retainedCellScrollTop, width: narrowScrollerWidth }
  );
  await page.waitForFunction(
    ({ scrollTop, width }) => {
      const scroller = document.querySelector("[data-testid='data-grid-scroller']");
      return (
        scroller instanceof HTMLElement &&
        scroller.classList.contains("tableScroller") &&
        Math.abs(scroller.getBoundingClientRect().width - width) <= 1 &&
        scroller.clientWidth > 250 &&
        scroller.scrollLeft === 0 &&
        Math.abs(scroller.scrollTop - scrollTop) <= 1 &&
        document.querySelector('td[data-grid-row="0"][data-grid-column="0"]') instanceof HTMLElement &&
        document.querySelector('td[data-grid-row="4"][data-grid-column="0"]') instanceof HTMLElement &&
        document.querySelector('td[data-grid-row="4"][data-grid-column="1"]') instanceof HTMLElement
      );
    },
    { scrollTop: retainedCellScrollTop, width: narrowScrollerWidth }
  );
  const retainedCellGeometry = await page.evaluate(() => {
    const retained = document.querySelector('td[data-grid-row="0"][data-grid-column="0"]');
    const exposed = document.querySelector('td[data-grid-row="4"][data-grid-column="0"]');
    const rightNeighbor = document.querySelector('td[data-grid-row="4"][data-grid-column="1"]');
    const header = document.querySelector('th[data-grid-column="0"]');
    const rowHeader = exposed?.closest("tr")?.querySelector('[role="rowheader"]');
    const scroller = document.querySelector("[data-testid='data-grid-scroller']");
    if (
      !(retained instanceof HTMLElement) ||
      !(exposed instanceof HTMLElement) ||
      !(rightNeighbor instanceof HTMLElement) ||
      !(header instanceof HTMLElement) ||
      !(rowHeader instanceof HTMLElement) ||
      !(scroller instanceof HTMLElement)
    ) {
      return undefined;
    }
    const retainedRect = retained.getBoundingClientRect();
    const exposedRect = exposed.getBoundingClientRect();
    const rightNeighborRect = rightNeighbor.getBoundingClientRect();
    const headerRect = header.getBoundingClientRect();
    const rowHeaderRect = rowHeader.getBoundingClientRect();
    const scrollerRect = scroller.getBoundingClientRect();
    const dataViewportLeft = Math.max(scrollerRect.left, rowHeaderRect.right);
    const dataViewportRight = scrollerRect.left + scroller.clientWidth;
    const viewportBottom = scrollerRect.top + scroller.clientHeight;
    const retainedTopLeftHit = document.elementFromPoint(retainedRect.left + 8, retainedRect.top + 8);
    const exposedCenterHit = document.elementFromPoint(
      exposedRect.left + exposedRect.width / 2,
      exposedRect.top + exposedRect.height / 2
    );
    return {
      clickedCellFullyExposed:
        exposedRect.left >= dataViewportLeft - 1 &&
        exposedRect.right <= dataViewportRight + 1 &&
        exposedRect.top >= headerRect.bottom - 1 &&
        exposedRect.bottom <= viewportBottom + 1,
      dataViewportLeft,
      dataViewportRight,
      exposedCenterHitsCell: exposedCenterHit === exposed || exposed.contains(exposedCenterHit),
      exposedLeft: exposedRect.left,
      exposedRight: exposedRect.right,
      exposedTop: exposedRect.top,
      headerBottom: headerRect.bottom,
      retainedTopLeftHit: retainedTopLeftHit?.tagName,
      retainedTopLeftHitsHeader: retainedTopLeftHit === header || header.contains(retainedTopLeftHit),
      retainedTopLeftHitsCell: retainedTopLeftHit === retained || retained.contains(retainedTopLeftHit),
      retainedTop: retainedRect.top,
      rightNeighborClippedByRightEdge: rightNeighborRect.right > dataViewportRight + 1,
      rightNeighborFullyExposed:
        rightNeighborRect.left >= dataViewportLeft - 1 && rightNeighborRect.right <= dataViewportRight + 1,
      rightNeighborLeft: rightNeighborRect.left,
      rightNeighborRight: rightNeighborRect.right,
      scrollLeft: scroller.scrollLeft,
      usesProductionScroller: scroller.classList.contains("tableScroller")
    };
  });
  if (
    !retainedCellGeometry ||
    !retainedCellGeometry.usesProductionScroller ||
    retainedCellGeometry.scrollLeft !== 0 ||
    retainedCellGeometry.retainedTopLeftHitsCell ||
    !retainedCellGeometry.retainedTopLeftHitsHeader ||
    !retainedCellGeometry.clickedCellFullyExposed ||
    !retainedCellGeometry.exposedCenterHitsCell ||
    retainedCellGeometry.exposedTop < retainedCellGeometry.headerBottom ||
    !retainedCellGeometry.rightNeighborClippedByRightEdge ||
    retainedCellGeometry.rightNeighborFullyExposed
  ) {
    throw new Error(
      `The narrow production grid did not retain an occluded first row beside an exposed click target and clipped rendered neighbor: ${JSON.stringify(retainedCellGeometry)}.`
    );
  }

  const stickyProfileScrollTop = await scroller.evaluate((element) => {
    const header = element.querySelector('th[data-grid-column="0"]');
    if (!(header instanceof HTMLElement)) throw new Error("The production grid did not expose its first header.");
    element.scrollTop = Math.ceil(header.getBoundingClientRect().height) + 29;
    element.dispatchEvent(new Event("scroll"));
    return element.scrollTop;
  });
  await page.waitForFunction((scrollTop) => {
    const element = document.querySelector("[data-testid='data-grid-scroller']");
    return element instanceof HTMLElement && Math.abs(element.scrollTop - scrollTop) <= 1;
  }, stickyProfileScrollTop);
  const stickyHistogram = page.locator('th[data-grid-column="0"] .numericHistogram').first();
  const stickyHistogramControl = stickyHistogram.locator(".numericHistogramHitTarget");
  await stickyHistogramControl.waitFor();
  const stickyProfileGeometry = await page.evaluate(() => {
    const scroller = document.querySelector("[data-testid='data-grid-scroller']");
    const header = document.querySelector('th[data-grid-column="0"]');
    const cornerHeader = document.querySelector("thead th.rowHeader");
    const bodyRowHeader = document.querySelector("tbody [role='rowheader']");
    const insight = header?.querySelector(".columnInsight");
    const metrics = header?.querySelector(".exactSummaryStats");
    const chart = header?.querySelector(".miniChart");
    const caption = header?.querySelector(".miniChartCaption");
    const bars = [...(header?.querySelectorAll(".numericHistogramBar") ?? [])];
    if (
      !(scroller instanceof HTMLElement) ||
      !(header instanceof HTMLElement) ||
      !(cornerHeader instanceof HTMLElement) ||
      !(bodyRowHeader instanceof HTMLElement) ||
      !(insight instanceof HTMLElement) ||
      !(metrics instanceof HTMLElement) ||
      !(chart instanceof SVGElement) ||
      !(caption instanceof HTMLElement)
    ) {
      return undefined;
    }
    const headerBounds = header.getBoundingClientRect();
    const scrollerBounds = scroller.getBoundingClientRect();
    const profileElements = [insight, metrics, chart, caption];
    const bodyCells = [...scroller.querySelectorAll("td[data-grid-row][data-grid-column]")];
    const regions = [metrics, chart, caption].map((element) => {
      const bounds = element.getBoundingClientRect();
      const x = Math.min(bounds.right - 1, Math.max(bounds.left + 1, bounds.left + bounds.width / 2));
      const y = Math.min(bounds.bottom - 1, Math.max(bounds.top + 1, bounds.top + bounds.height / 2));
      const layers = document.elementsFromPoint(x, y);
      const topTableCell = layers.map((layer) => layer.closest("th, td")).find(Boolean);
      return {
        bodyCellBehind: bodyCells.some((cell) => {
          const cellBounds = cell.getBoundingClientRect();
          return x >= cellBounds.left && x <= cellBounds.right && y >= cellBounds.top && y <= cellBounds.bottom;
        }),
        topCellIsHeader: topTableCell === header
      };
    });
    const style = getComputedStyle(header);
    const cornerStyle = getComputedStyle(cornerHeader);
    const rowHeaderStyle = getComputedStyle(bodyRowHeader);
    return {
      allProfileContentClippedToHeader: profileElements.every((element) => {
        const bounds = element.getBoundingClientRect();
        return (
          bounds.left >= headerBounds.left - 1 &&
          bounds.right <= headerBounds.right + 1 &&
          bounds.top >= headerBounds.top - 1 &&
          bounds.bottom <= headerBounds.bottom + 1
        );
      }),
      backgroundColor: style.backgroundColor,
      backgroundImage: style.backgroundImage,
      bodyRowsPassBehindProfile: regions.some((region) => region.bodyCellBehind),
      cornerBackgroundColor: cornerStyle.backgroundColor,
      cornerBackgroundImage: cornerStyle.backgroundImage,
      cornerAboveHeader: Number.parseInt(cornerStyle.zIndex, 10) > Number.parseInt(style.zIndex, 10),
      headerAboveBodyRowHeader: Number.parseInt(style.zIndex, 10) > Number.parseInt(rowHeaderStyle.zIndex, 10),
      headerInsideScroller:
        headerBounds.top >= scrollerBounds.top - 1 && headerBounds.bottom <= scrollerBounds.bottom + 1,
      isolation: style.isolation,
      overflowX: style.overflowX,
      overflowY: style.overflowY,
      regions,
      totalBars: bars.length,
      visibleBars: bars.filter((bar) => {
        const bounds = bar.getBoundingClientRect();
        const barStyle = getComputedStyle(bar);
        return bounds.width > 0 && bounds.height > 0 && barStyle.display !== "none" && barStyle.visibility !== "hidden";
      }).length
    };
  });
  if (
    !stickyProfileGeometry ||
    !stickyProfileGeometry.allProfileContentClippedToHeader ||
    !stickyProfileGeometry.bodyRowsPassBehindProfile ||
    !stickyProfileGeometry.headerAboveBodyRowHeader ||
    !stickyProfileGeometry.headerInsideScroller ||
    stickyProfileGeometry.backgroundColor === "rgba(0, 0, 0, 0)" ||
    stickyProfileGeometry.backgroundColor === "transparent" ||
    stickyProfileGeometry.backgroundImage === "none" ||
    stickyProfileGeometry.cornerBackgroundColor === "rgba(0, 0, 0, 0)" ||
    stickyProfileGeometry.cornerBackgroundColor === "transparent" ||
    stickyProfileGeometry.cornerBackgroundImage === "none" ||
    !stickyProfileGeometry.cornerAboveHeader ||
    stickyProfileGeometry.isolation !== "isolate" ||
    stickyProfileGeometry.overflowX !== "clip" ||
    stickyProfileGeometry.overflowY !== "clip" ||
    stickyProfileGeometry.totalBars === 0 ||
    stickyProfileGeometry.visibleBars !== stickyProfileGeometry.totalBars ||
    stickyProfileGeometry.regions.some((region) => !region.topCellIsHeader)
  ) {
    throw new Error(
      `The narrow scrolled production grid did not keep its complete profile opaque, clipped, and above body rows: ${JSON.stringify(stickyProfileGeometry)}.`
    );
  }

  const assertStickyHistogramMode = async (mode) => {
    const controlBounds = await stickyHistogramControl.boundingBox();
    if (!controlBounds) throw new Error(`The scrolled ${mode} histogram control had no bounds.`);
    await stickyHistogramControl.hover({ position: { x: controlBounds.width / 3, y: 1 } });
    const state = await stickyHistogram.evaluate((element) => {
      const control = element.querySelector(".numericHistogramHitTarget");
      const caption = element.querySelector(".miniChartCaption");
      const bars = [...element.querySelectorAll(".numericHistogramBar")];
      if (!(control instanceof HTMLButtonElement) || !(caption instanceof HTMLElement)) return undefined;
      const status = caption.textContent?.trim() ?? "";
      return {
        activeBins: element.querySelectorAll(".numericHistogramBin.active").length,
        ariaLabel: control.getAttribute("aria-label") ?? "",
        captionTitle: caption.getAttribute("title") ?? "",
        status,
        totalBars: bars.length,
        visibleBars: bars.filter((bar) => {
          const bounds = bar.getBoundingClientRect();
          const style = getComputedStyle(bar);
          return bounds.width > 0 && bounds.height > 0 && style.display !== "none" && style.visibility !== "hidden";
        }).length
      };
    });
    const usesSelectedMode =
      mode === "count" ? state?.status.includes("row") : state?.status.includes("%") && !state.status.includes("row");
    if (
      !state ||
      state.activeBins !== 1 ||
      state.totalBars === 0 ||
      state.visibleBars !== state.totalBars ||
      !usesSelectedMode ||
      !state.ariaLabel.startsWith(state.status) ||
      !state.captionTitle.startsWith(state.status)
    ) {
      throw new Error(
        `The narrow scrolled production grid did not align its ${mode} caption with the complete active histogram: ${JSON.stringify(state)}.`
      );
    }
  };
  const countToggle = page.getByRole("button", { name: "Show header profile counts", exact: true });
  const percentToggle = page.getByRole("button", { name: "Show header profile percentages", exact: true });
  if ((await countToggle.getAttribute("aria-pressed")) !== "true") {
    throw new Error("The scrolled production grid did not begin in count mode.");
  }
  await assertStickyHistogramMode("count");
  await percentToggle.click();
  if ((await percentToggle.getAttribute("aria-pressed")) !== "true") {
    throw new Error("The scrolled production grid did not enter percentage mode.");
  }
  await assertStickyHistogramMode("percent");
  await countToggle.click();
  await scroller.evaluate((element, scrollTop) => {
    element.scrollTop = scrollTop;
    element.dispatchEvent(new Event("scroll"));
  }, retainedCellScrollTop);
  await page.waitForFunction((scrollTop) => {
    const element = document.querySelector("[data-testid='data-grid-scroller']");
    return element instanceof HTMLElement && Math.abs(element.scrollTop - scrollTop) <= 1;
  }, retainedCellScrollTop);
  const exposedCell = page.locator('[data-grid-row="4"][data-grid-column="0"]');
  await exposedCell.click();
  await waitForFocusedGridCell(page, 4, 0);
  await page.keyboard.press("ArrowRight");
  await waitForFocusedGridCell(page, 4, 1);
  const revealedNeighborGeometry = await page.evaluate(() => {
    const neighbor = document.querySelector('td[data-grid-row="4"][data-grid-column="1"]');
    const header = document.querySelector('th[data-grid-column="1"]');
    const rowHeader = neighbor?.closest("tr")?.querySelector('[role="rowheader"]');
    const scroller = document.querySelector("[data-testid='data-grid-scroller']");
    if (
      !(neighbor instanceof HTMLElement) ||
      !(header instanceof HTMLElement) ||
      !(rowHeader instanceof HTMLElement) ||
      !(scroller instanceof HTMLElement)
    ) {
      return undefined;
    }
    const neighborRect = neighbor.getBoundingClientRect();
    const headerRect = header.getBoundingClientRect();
    const rowHeaderRect = rowHeader.getBoundingClientRect();
    const scrollerRect = scroller.getBoundingClientRect();
    const dataViewportLeft = Math.max(scrollerRect.left, rowHeaderRect.right);
    const dataViewportRight = scrollerRect.left + scroller.clientWidth;
    const viewportBottom = scrollerRect.top + scroller.clientHeight;
    const centerHit = document.elementFromPoint(
      neighborRect.left + neighborRect.width / 2,
      neighborRect.top + neighborRect.height / 2
    );
    return {
      centerHitsNeighbor: centerHit === neighbor || neighbor.contains(centerHit),
      focused: document.activeElement === neighbor,
      fullyExposed:
        neighborRect.left >= dataViewportLeft - 1 &&
        neighborRect.right <= dataViewportRight + 1 &&
        neighborRect.top >= headerRect.bottom - 1 &&
        neighborRect.bottom <= viewportBottom + 1,
      left: neighborRect.left,
      right: neighborRect.right,
      scrollLeft: scroller.scrollLeft
    };
  });
  if (
    !revealedNeighborGeometry ||
    !revealedNeighborGeometry.focused ||
    !revealedNeighborGeometry.fullyExposed ||
    !revealedNeighborGeometry.centerHitsNeighbor ||
    revealedNeighborGeometry.scrollLeft <= retainedCellGeometry.scrollLeft
  ) {
    throw new Error(
      `ArrowRight did not horizontally reveal and focus the initially clipped rendered neighbor: ${JSON.stringify(revealedNeighborGeometry)}.`
    );
  }

  await page.keyboard.press("Home");
  await waitForFocusedGridCell(page, 4, 0);
  await scroller.evaluate((element, previous) => {
    element.style.cssText = previous.cssText;
    element.scrollLeft = previous.scrollLeft;
    element.scrollTop = previous.scrollTop;
    element.dispatchEvent(new Event("scroll"));
    window.dispatchEvent(new Event("resize"));
  }, narrowGridState);
  await page.waitForFunction((previous) => {
    const scroller = document.querySelector("[data-testid='data-grid-scroller']");
    return (
      scroller instanceof HTMLElement &&
      Math.abs(scroller.getBoundingClientRect().width - previous.width) <= 1 &&
      Math.abs(scroller.clientWidth - previous.clientWidth) <= 1 &&
      Math.abs(scroller.scrollLeft - previous.scrollLeft) <= 1 &&
      Math.abs(scroller.scrollTop - previous.scrollTop) <= 1
    );
  }, narrowGridState);
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
    "Grid pointer activation below sticky profiles, narrow-neighbor ArrowRight reveal, two-dimensional projected paging, exact far-column rendering, and cross-block focus verified."
  );
}

async function assertProjectedHarnessClean(page, label) {
  const errors = await page.evaluate(() => [...globalThis.openWranglerHarnessErrors]);
  if (errors.length) throw new Error(`${label} reported projected-page fixture errors: ${errors.join(" ")}`);
}

async function waitForFocusedGridCell(page, row, column) {
  try {
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
  } catch (error) {
    const diagnostic = await page.evaluate(() => ({
      active: {
        column: document.activeElement?.getAttribute("data-grid-column") ?? null,
        row: document.activeElement?.getAttribute("data-grid-row") ?? null,
        tag: document.activeElement?.tagName ?? null
      },
      projectedResponses: globalThis.openWranglerProjectedResponses.slice(-8).map((response) => ({
        columnLimit: response.columnLimit,
        columnOffset: response.columnOffset,
        limit: response.limit,
        offset: response.offset,
        rowCount: response.rowWidths.length,
        viewRequestId: response.viewRequestId
      })),
      requests: globalThis.openWranglerMessages
        .filter((message) => message.kind === "runtimeRequest" && message.request?.kind === "getPage")
        .slice(-8)
        .map((message) => ({
          columnLimit: message.request.columnLimit,
          columnOffset: message.request.columnOffset,
          limit: message.request.limit,
          offset: message.request.offset,
          viewRequestId: message.request.viewRequestId
        })),
      rovingCells: [...document.querySelectorAll("td[tabindex='0']")].map((cell) => ({
        column: cell.getAttribute("data-grid-column"),
        row: cell.getAttribute("data-grid-row")
      })),
      status: document.querySelector("[aria-label='Visible rows']")?.textContent?.trim() ?? null
    }));
    throw new Error(`Grid focus did not reach row ${row}, column ${column}: ${JSON.stringify(diagnostic)}.`, {
      cause: error
    });
  }
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
