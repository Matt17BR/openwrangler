import * as assert from "node:assert/strict";
import * as path from "node:path";
import type { Locator, Page } from "playwright-core";
import { pollAcceptanceCondition } from "./playwrightLifecycle";

type CleanedDataExportFormat = "csv" | "parquet";

interface AcceptancePollOptions {
  readonly timeoutMs: number;
  readonly intervalMs: number;
}

type AcceptancePoll = (probe: () => Promise<boolean>, options: AcceptancePollOptions) => Promise<boolean>;

export interface CleanedDataExportTiming {
  readonly pollCondition?: AcceptancePoll;
  readonly rowAxisPolicy?: "preserve" | "omit";
}

export async function exportCleanedDataThroughWorkbench(
  app: Locator,
  workbench: Page,
  destination: string,
  format: CleanedDataExportFormat = "csv",
  { pollCondition = pollAcceptanceCondition, rowAxisPolicy }: CleanedDataExportTiming = {}
): Promise<void> {
  await dismissStaleWorkbenchHover(workbench, pollCondition);
  await app.getByRole("button", { name: "Export", exact: true }).click();
  await completeCleanedDataExportDialog(workbench, destination, format, rowAxisPolicy, pollCondition);
}

export async function dismissStaleWorkbenchHover(
  workbench: Page,
  pollCondition: AcceptancePoll = pollAcceptanceCondition
): Promise<void> {
  await workbench.keyboard.press("Escape");
  await workbench.mouse.move(1, 1);
  assert.equal(
    await pollCondition(async () => (await workbench.locator(".monaco-hover:visible").count()) === 0, {
      timeoutMs: 3_000,
      intervalMs: 50
    }),
    true,
    "The workbench must dismiss stale toolbar hovers before the next webview action."
  );
}

async function completeCleanedDataExportDialog(
  workbench: Page,
  destination: string,
  format: CleanedDataExportFormat,
  rowAxisPolicy: "preserve" | "omit" | undefined,
  pollCondition: AcceptancePoll
): Promise<void> {
  const formatPicker = workbench
    .locator(".quick-input-widget:visible")
    .filter({ hasText: "Export Cleaned Data" })
    .last();
  await formatPicker.waitFor({ state: "visible", timeout: 10_000 });
  const label = format === "csv" ? /^CSV/u : /^Parquet/u;
  const formatOption = formatPicker.getByRole("option").filter({ hasText: label }).first();
  try {
    await formatOption.waitFor({ state: "visible", timeout: 10_000 });
  } catch (error) {
    const options = (await formatPicker.getByRole("option").allInnerTexts()).map((text) =>
      text.replace(/\s+/gu, " ").trim().slice(0, 200)
    );
    const input = await formatPicker
      .locator(".quick-input-box input")
      .first()
      .inputValue()
      .catch(() => "");
    throw new Error(
      `The cleaned-data export picker did not offer ${format}. Visible options: ${JSON.stringify(options)}. Input: ${JSON.stringify(input)}.`,
      { cause: error }
    );
  }
  await formatOption.click();
  if (rowAxisPolicy !== undefined) {
    const policyPicker = workbench
      .locator(".quick-input-widget:visible")
      .filter({ hasText: "Export Pandas Index" })
      .last();
    await policyPicker.waitFor({ state: "visible", timeout: 10_000 });
    const policyLabel = rowAxisPolicy === "preserve" ? /^Preserve index/u : /^Omit index/u;
    const policyOption = policyPicker.getByRole("option").filter({ hasText: policyLabel }).first();
    try {
      await policyOption.waitFor({ state: "visible", timeout: 10_000 });
    } catch (error) {
      const options = (await policyPicker.getByRole("option").allInnerTexts()).map((text) =>
        text.replace(/\s+/gu, " ").trim().slice(0, 200)
      );
      throw new Error(
        `The cleaned-data export picker did not offer the Pandas ${rowAxisPolicy} policy. ` +
          `Visible options: ${JSON.stringify(options)}.`,
        { cause: error }
      );
    }
    await policyOption.click();
  }
  assert.equal(
    await pollCondition(
      async () =>
        workbench
          .locator(".quick-input-widget:visible")
          .filter({ hasText: "Export Cleaned Data" })
          .last()
          .locator(".quick-input-box input")
          .first()
          .inputValue()
          .then((value) => value.endsWith(`.cleaned.${format}`))
          .catch(() => false),
      { timeoutMs: 10_000, intervalMs: 50 }
    ),
    true,
    `The cleaned-data Save dialog must retain the suggested .cleaned.${format} destination.`
  );
  const saveDialog = workbench.locator(".quick-input-widget:visible").filter({ hasText: "Export Cleaned Data" }).last();
  const saveInput = saveDialog.locator(".quick-input-box input").first();
  await saveInput.fill(path.resolve(destination));
  await saveInput.press("Enter");
  await saveDialog.waitFor({ state: "hidden", timeout: 30_000 });
  const exportProgress = workbench
    .locator(".notifications-toasts .notification-toast:visible, .notifications-center .notification-list-item:visible")
    .filter({ hasText: "Exporting cleaned data…" });
  assert.equal(
    await pollCondition(async () => (await exportProgress.count()) === 0, {
      timeoutMs: 30_000,
      intervalMs: 50
    }),
    true,
    "The cleaned-data export progress notification must close."
  );
}
