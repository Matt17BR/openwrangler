import * as assert from "node:assert/strict";
import { readFileSync, writeFileSync } from "node:fs";
import * as path from "node:path";
import * as vscode from "vscode";
import type { Locator } from "playwright-core";
import type { CellValue } from "../../shared/protocol";
import type { TestApi } from "./extensionHostTestApi";

const REGEX_OPEN_TIMEOUT_MS = 45_000;
const REGEX_UI_TIMEOUT_MS = 30_000;
const REGEX_PATTERN = "([A-Za-z]{5})-([0-9]{2})()";
const REGEX_INVALID_PATTERN = "a{0,20}b{0,20}";
const REGEX_OUTPUT_NAME = "regex_capture";
const PANDAS_SOURCE_BYTES = Buffer.from(["value,score", "alpha-12,1", "plain,2", ",3", ""].join("\n"), "utf8");

interface AppliedRegexReceipt {
  readonly sourceCells: readonly CellValue[];
  readonly stepId: string;
}

interface ActiveRegexJourneyOptions {
  readonly app: Locator;
  readonly testing: TestApi;
  readonly sessionId: string;
  readonly sourceColumnName: string;
  readonly pattern: string;
  readonly group: number;
  readonly outputName: string;
  readonly expectedOutputDisplays: readonly (string | null)[];
  readonly generatedCodePattern: RegExp;
  readonly reacquireApp: (description: string) => Promise<Locator>;
  readonly recordProgress: (checkpoint: string) => void;
  readonly checkpoint: string;
}

export interface PandasRegexJourneyOptions {
  readonly testing: TestApi;
  readonly createTemporaryDirectory: () => string;
  readonly cleanupTemporaryDirectory: (directory: string) => void;
  readonly sessionApp: (sessionId: string, description: string) => Promise<Locator>;
  readonly recordProgress: (checkpoint: string) => void;
}

export async function exerciseActiveRegexExtractionJourney(options: ActiveRegexJourneyOptions): Promise<void> {
  const receipt = await applyRegexExtractionThroughUi(options);
  const app = await options.reacquireApp(`${options.checkpoint} applied result`);
  await app.getByRole("button", { name: "Undo", exact: true }).click();
  await waitFor(
    () => {
      const active = options.testing.activeSession();
      return (
        active !== undefined &&
        active.sessionId === options.sessionId &&
        active.metadata.steps.length === 0 &&
        active.metadata.draftStep === undefined &&
        !active.metadata.schema.some((column) => column.name === options.outputName)
      );
    },
    REGEX_UI_TIMEOUT_MS,
    `undoing ${options.checkpoint}`
  );
  await assertSourceCells(options.testing, options.sessionId, options.sourceColumnName, receipt.sourceCells);
  options.recordProgress(`${options.checkpoint}:complete`);
}

export async function exercisePandasRegexExtractionJourney(options: PandasRegexJourneyOptions): Promise<void> {
  const { testing } = options;
  assert.equal(testing.diagnostics().sessionCount, 0, "Regex extraction must start without a retained session.");
  assert.equal(testing.runtimeRunning(), false, "Regex extraction must start without a standalone runtime.");

  const directory = options.createTemporaryDirectory();
  const sourcePath = path.join(directory, "regex-extraction.csv");
  const source = vscode.Uri.file(sourcePath);
  writeFileSync(sourcePath, PANDAS_SOURCE_BYTES, { flag: "wx" });
  const configuration = vscode.workspace.getConfiguration("openWrangler");
  const originalBackend = configuration.inspect<"auto" | "polars" | "pandas" | "duckdb">("defaultBackend")?.globalValue;
  let sessionId: string | undefined;
  let operationError: unknown;
  const cleanupErrors: unknown[] = [];

  try {
    await configuration.update("defaultBackend", "pandas", vscode.ConfigurationTarget.Global);
    options.recordProgress("verify:regex-extraction:pandas:open");
    await vscode.commands.executeCommand("openWrangler.openFile", source);
    sessionId = await waitForPandasSession(testing, source.toString(), false);
    const firstApp = await options.sessionApp(sessionId, "the dedicated Pandas regex-extraction session");
    const applied = await applyRegexExtractionThroughUi({
      app: firstApp,
      testing,
      sessionId,
      sourceColumnName: "value",
      pattern: REGEX_PATTERN,
      group: 3,
      outputName: REGEX_OUTPUT_NAME,
      expectedOutputDisplays: ["", null, null],
      generatedCodePattern: /\.str\.extract\(/u,
      reacquireApp: (description) => options.sessionApp(sessionId!, description),
      recordProgress: options.recordProgress,
      checkpoint: "verify:regex-extraction:pandas"
    });
    assert.deepEqual(readFileSync(sourcePath), PANDAS_SOURCE_BYTES, "Regex extraction must not edit its CSV source.");

    await closeSession(testing, sessionId);
    sessionId = undefined;
    options.recordProgress("verify:regex-extraction:pandas:reopen");
    await vscode.commands.executeCommand("openWrangler.openFile", source);
    sessionId = await waitForPandasSession(testing, source.toString(), true);
    const reopened = testing.activeSession();
    assert.equal(
      reopened?.metadata.steps[0]?.id,
      applied.stepId,
      "Reopening must retain the exact regex step identity."
    );
    await assertSourceCells(testing, sessionId, "value", applied.sourceCells);
    await assertOutputCells(testing, sessionId, REGEX_OUTPUT_NAME, ["", null, null]);

    const reopenedApp = await options.sessionApp(sessionId, "the reopened Pandas regex-extraction session");
    await reopenedApp.getByRole("button", { name: "Undo", exact: true }).click();
    await waitFor(
      () => {
        const active = testing.activeSession();
        return (
          active !== undefined &&
          active.sessionId === sessionId &&
          active?.metadata.steps.length === 0 &&
          active.metadata.draftStep === undefined &&
          !active.metadata.schema.some((column) => column.name === REGEX_OUTPUT_NAME)
        );
      },
      REGEX_UI_TIMEOUT_MS,
      "undoing regex extraction after reopen"
    );
    await assertSourceCells(testing, sessionId, "value", applied.sourceCells);
    assert.deepEqual(
      readFileSync(sourcePath),
      PANDAS_SOURCE_BYTES,
      "Regex undo and reopen must preserve source bytes."
    );
    await closeSession(testing, sessionId);
    sessionId = undefined;
    options.recordProgress("verify:regex-extraction:pandas:complete");
  } catch (error) {
    operationError = error;
  }

  if (sessionId !== undefined) {
    try {
      await closeSession(testing, sessionId);
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
    assert.deepEqual(readFileSync(sourcePath), PANDAS_SOURCE_BYTES, "Regex cleanup must preserve source bytes.");
  } catch (error) {
    cleanupErrors.push(error);
  }
  try {
    options.cleanupTemporaryDirectory(directory);
  } catch (error) {
    cleanupErrors.push(error);
  }

  if (operationError !== undefined && cleanupErrors.length > 0) {
    throw new AggregateError([operationError, ...cleanupErrors], "Regex extraction failed and did not clean up fully.");
  }
  if (operationError !== undefined) throw operationError;
  if (cleanupErrors.length === 1) throw cleanupErrors[0];
  if (cleanupErrors.length > 1) throw new AggregateError(cleanupErrors, "Regex extraction cleanup failed.");
}

async function applyRegexExtractionThroughUi(options: ActiveRegexJourneyOptions): Promise<AppliedRegexReceipt> {
  options.recordProgress(`${options.checkpoint}:preview`);
  const active = options.testing.activeSession();
  assert.equal(active?.sessionId, options.sessionId, `${options.checkpoint} must retain its exact session.`);
  assert.ok(active, `${options.checkpoint} requires an active session.`);
  assert.equal(active.metadata.steps.length, 0, `${options.checkpoint} requires a clean plan.`);
  assert.equal(active.metadata.draftStep, undefined, `${options.checkpoint} requires no draft.`);
  const source = active.metadata.schema.find((column) => column.name === options.sourceColumnName);
  assert.ok(source, `${options.checkpoint} requires its exact text source column.`);
  const sourceCells = await readColumnCells(options.testing, options.sessionId, source.name);

  await options.app.getByRole("button", { name: "Add step", exact: true }).click();
  const dialog = options.app.getByRole("dialog", { name: "Add cleaning step" });
  await dialog.waitFor({ state: "visible", timeout: REGEX_UI_TIMEOUT_MS });
  await dialog.getByPlaceholder("Search operations").fill("extract regex group");
  await dialog.getByRole("button", { name: /^Extract regex group\b/u }).click();
  await dialog.getByLabel("Text column", { exact: true }).selectOption(source.id);
  const pattern = dialog.getByLabel("Portable regex pattern", { exact: true });
  await pattern.fill(REGEX_INVALID_PATTERN);
  await dialog.getByRole("button", { name: "Preview changes", exact: true }).click();
  await dialog
    .getByRole("alert")
    .getByText(/variable-width quantifier/iu)
    .waitFor({
      state: "visible",
      timeout: REGEX_UI_TIMEOUT_MS
    });
  assert.equal(
    options.testing.activeSession()?.metadata.draftStep,
    undefined,
    "Invalid regex must not create a draft."
  );

  await pattern.fill(options.pattern);
  await dialog.getByLabel("Capture group (0 is the full match)", { exact: true }).fill(String(options.group));
  await dialog.getByLabel("New column", { exact: true }).fill(options.outputName);
  await dialog.getByRole("button", { name: "Preview changes", exact: true }).click();
  await waitFor(
    () => {
      const current = options.testing.activeSession();
      const draft = current?.metadata.draftStep;
      return (
        current !== undefined &&
        current.sessionId === options.sessionId &&
        draft?.kind === "extractRegexGroup" &&
        draft.params.column.id === source.id &&
        draft.params.pattern === options.pattern &&
        draft.params.group === options.group &&
        draft.params.newColumn === options.outputName
      );
    },
    REGEX_UI_TIMEOUT_MS,
    `previewing ${options.checkpoint}`
  );
  await dialog.waitFor({ state: "hidden", timeout: REGEX_UI_TIMEOUT_MS });
  const preview = options.testing.activeSession();
  assert.ok(preview?.metadata.draftStep?.kind === "extractRegexGroup");
  const output = preview.metadata.schema.find((column) => column.name === options.outputName);
  assert.ok(output, `${options.checkpoint} must publish its exact output column.`);
  assert.equal(output.id, `c:step:${preview.metadata.draftStep.id}:0`);
  assert.match(preview.code ?? "", options.generatedCodePattern);
  assert.doesNotMatch(preview.code ?? "", /to_pandas|toPandas|pandas2ri/iu);
  await assertSourceCells(options.testing, options.sessionId, source.name, sourceCells);
  await assertOutputCells(options.testing, options.sessionId, output.name, options.expectedOutputDisplays);

  const previewApp = await options.reacquireApp(`${options.checkpoint} preview`);
  const review = previewApp.getByRole("region", { name: "Draft review" });
  await review
    .getByText("Extract regex group", { exact: true })
    .waitFor({ state: "visible", timeout: REGEX_UI_TIMEOUT_MS });
  await review.getByRole("button", { name: "Apply step", exact: true }).click();
  await waitFor(
    () => {
      const current = options.testing.activeSession();
      return (
        current !== undefined &&
        current.sessionId === options.sessionId &&
        current.metadata.draftStep === undefined &&
        current.metadata.steps.length === 1 &&
        current.metadata.steps[0]?.id === preview.metadata.draftStep?.id &&
        current.metadata.steps[0]?.kind === "extractRegexGroup"
      );
    },
    REGEX_UI_TIMEOUT_MS,
    `applying ${options.checkpoint}`
  );
  await assertSourceCells(options.testing, options.sessionId, source.name, sourceCells);
  await assertOutputCells(options.testing, options.sessionId, output.name, options.expectedOutputDisplays);
  return { sourceCells, stepId: preview.metadata.draftStep.id };
}

async function readColumnCells(testing: TestApi, sessionId: string, columnName: string): Promise<readonly CellValue[]> {
  const active = testing.activeSession();
  assert.equal(active?.sessionId, sessionId);
  assert.ok(active);
  const column = active.metadata.schema.find((candidate) => candidate.name === columnName);
  assert.ok(column, `The installed regex journey requires column ${columnName}.`);
  const response = await testing.request({
    kind: "getPage",
    sessionId,
    revision: active.metadata.revision,
    viewRequestId: `regex-extraction-${columnName}-${active.metadata.revision}`,
    offset: 0,
    limit: 3,
    filterModel: active.viewState.filterModel,
    columnOffset: column.position,
    columnLimit: 1
  });
  assert.equal(response.kind, "page");
  if (response.kind !== "page") throw new Error(`The installed regex ${columnName} page did not resolve.`);
  assert.deepEqual(response.page.columnIds, [column.id]);
  return response.page.rows.map((row) => row.values[0]!);
}

async function assertSourceCells(
  testing: TestApi,
  sessionId: string,
  columnName: string,
  expected: readonly CellValue[]
): Promise<void> {
  assert.deepEqual(
    await readColumnCells(testing, sessionId, columnName),
    expected,
    "Regex extraction mutated its source."
  );
}

async function assertOutputCells(
  testing: TestApi,
  sessionId: string,
  columnName: string,
  expected: readonly (string | null)[]
): Promise<void> {
  const cells = await readColumnCells(testing, sessionId, columnName);
  assert.deepEqual(
    cells.map((cell) => (cell.isNull ? null : cell.display)),
    expected,
    "Regex extraction changed empty, no-match, or null semantics."
  );
}

async function waitForPandasSession(testing: TestApi, sourceUri: string, requireStep: boolean): Promise<string> {
  await waitFor(
    () => {
      const active = testing.activeSession();
      return Boolean(
        active?.metadata.source.kind === "file" &&
        active.metadata.source.uri === sourceUri &&
        active.metadata.backend === "pandas" &&
        active.metadata.shape.rows === 3 &&
        active.metadata.shape.columns === (requireStep ? 3 : 2) &&
        (!requireStep || active.metadata.steps[0]?.kind === "extractRegexGroup")
      );
    },
    REGEX_OPEN_TIMEOUT_MS,
    requireStep ? "the persisted Pandas regex session to reopen" : "the dedicated Pandas regex session",
    () => JSON.stringify(testing.diagnostics())
  );
  const active = testing.activeSession();
  assert.ok(active);
  return active.sessionId;
}

async function closeSession(testing: TestApi, sessionId: string): Promise<void> {
  const response = await testing.disposePanelForSession(sessionId);
  assert.equal(response?.kind, "sessionClosed", "The regex session must close authoritatively.");
  if (response?.kind === "sessionClosed") assert.equal(response.sessionId, sessionId);
  await waitFor(
    () => testing.diagnostics().sessionCount === 0 && !testing.runtimeRunning(),
    10_000,
    "the regex session and standalone runtime to dispose",
    () => JSON.stringify(testing.diagnostics())
  );
}

async function waitFor(
  predicate: () => boolean,
  timeoutMs: number,
  expectation: string,
  diagnostics?: () => string
): Promise<void> {
  const started = Date.now();
  while (!predicate()) {
    if (Date.now() - started > timeoutMs) {
      throw new Error(`Timed out waiting for ${expectation}.${diagnostics ? ` Last state: ${diagnostics()}.` : ""}`);
    }
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
}
