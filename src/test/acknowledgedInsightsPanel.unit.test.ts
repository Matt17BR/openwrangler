import type { Locator } from "playwright-core";
import { describe, expect, it, vi } from "vitest";
import { openAcknowledgedInsightsPanel } from "./extensionHost/acknowledgedInsightsPanel";

describe("acknowledged insights panel", () => {
  it("reacquires the acknowledged app after opening the panel", async () => {
    const initialToggle = {
      click: vi.fn(async () => {}),
      getAttribute: vi.fn(async () => "false"),
      waitFor: vi.fn(async () => {})
    } as unknown as Locator;
    const retiredPanel = {
      waitFor: vi.fn(async () => {
        throw new Error("the retired app must not be observed");
      })
    } as unknown as Locator;
    const initialApp = {
      getByRole: vi.fn((role: string) => (role === "button" ? initialToggle : retiredPanel))
    } as unknown as Locator;

    const expandedToggle = { waitFor: vi.fn(async () => {}) } as unknown as Locator;
    const currentPanel = { waitFor: vi.fn(async () => {}) } as unknown as Locator;
    const currentApp = {
      getByRole: vi.fn(() => currentPanel),
      locator: vi.fn(() => expandedToggle)
    } as unknown as Locator;
    const reacquireApp = vi.fn(async () => currentApp);

    await expect(openAcknowledgedInsightsPanel(initialApp, reacquireApp)).resolves.toEqual({
      app: currentApp,
      panel: currentPanel,
      toggle: expandedToggle
    });
    expect(initialToggle.click).toHaveBeenCalledOnce();
    expect(reacquireApp).toHaveBeenCalledOnce();
    expect(currentApp.locator).toHaveBeenCalledWith(
      'button[aria-controls="openwrangler-insights-panel"][aria-expanded="true"]'
    );
    expect(expandedToggle.waitFor).toHaveBeenCalledWith({ state: "visible", timeout: 10_000 });
    expect(currentPanel.waitFor).toHaveBeenCalledWith({ state: "visible", timeout: 10_000 });
    expect(retiredPanel.waitFor).not.toHaveBeenCalled();
  });

  it("keeps the current acknowledged app when the panel is already expanded", async () => {
    const toggle = {
      click: vi.fn(async () => {}),
      getAttribute: vi.fn(async () => "true"),
      waitFor: vi.fn(async () => {})
    } as unknown as Locator;
    const panel = { waitFor: vi.fn(async () => {}) } as unknown as Locator;
    const app = {
      getByRole: vi.fn((role: string) => (role === "button" ? toggle : panel))
    } as unknown as Locator;
    const reacquireApp = vi.fn(async () => app);

    await expect(openAcknowledgedInsightsPanel(app, reacquireApp, 2_500)).resolves.toEqual({ app, panel, toggle });
    expect(toggle.waitFor).toHaveBeenCalledWith({ state: "visible", timeout: 2_500 });
    expect(toggle.click).not.toHaveBeenCalled();
    expect(reacquireApp).not.toHaveBeenCalled();
    expect(panel.waitFor).toHaveBeenCalledWith({ state: "visible", timeout: 2_500 });
  });
});
