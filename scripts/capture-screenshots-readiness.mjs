import { createWebviewSelectorReadiness } from "./webview-browser.mjs";

export function createHeaderProfileScreenshotReadiness({ description, columnCount }) {
  if (typeof description !== "string" || description.trim() === "" || description.length > 200) {
    throw new TypeError("Webview readiness requires a concise non-empty description.");
  }
  if (!Number.isSafeInteger(columnCount) || columnCount < 1) {
    throw new TypeError("Header-profile screenshots require a positive exact column count.");
  }
  return Object.freeze({
    description,
    predicate: headerProfileScreenshotReadinessSatisfied,
    argument: Object.freeze({ columnCount })
  });
}

function headerProfileScreenshotReadinessSatisfied({ columnCount }, scope = globalThis) {
  const pageGlobal = scope.window ?? scope;
  const pageDocument = pageGlobal.document ?? scope.document;
  const errors = pageGlobal.openWranglerHarnessErrors;
  if (!Array.isArray(errors)) throw new Error("The webview readiness array openWranglerHarnessErrors is unavailable.");
  if (errors.length !== 0) throw new Error("The webview readiness array openWranglerHarnessErrors reported an error.");
  const headers = Array.from(pageDocument.querySelectorAll("th[data-grid-column]"));
  const scroller = pageDocument.querySelector('[data-testid="data-grid-scroller"]');
  const rowHeader = scroller?.querySelector("th.rowHeader");
  if (headers.length !== columnCount || !rowHeader || scroller.offsetWidth <= 0 || scroller.offsetHeight <= 0) {
    return false;
  }
  const bounds = scroller.getBoundingClientRect();
  // Rectangles include CSS zoom; scale client dimensions into the same space.
  const scaleX = bounds.width / scroller.offsetWidth;
  const scaleY = bounds.height / scroller.offsetHeight;
  const clientLeft = bounds.left + scroller.clientLeft * scaleX;
  const clientTop = bounds.top + scroller.clientTop * scaleY;
  const left = Math.max(0, clientLeft, rowHeader.getBoundingClientRect().right);
  const right = Math.min(pageGlobal.innerWidth, clientLeft + scroller.clientWidth * scaleX);
  const top = Math.max(0, clientTop);
  const bottom = Math.min(pageGlobal.innerHeight, clientTop + scroller.clientHeight * scaleY);
  if (right <= left || bottom <= top) return false;
  const visibleHeaders = headers.filter((header) => {
    const rect = header.getBoundingClientRect();
    return (
      rect.width > 0 &&
      rect.height > 0 &&
      rect.right > left &&
      rect.left < right &&
      rect.bottom > top &&
      rect.top < bottom
    );
  });
  return (
    visibleHeaders.length > 0 &&
    visibleHeaders.every((header) => {
      const profile = header.querySelector(":scope > .columnInsight:not(.emptyInsight)");
      return profile && !header.querySelector(".emptyInsight") && !profile.textContent.includes("Profiling…");
    })
  );
}

const FILTER_PANEL_READINESS_SELECTORS = Object.freeze([
  Object.freeze({
    selector:
      'button[aria-label="Column profiles and filters"][aria-expanded="true"][aria-controls="openwrangler-insights-panel"]',
    count: 1
  }),
  Object.freeze({
    selector: 'aside#openwrangler-insights-panel.sidebar[aria-label="Column profiles and filters"]',
    count: 1
  }),
  Object.freeze({
    selector: '#openwrangler-insights-panel .summaryPanel[data-active-view="filters"]',
    count: 1
  }),
  Object.freeze({
    selector:
      '#openwrangler-insights-tab-filters[role="tab"][aria-selected="true"][aria-controls="openwrangler-insights-view-filters"]',
    count: 1
  }),
  Object.freeze({
    selector:
      '#openwrangler-insights-view-filters.filtersViewContent[role="tabpanel"][aria-labelledby="openwrangler-insights-tab-filters"]',
    count: 1
  }),
  Object.freeze({ selector: "#openwrangler-insights-view-filters .panel.filterSortPanel", count: 1 }),
  Object.freeze({
    selector: '#openwrangler-insights-view-filters .activeFilterOverview[aria-label="Active filters"]',
    count: 1
  }),
  Object.freeze({
    selector: '#openwrangler-insights-view-filters .activeFilterGroup[aria-label="city filters"]',
    count: 1
  }),
  Object.freeze({ selector: "#openwrangler-insights-view-filters .rulePill.rulePillButton", count: 3 }),
  Object.freeze({
    selector: `#openwrangler-insights-view-filters button[aria-label='Remove equals "Berlin" filter from city']`,
    count: 1
  }),
  Object.freeze({
    selector: `#openwrangler-insights-view-filters button[aria-label='Remove equals "Milan" filter from city']`,
    count: 1
  }),
  Object.freeze({
    selector: `#openwrangler-insights-view-filters button[aria-label='Remove contains "i" filter from city']`,
    count: 1
  }),
  Object.freeze({
    selector: '#openwrangler-insights-view-filters select[aria-label="Filter column"]',
    count: 1
  }),
  Object.freeze({
    selector: '#openwrangler-insights-view-filters input[aria-label="Search values for city"]',
    count: 1
  }),
  Object.freeze({
    selector: '#openwrangler-insights-view-filters button[aria-label="Search values in city"]',
    count: 1
  }),
  Object.freeze({
    selector: "#openwrangler-insights-view-filters .valueList > label.checkboxRow",
    count: 2
  })
]);

export function createFilterPanelScreenshotReadiness() {
  return createWebviewSelectorReadiness({
    description: "the open city filter panel with its exact active filter fixture",
    selectors: FILTER_PANEL_READINESS_SELECTORS,
    emptyArrayGlobals: ["openWranglerHarnessErrors"]
  });
}
