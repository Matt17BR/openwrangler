import * as assert from "node:assert/strict";
import { readFileSync, writeFileSync } from "node:fs";
import * as path from "node:path";
import * as vscode from "vscode";
import type { Locator } from "playwright-core";
import type { OpenWranglerResponse, SessionMetadata } from "../../shared/protocol";

interface NumericSummaryActiveSession {
  readonly sessionId: string;
  readonly metadata: SessionMetadata;
  readonly viewState: Readonly<{ selectedColumnId?: string }>;
}

export interface NumericSummaryJourneyTesting {
  activeSession(): NumericSummaryActiveSession | undefined;
  diagnostics(): Readonly<{
    sessionCount: number;
    sessions: readonly Readonly<{ publicId: string }>[];
  }>;
  runtimeRunning(): boolean;
  disposePanelForSession(sessionId: string): Promise<OpenWranglerResponse | undefined>;
}

export interface NumericSummaryPandasJourneyOptions {
  readonly testing: NumericSummaryJourneyTesting;
  readonly createTemporaryDirectory: () => string;
  readonly cleanupTemporaryDirectory: (directory: string) => void;
  readonly sessionApp: (sessionId: string, description: string) => Promise<Locator>;
  readonly recordProgress: (checkpoint: string) => void;
}

export interface NumericSummaryValueExpectation {
  readonly text: string;
  readonly ariaLabel?: string;
  readonly exact?: boolean;
}

const NUMERIC_SUMMARY_OPEN_TIMEOUT_MS = 45_000;
const NUMERIC_SUMMARY_UI_TIMEOUT_MS = 30_000;
const NUMERIC_SUMMARY_SOURCE_BYTES = Buffer.from(
  ["wide_integer,all_missing,infinity", "9007199254740993,,inf", "9007199254740995,,1", ""].join("\n"),
  "utf8"
);

export async function assertNumericSummarySum(panel: Locator, expected: NumericSummaryValueExpectation): Promise<void> {
  const term = panel.getByText("Sum", { exact: true });
  await term.waitFor({ state: "visible", timeout: NUMERIC_SUMMARY_UI_TIMEOUT_MS });
  assert.equal(await term.evaluate((element) => element.tagName), "DT", "Sum must retain its accessible term.");

  const value = term.locator("xpath=following-sibling::dd[1]");
  await value.waitFor({ state: "visible", timeout: NUMERIC_SUMMARY_UI_TIMEOUT_MS });
  assert.equal(await value.evaluate((element) => element.tagName), "DD", "Sum must retain its accessible value.");
  await waitForText(value, expected.text, "the exact numeric Sum presentation");
  assert.equal(
    await value.getAttribute("aria-label"),
    expected.ariaLabel ?? null,
    "Sum must expose only its exact expected accessible name."
  );
  assert.equal(
    await value.evaluate((element) => element.classList.contains("exactNumericExtremum")),
    expected.exact ?? false,
    "Sum must label lossless typed values without mislabelling approximate or unavailable values."
  );
}

export async function exerciseNumericSummaryPandasJourney(options: NumericSummaryPandasJourneyOptions): Promise<void> {
  const { testing } = options;
  assert.equal(testing.diagnostics().sessionCount, 0, "Numeric Summary must start without a retained session.");
  assert.equal(testing.runtimeRunning(), false, "Numeric Summary must start without a retained standalone runtime.");

  const directory = options.createTemporaryDirectory();
  const sourcePath = path.join(directory, "numeric-summary.csv");
  const source = vscode.Uri.file(sourcePath);
  writeFileSync(sourcePath, NUMERIC_SUMMARY_SOURCE_BYTES, { flag: "wx" });

  const configuration = vscode.workspace.getConfiguration("openWrangler");
  const originalBackend = configuration.inspect<"auto" | "polars" | "pandas" | "duckdb">("defaultBackend")?.globalValue;
  let sessionId: string | undefined;
  let operationError: unknown;
  const cleanupErrors: unknown[] = [];

  try {
    await configuration.update("defaultBackend", "pandas", vscode.ConfigurationTarget.Global);
    options.recordProgress("verify:numeric-summary:pandas:open");
    await vscode.commands.executeCommand("openWrangler.openFile", source);
    await waitForCondition(
      () => {
        const active = testing.activeSession();
        return (
          active?.metadata.source.kind === "file" &&
          active.metadata.source.uri === source.toString() &&
          active.metadata.backend === "pandas" &&
          active.metadata.shape.rows === 2 &&
          active.metadata.shape.columns === 3
        );
      },
      NUMERIC_SUMMARY_OPEN_TIMEOUT_MS,
      "the dedicated Pandas Numeric Summary file session",
      () => JSON.stringify(testing.diagnostics())
    );

    const active = testing.activeSession();
    assert.ok(active, "Numeric Summary must publish its exact Pandas session.");
    sessionId = active.sessionId;
    assert.deepEqual(
      active.metadata.schema.map((column) => [column.name, column.type]),
      [
        ["wide_integer", "integer"],
        ["all_missing", "float"],
        ["infinity", "float"]
      ],
      "The dedicated CSV must retain its intended numeric domains."
    );
    assert.deepEqual(
      readFileSync(sourcePath),
      NUMERIC_SUMMARY_SOURCE_BYTES,
      "Opening the Sum fixture must not edit it."
    );

    const app = await options.sessionApp(sessionId, "the dedicated Pandas Numeric Summary session");
    const drawer = await openNumericSummaryDrawer(app);
    await selectNumericColumn(testing, app, drawer, sessionId, "wide_integer");
    await assertNumericSummarySum(drawer.getByRole("tabpanel"), {
      text: "18014398509481988",
      ariaLabel: "Sum 18014398509481988",
      exact: true
    });

    await selectNumericColumn(testing, app, drawer, sessionId, "all_missing");
    await assertNumericSummarySum(drawer.getByRole("tabpanel"), { text: "0", ariaLabel: "Sum 0" });

    await selectNumericColumn(testing, app, drawer, sessionId, "infinity");
    await assertNumericSummarySum(drawer.getByRole("tabpanel"), { text: "n/a" });
    assert.deepEqual(
      readFileSync(sourcePath),
      NUMERIC_SUMMARY_SOURCE_BYTES,
      "Profiling every Sum domain must leave the source byte-identical."
    );

    options.recordProgress("verify:numeric-summary:pandas:close");
    await closeNumericSummarySession(testing, sessionId);
    sessionId = undefined;
    options.recordProgress("verify:numeric-summary:pandas:complete");
  } catch (error) {
    operationError = error;
  }

  if (sessionId !== undefined) {
    try {
      await closeNumericSummarySession(testing, sessionId);
    } catch (error) {
      cleanupErrors.push(error);
    }
  }
  try {
    await configuration.update("defaultBackend", originalBackend, vscode.ConfigurationTarget.Global);
  } catch (error) {
    cleanupErrors.push(error);
  }
  try {
    assert.deepEqual(
      readFileSync(sourcePath),
      NUMERIC_SUMMARY_SOURCE_BYTES,
      "Numeric Summary cleanup must leave the source byte-identical."
    );
  } catch (error) {
    cleanupErrors.push(error);
  }
  try {
    options.cleanupTemporaryDirectory(directory);
  } catch (error) {
    cleanupErrors.push(error);
  }

  if (operationError !== undefined && cleanupErrors.length > 0) {
    throw new AggregateError([operationError, ...cleanupErrors], "Numeric Summary failed and did not clean up fully.");
  }
  if (operationError !== undefined) throw operationError;
  if (cleanupErrors.length === 1) throw cleanupErrors[0];
  if (cleanupErrors.length > 1) throw new AggregateError(cleanupErrors, "Numeric Summary cleanup failed.");
}

async function openNumericSummaryDrawer(app: Locator): Promise<Locator> {
  const toggle = app.getByRole("button", { name: "Column profiles and filters", exact: true });
  await toggle.waitFor({ state: "visible", timeout: NUMERIC_SUMMARY_UI_TIMEOUT_MS });
  await toggle.click();
  const drawer = app.getByRole("complementary", { name: "Column profiles and filters", exact: true });
  await drawer.waitFor({ state: "visible", timeout: NUMERIC_SUMMARY_UI_TIMEOUT_MS });
  return drawer;
}

async function selectNumericColumn(
  testing: NumericSummaryJourneyTesting,
  app: Locator,
  drawer: Locator,
  sessionId: string,
  columnName: string
): Promise<void> {
  const active = testing.activeSession();
  assert.equal(active?.sessionId, sessionId, `Selecting ${columnName} must retain the exact Numeric Summary session.`);
  const column = active?.metadata.schema.find((candidate) => candidate.name === columnName);
  assert.ok(column, `The Numeric Summary fixture must expose ${columnName}.`);

  const search = app.getByRole("combobox", { name: "Column", exact: true });
  await search.fill(columnName);
  await app
    .getByRole("option", { name: new RegExp(`^${columnName},`, "u") })
    .first()
    .waitFor({ state: "visible", timeout: NUMERIC_SUMMARY_UI_TIMEOUT_MS });
  await search.press("Enter");
  await waitForCondition(
    () => testing.activeSession()?.viewState.selectedColumnId === column.id,
    NUMERIC_SUMMARY_UI_TIMEOUT_MS,
    `the Numeric Summary grid to select ${columnName}`
  );
  await drawer.getByRole("heading", { name: columnName, exact: true }).waitFor({
    state: "visible",
    timeout: NUMERIC_SUMMARY_UI_TIMEOUT_MS
  });
}

async function closeNumericSummarySession(testing: NumericSummaryJourneyTesting, sessionId: string): Promise<void> {
  const response = await testing.disposePanelForSession(sessionId);
  assert.equal(response?.kind, "sessionClosed", "The Numeric Summary panel must close authoritatively.");
  if (response?.kind === "sessionClosed") assert.equal(response.sessionId, sessionId);
  await waitForCondition(
    () => testing.diagnostics().sessionCount === 0 && !testing.runtimeRunning(),
    10_000,
    "the Numeric Summary session and standalone runtime to dispose",
    () => JSON.stringify(testing.diagnostics())
  );
  assert.deepEqual(testing.diagnostics().sessions, [], "Numeric Summary cleanup must retain no public session.");
}

async function waitForText(locator: Locator, expected: string, expectation: string): Promise<void> {
  const started = Date.now();
  while ((await locator.innerText()).trim() !== expected) {
    if (Date.now() - started > NUMERIC_SUMMARY_UI_TIMEOUT_MS) {
      throw new Error(
        `Timed out waiting for ${expectation}; last text was ${JSON.stringify(await locator.innerText())}.`
      );
    }
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
}

async function waitForCondition(
  predicate: () => boolean,
  timeoutMs: number,
  expectation: string,
  diagnostics?: () => string
): Promise<void> {
  const started = Date.now();
  while (!predicate()) {
    if (Date.now() - started > timeoutMs) {
      const detail = diagnostics ? ` Last state: ${diagnostics()}.` : "";
      throw new Error(`Timed out waiting for ${expectation}.${detail}`);
    }
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
}
