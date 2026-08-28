import type { Locator } from "playwright-core";

const INSIGHTS_NAME = "Column profiles and filters";
const EXPANDED_INSIGHTS_TOGGLE = 'button[aria-controls="openwrangler-insights-panel"][aria-expanded="true"]';

export interface AcknowledgedInsightsPanel {
  readonly app: Locator;
  readonly panel: Locator;
  readonly toggle: Locator;
}

export async function openAcknowledgedInsightsPanel(
  app: Locator,
  reacquireApp: () => Promise<Locator>,
  timeoutMs = 10_000
): Promise<AcknowledgedInsightsPanel> {
  let currentApp = app;
  let toggle = currentApp.getByRole("button", { name: INSIGHTS_NAME, exact: true });
  await toggle.waitFor({ state: "visible", timeout: timeoutMs });

  if ((await toggle.getAttribute("aria-expanded")) !== "true") {
    await toggle.click();
    currentApp = await reacquireApp();
    toggle = currentApp.locator(EXPANDED_INSIGHTS_TOGGLE);
    await toggle.waitFor({ state: "visible", timeout: timeoutMs });
  }

  const panel = currentApp.getByRole("complementary", { name: INSIGHTS_NAME, exact: true });
  await panel.waitFor({ state: "visible", timeout: timeoutMs });
  return { app: currentApp, panel, toggle };
}
