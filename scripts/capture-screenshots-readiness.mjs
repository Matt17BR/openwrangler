import { createWebviewSelectorReadiness } from "./webview-browser.mjs";

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
