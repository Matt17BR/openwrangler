import * as assert from "node:assert/strict";
import { writeFileSync } from "node:fs";
import * as path from "node:path";
import * as vscode from "vscode";
import type { Locator } from "playwright-core";
import type { TestApi } from "./extensionHostTestApi";

const REGEX_OPEN_TIMEOUT_MS = 45_000;
const REGEX_UI_TIMEOUT_MS = 30_000;
const REGEX_PATTERN = "([A-Za-z]{5})-([0-9]{2})()";
const REGEX_INVALID_PATTERN = "a{0,20}b{0,20}";
const REGEX_OUTPUT_NAME = "regex_capture";
const PANDAS_SOURCE_BYTES = Buffer.from(["value,score", "alpha-12,1", "plain,2", ",3", ""].join("\n"), "utf8");

export interface PandasRegexJourneyOptions {
  readonly testing: TestApi;
  readonly createTemporaryDirectory: () => string;
  readonly cleanupTemporaryDirectory: (directory: string) => void;
  readonly sessionApp: (sessionId: string, description: string) => Promise<Locator>;
  readonly recordProgress: (checkpoint: string) => void;
}

export async function exercisePandasRegexExtractionJourney(options: PandasRegexJourneyOptions): Promise<void> {
  const { testing } = options;
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
    sessionId = await waitForPandasSession(testing, source.toString());
    await applyRegexExtractionThroughUi(options, sessionId);
    await testing.disposePanelForSession(sessionId);
    sessionId = undefined;
    options.recordProgress("verify:regex-extraction:pandas:complete");
  } catch (error) {
    operationError = error;
  }

  if (sessionId !== undefined) {
    try {
      await testing.disposePanelForSession(sessionId);
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

async function applyRegexExtractionThroughUi(options: PandasRegexJourneyOptions, sessionId: string): Promise<void> {
  const checkpoint = "verify:regex-extraction:pandas";
  options.recordProgress(`${checkpoint}:preview`);
  const active = options.testing.activeSession();
  assert.equal(active?.sessionId, sessionId, `${checkpoint} must retain its exact session.`);
  assert.ok(active, `${checkpoint} requires an active session.`);
  assert.equal(active.metadata.steps.length, 0, `${checkpoint} requires a clean plan.`);
  assert.equal(active.metadata.draftStep, undefined, `${checkpoint} requires no draft.`);
  const source = active.metadata.schema.find((column) => column.name === "value");
  assert.ok(source, `${checkpoint} requires its exact text source column.`);

  const app = await options.sessionApp(sessionId, "the dedicated Pandas regex-extraction session");

  await app.getByRole("button", { name: "Add step", exact: true }).click();
  const dialog = app.getByRole("dialog", { name: "Add cleaning step" });
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
  const rejected = options.testing.activeSession();
  assert.equal(rejected?.sessionId, sessionId, "Invalid-pattern validation must retain the Pandas regex session.");
  assert.ok(rejected, "Invalid-pattern validation requires the active Pandas regex session.");
  assert.equal(rejected.metadata.draftStep, undefined, "The invalid Pandas regex must not create a draft.");

  await pattern.fill(REGEX_PATTERN);
  await dialog.getByLabel("Capture group (0 is the full match)", { exact: true }).fill("3");
  await dialog.getByLabel("New column", { exact: true }).fill(REGEX_OUTPUT_NAME);
  await dialog.getByRole("button", { name: "Preview changes", exact: true }).click();
  await waitFor(
    () => {
      const current = options.testing.activeSession();
      const draft = current?.metadata.draftStep;
      return (
        current !== undefined &&
        current.sessionId === sessionId &&
        draft?.kind === "extractRegexGroup" &&
        draft.params.column.id === source.id &&
        draft.params.pattern === REGEX_PATTERN &&
        draft.params.group === 3 &&
        draft.params.newColumn === REGEX_OUTPUT_NAME
      );
    },
    REGEX_UI_TIMEOUT_MS,
    `previewing ${checkpoint}`
  );
  await dialog.waitFor({ state: "hidden", timeout: REGEX_UI_TIMEOUT_MS });
  const preview = options.testing.activeSession();
  assert.equal(preview?.sessionId, sessionId, "Regex preview must retain the Pandas session.");
  assert.ok(preview, "Regex preview requires the active Pandas session.");
  assert.ok(
    preview.metadata.draftStep?.kind === "extractRegexGroup",
    "Regex preview must publish an Extract regex group draft."
  );
  const output = preview.metadata.schema.find((column) => column.name === REGEX_OUTPUT_NAME);
  assert.ok(output, `${checkpoint} must publish its exact output column.`);
  assert.equal(output.id, `c:step:${preview.metadata.draftStep.id}:0`);
  assert.match(preview.code ?? "", /\.str\.extract\(/u);

  const previewApp = await options.sessionApp(sessionId, `${checkpoint} preview`);
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
        current.sessionId === sessionId &&
        current.metadata.draftStep === undefined &&
        current.metadata.steps.length === 1 &&
        current.metadata.steps[0]?.id === preview.metadata.draftStep?.id &&
        current.metadata.steps[0]?.kind === "extractRegexGroup" &&
        current.metadata.schema.some((column) => column.id === output.id && column.name === REGEX_OUTPUT_NAME)
      );
    },
    REGEX_UI_TIMEOUT_MS,
    `applying ${checkpoint}`
  );
}

async function waitForPandasSession(testing: TestApi, sourceUri: string): Promise<string> {
  await waitFor(
    () => {
      const active = testing.activeSession();
      return Boolean(
        active?.metadata.source.kind === "file" &&
        active.metadata.source.uri === sourceUri &&
        active.metadata.backend === "pandas" &&
        active.metadata.shape.rows === 3 &&
        active.metadata.shape.columns === 2 &&
        active.metadata.steps.length === 0 &&
        active.metadata.draftStep === undefined
      );
    },
    REGEX_OPEN_TIMEOUT_MS,
    "the dedicated Pandas regex session",
    () => JSON.stringify(testing.diagnostics())
  );
  const active = testing.activeSession();
  assert.ok(active);
  return active.sessionId;
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
