import * as assert from "node:assert/strict";
import type { Locator } from "playwright-core";
import type { TestApi } from "./extensionHostTestApi";

export interface MultiOutputSplitJourneyDependencies {
  readonly recordAcceptanceProgress: (checkpoint: string) => void;
  readonly waitFor: (predicate: () => boolean, timeoutMs: number, expectation: string) => Promise<void>;
}

export async function exerciseMultiOutputSplitJourney(
  app: Locator,
  testing: TestApi,
  sessionId: string,
  dependencies: MultiOutputSplitJourneyDependencies
): Promise<void> {
  const { recordAcceptanceProgress, waitFor } = dependencies;
  recordAcceptanceProgress("platform-smoke:multi-output-split");
  const initial = testing.activeSession();
  assert.ok(initial?.sessionId === sessionId, "Multi-output split requires the exact active dataframe session.");
  assert.equal(initial.metadata.steps.length, 0);
  assert.equal(initial.metadata.draftStep, undefined);
  const source = initial.metadata.schema.find((column) => column.name === "market");
  assert.ok(source, "The installed multi-output split journey requires its market text column.");
  const sourcePage = await testing.request({
    kind: "getPage",
    sessionId,
    revision: initial.metadata.revision,
    viewRequestId: "platform-smoke-multi-output-split-source",
    offset: 0,
    limit: 1,
    filterModel: initial.viewState.filterModel,
    columnOffset: source.position,
    columnLimit: 1
  });
  assert.equal(sourcePage.kind, "page");
  if (sourcePage.kind !== "page") throw new Error("The multi-output split source page did not resolve.");
  const sourceValue = sourcePage.page.rows[0]?.values[0];
  assert.ok(sourceValue && !sourceValue.isNull, "The installed split fixture requires a non-null first market.");

  await app.getByRole("button", { name: "Add step", exact: true }).click();
  const dialog = app.getByRole("dialog", { name: "Add cleaning step" });
  await dialog.waitFor({ state: "visible", timeout: 10_000 });
  await dialog.getByPlaceholder("Search operations").fill("split text into columns");
  await dialog.getByRole("button", { name: /^Split text into columns\b/u }).click();
  await dialog.getByLabel("Text column", { exact: true }).selectOption(source.id);
  await dialog.getByLabel("Literal delimiter", { exact: true }).fill("-");
  await dialog.getByLabel("Output column 1", { exact: true }).fill("market_part");
  await dialog.getByLabel("Output column 2", { exact: true }).fill("market_remainder");
  await dialog.getByRole("button", { name: "Preview changes", exact: true }).click();
  await waitFor(
    () => {
      const active = testing.activeSession();
      const draft = active?.metadata.draftStep;
      return (
        active?.sessionId === sessionId &&
        draft?.kind === "splitTextColumns" &&
        draft.params.column.id === source.id &&
        draft.params.delimiter === "-" &&
        draft.params.newColumns.join(",") === "market_part,market_remainder"
      );
    },
    30_000,
    "previewing multi-output literal split through the installed operation form"
  );
  await dialog.waitFor({ state: "hidden", timeout: 10_000 });

  const preview = testing.activeSession();
  assert.ok(preview?.metadata.draftStep?.kind === "splitTextColumns");
  const firstOutput = preview.metadata.schema.find((column) => column.name === "market_part");
  const secondOutput = preview.metadata.schema.find((column) => column.name === "market_remainder");
  assert.ok(firstOutput && secondOutput, "The split preview must publish both ordered output columns atomically.");
  assert.equal(firstOutput.id, `c:step:${preview.metadata.draftStep.id}:0`);
  assert.equal(secondOutput.id, `c:step:${preview.metadata.draftStep.id}:1`);
  assert.match(
    preview.code ?? "",
    /pl\.col\('market'\)\.cast\(pl\.String\)\.str\.split\('-'\)\.list\.get\(item, null_on_oob=True\)\.alias\(name\)/u
  );
  assert.match(preview.code ?? "", /for item, name in enumerate\(\['market_part', 'market_remainder'\]\)/u);
  const previewPage = await testing.request({
    kind: "getPage",
    sessionId,
    revision: preview.metadata.revision,
    viewRequestId: "platform-smoke-multi-output-split-preview",
    offset: 0,
    limit: 1,
    filterModel: preview.viewState.filterModel,
    columnOffset: firstOutput.position,
    columnLimit: 2
  });
  assert.equal(previewPage.kind, "page");
  if (previewPage.kind !== "page") throw new Error("The multi-output split preview page did not resolve.");
  assert.deepEqual(previewPage.page.columnIds, [firstOutput.id, secondOutput.id]);
  assert.deepEqual(previewPage.page.rows[0]?.values[0], sourceValue);
  assert.equal(previewPage.page.rows[0]?.values[1]?.isNull, true, "A missing literal part must remain null.");
  const review = app.getByRole("region", { name: "Draft review" });
  await review.getByText("Split text into columns", { exact: true }).waitFor({ state: "visible", timeout: 10_000 });
  await review.locator('[aria-label="Data diff summary"]').getByText("+2 columns", { exact: true }).waitFor({
    state: "visible",
    timeout: 10_000
  });
  await review.getByRole("button", { name: "Apply step", exact: true }).click();
  await waitFor(
    () => testing.activeSession()?.metadata.steps[0]?.kind === "splitTextColumns",
    30_000,
    "applying multi-output literal split"
  );
  await app.getByRole("button", { name: "Undo", exact: true }).click();
  await waitFor(
    () => {
      const active = testing.activeSession();
      return (
        active?.metadata.steps.length === 0 &&
        active.metadata.draftStep === undefined &&
        active.metadata.schema.some((column) => column.id === source.id) &&
        active.metadata.schema.every((column) => column.name !== "market_part" && column.name !== "market_remainder")
      );
    },
    30_000,
    "undoing multi-output literal split"
  );
}
