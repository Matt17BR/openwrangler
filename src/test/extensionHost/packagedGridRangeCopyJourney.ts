import * as assert from "node:assert/strict";
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
const clipboardWaitMs = 10_000;

export function packagedGridCopyShortcut(platform: NodeJS.Platform): "Meta+c" | "Control+c" {
  return platform === "darwin" ? "Meta+c" : "Control+c";
}

function normalizeClipboardText(value: string): string {
  return value.replaceAll("\r\n", "\n");
}

async function waitForHostClipboard(
  hostClipboard: PackagedGridRangeCopyHostClipboard,
  expected: string
): Promise<void> {
  const deadline = Date.now() + clipboardWaitMs;
  let latest = "";
  do {
    latest = normalizeClipboardText(await hostClipboard.readText());
    if (latest === expected) return;
    await new Promise<void>((resolve) => setTimeout(resolve, 25));
  } while (Date.now() < deadline);
  assert.equal(latest, expected, "The packaged webview did not publish its exact range through the host clipboard.");
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

  const priorClipboard = await hostClipboard.readText();
  try {
    recordProgress(`platform-smoke:grid-range-copy:${platform === "darwin" ? "cmd" : "ctrl"}`);
    await hostClipboard.writeText("open-wrangler-grid-range-copy-keyboard-pending");
    await endpoint.press(packagedGridCopyShortcut(platform));
    await waitForHostClipboard(hostClipboard, expectedRangeText);
    await frame.getByText("Copied 2 by 2 cell range.", { exact: true }).waitFor({ timeout: 5_000 });

    recordProgress("platform-smoke:grid-range-copy:context-menu");
    await hostClipboard.writeText("open-wrangler-grid-range-copy-menu-pending");
    await start.click({ button: "right" });
    const menu = frame.getByRole("menu", { name: "Cell and selection actions for order_id", exact: true });
    await menu.waitFor({ state: "visible", timeout: 5_000 });
    assert.equal(
      await menu.getByRole("menuitem").count(),
      3,
      "The mixed menu must expose two filters and one copy action."
    );
    const copySelection = menu.getByRole("menuitem", { name: "Copy selection", exact: true });
    await copySelection.click();
    await waitForHostClipboard(hostClipboard, expectedRangeText);
    await frame
      .locator('td[data-grid-row="1"][data-grid-column="1"]:focus')
      .waitFor({ state: "visible", timeout: 5_000 });
    assert.equal(await frame.locator('td[data-clipboard-selected="true"]').count(), 4);
  } finally {
    await hostClipboard.writeText(priorClipboard);
  }
}
