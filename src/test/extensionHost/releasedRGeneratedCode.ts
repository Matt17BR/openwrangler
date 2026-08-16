import * as assert from "node:assert/strict";
import { assertCodePreviewDocumentChecks } from "./playwrightLifecycle";

export type ReleasedRCategoricalGeneratedExpectation =
  | Readonly<{
      kind: "oneHotEncode";
      sourceId: string;
      sourceName: string;
      sourcePosition: number;
      sourceKind: string;
      sourceStorageMode: string;
      sourceClasses: readonly string[];
      sourceTimezone: string | null;
      sourceUnits: string | null;
      prefixSeparator: string;
      dropOriginal: boolean;
      stepId: string;
    }>
  | Readonly<{
      kind: "multiLabelBinarize";
      sourceId: string;
      sourceName: string;
      sourcePosition: number;
      sourceKind: string;
      sourceStorageMode: string;
      sourceClasses: readonly string[];
      sourceTimezone: string | null;
      sourceUnits: string | null;
      delimiter: string;
      prefix: string;
      dropOriginal: boolean;
      stepId: string;
    }>;

export function assertReleasedRGeneratedSourceBoundary(code: string, variableName = "orders_frame"): void {
  assertCodePreviewDocumentChecks(code, [
    { stage: "released-r:source-boundary:prefix", passed: /^base::evalq\(\{/u.test(code) },
    {
      stage: "released-r:source-boundary:generated-result",
      passed: code.includes(".ow_generated_result <- base::evalq({")
    },
    {
      stage: "released-r:source-boundary:caller-read",
      passed: code.includes(
        `base::get(${JSON.stringify(variableName)}, envir = .ow_source_environment, inherits = FALSE)`
      )
    },
    {
      stage: "released-r:source-boundary:caller-environment",
      passed: code.includes("base::list(.ow_caller_environment = base::environment())")
    },
    {
      stage: "released-r:source-boundary:source-environment",
      passed: code.includes(
        "base::list(.ow_source_environment = .ow_caller_environment, .ow_custom_parent_environment = .ow_caller_environment)"
      )
    },
    {
      stage: "released-r:source-boundary:publication",
      passed: code.includes(
        "base::assign(.ow_publication_name, .ow_generated_result, envir = .ow_caller_environment, inherits = FALSE)"
      )
    },
    { stage: "released-r:source-boundary:base-parent", passed: code.includes("parent = base::baseenv()") },
    {
      stage: "released-r:source-boundary:legacy-result-absent",
      passed: !/open_wrangler_result <- base::evalq/u.test(code)
    },
    {
      stage: "released-r:source-boundary:dynamic-parent-absent",
      passed: !/parent\.env\(environment\(\)\)/u.test(code)
    }
  ]);
}

function assertReleasedROnly(code: string): void {
  assert.doesNotMatch(code, /\b(?:pandas|polars|python)\b/iu);
}

export function assertReleasedRRowGeneratedCode(code: string, kind: "sortRows" | "filterRows"): void {
  assertReleasedRGeneratedSourceBoundary(code);
  assert.ok(code.includes(kind === "sortRows" ? "# Sort rows" : "# Filter rows"));
  assert.ok(code.includes(".ow_rows"));
  assert.ok(code.includes(".ow_sort_values"));
  if (kind === "filterRows") assert.ok(code.includes(".ow_filter_mask_1"));
  assertReleasedROnly(code);
}

export function assertReleasedRRowReductionGeneratedCode(
  code: string,
  kind: "dropMissingRows" | "dropDuplicates"
): void {
  assertReleasedRGeneratedSourceBoundary(code);
  assert.ok(code.includes(kind === "dropMissingRows" ? "# Drop missing rows" : "# Drop duplicates"));
  assert.ok(code.includes(".ow_rows"));
  assertReleasedROnly(code);
}

export function assertReleasedRGeneratedCode(code: string, newName: string, variableName = "orders_frame"): void {
  assertReleasedRGeneratedSourceBoundary(code, variableName);
  assert.ok(code.includes(JSON.stringify(newName)), `Generated R code must contain ${JSON.stringify(newName)}.`);
  assertReleasedROnly(code);
}

export function assertReleasedRCustomCodeGeneratedCode(
  code: string,
  customCode: string,
  variableName = "orders_frame"
): void {
  assertReleasedRGeneratedSourceBoundary(code, variableName);
  assert.ok(
    code.includes(JSON.stringify(customCode)),
    "Generated R must preserve the exact Custom code source as one quoted scalar."
  );
  assert.ok(
    code.includes("base::parse(text = .ow_custom_code"),
    "Generated R Custom code must parse only the safely quoted scalar."
  );
  assertReleasedROnly(code);
}

export function releasedRCategoricalGeneratedCall(expected: ReleasedRCategoricalGeneratedExpectation): string {
  const operationArguments =
    expected.kind === "oneHotEncode"
      ? `${JSON.stringify(expected.prefixSeparator)}, NULL, NULL`
      : `NULL, ${JSON.stringify(expected.delimiter)}, ${JSON.stringify(expected.prefix)}`;
  const sourceClasses =
    expected.sourceClasses.length === 0
      ? "character()"
      : `c(${expected.sourceClasses.map((value) => JSON.stringify(value)).join(", ")})`;
  const sourceTimezone = expected.sourceTimezone === null ? "NULL" : JSON.stringify(expected.sourceTimezone);
  const sourceUnits = expected.sourceUnits === null ? "NULL" : JSON.stringify(expected.sourceUnits);
  return (
    `  .ow_categorical_result <- .ow_categorical_encode(.ow_result, ${JSON.stringify(expected.kind)}, ` +
    `list(list(id = ${JSON.stringify(expected.sourceId)}, name = ${JSON.stringify(expected.sourceName)}, ` +
    `position = ${expected.sourcePosition}L, kind = ${JSON.stringify(expected.sourceKind)}, ` +
    `storageMode = ${JSON.stringify(expected.sourceStorageMode)}, classes = ${sourceClasses}, ` +
    `timezone = ${sourceTimezone}, units = ${sourceUnits})), ${operationArguments}, ` +
    `${expected.dropOriginal ? "TRUE" : "FALSE"}, ` +
    `2048L, 1024L, 8192L, 16777216L, 67108864L, 8L, 1024L, 512L, .ow_result_ids, ` +
    `${JSON.stringify(expected.stepId)})`
  );
}

export function assertReleasedRCategoricalGeneratedCode(
  code: string,
  expected: ReleasedRCategoricalGeneratedExpectation
): void {
  assertReleasedRGeneratedSourceBoundary(code);
  const expectedCall = releasedRCategoricalGeneratedCall(expected);
  const lines = code.split(/\r?\n/u);
  const calls = lines.filter((line) => line.startsWith("  .ow_categorical_result <- .ow_categorical_encode("));
  assert.deepEqual(calls, [expectedCall], "Generated R must contain one exact categorical operation call.");
  const callIndex = lines.indexOf(expectedCall);
  assert.deepEqual(
    lines.slice(callIndex, callIndex + 4),
    [
      expectedCall,
      '  .ow_result <- base::.subset2(.ow_categorical_result, "value")',
      '  .ow_result_ids <- base::.subset2(.ow_categorical_result, "outputIds")',
      "  base::rm(.ow_categorical_result)"
    ],
    "Generated R must publish the categorical value and lineage from the exact result wrapper."
  );
  assertReleasedROnly(code);
}

export function assertReleasedRFormulaGeneratedCode(
  code: string,
  sourceName: string,
  newName: string,
  operator: "add" | "subtract" | "multiply" | "divide" | "modulo" | "power",
  value: number,
  variableName = "orders_frame"
): void {
  assertReleasedRGeneratedSourceBoundary(code, variableName);
  assert.ok(code.includes(".ow_formula_left_position"));
  assert.ok(code.includes(".ow_formula_values"));
  assert.ok(code.includes(JSON.stringify(sourceName)));
  assert.ok(code.includes(JSON.stringify(newName)));
  assert.ok(code.includes(String(value)));
  const symbol = { add: "+", subtract: "-", multiply: "*", divide: "/", modulo: "%%", power: "^" }[operator];
  assert.ok(code.includes(`.ow_formula_left ${symbol} .ow_formula_right`));
  assertReleasedROnly(code);
}

export function assertReleasedRFormatDatetimeGeneratedCode(
  code: string,
  sourceName: string,
  newName: string,
  format: string,
  variableName = "orders_frame"
): void {
  assertReleasedRGeneratedSourceBoundary(code, variableName);
  assert.ok(code.includes(".ow_datetime_position"));
  assert.ok(code.includes(".ow_datetime_values"));
  assert.ok(code.includes("base::format"));
  assert.ok(code.includes(JSON.stringify(sourceName)));
  assert.ok(code.includes(JSON.stringify(newName)));
  assert.ok(code.includes(JSON.stringify(format)));
  assertReleasedROnly(code);
}

export function assertReleasedRDropGeneratedCode(
  code: string,
  sourceName: string,
  variableName = "orders_frame"
): void {
  assertReleasedRGeneratedSourceBoundary(code, variableName);
  assertCodePreviewDocumentChecks(code, [
    { stage: "released-r:drop:positions", passed: code.includes(".ow_drop_positions") },
    { stage: "released-r:drop:source-reference", passed: code.includes(JSON.stringify(sourceName)) },
    { stage: "released-r:drop:r-only", passed: !/\b(?:pandas|polars|python)\b/iu.test(code) }
  ]);
}

export function assertReleasedRTextLengthGeneratedCode(
  code: string,
  sourceName: string,
  newColumn: string,
  variableName = "orders_frame"
): void {
  assertReleasedRGeneratedSourceBoundary(code, variableName);
  assert.ok(code.includes(".ow_text_length_position"));
  assert.ok(code.includes("nchar("));
  assert.ok(code.includes(JSON.stringify(sourceName)));
  assert.ok(code.includes(JSON.stringify(newColumn)));
  assertReleasedROnly(code);
}

export function assertReleasedRFindReplaceGeneratedCode(
  code: string,
  sourceName: string,
  find: string,
  replacement: string,
  regex: boolean,
  variableName = "orders_frame"
): void {
  assertReleasedRFindReplaceCodeSurface(code, sourceName, find, replacement, regex, variableName);
  assert.ok(code.includes("gsub("));
}

export function assertReleasedRFindReplaceCodeSurface(
  code: string,
  sourceName: string,
  find: string,
  replacement: string,
  regex: boolean,
  variableName = "orders_frame"
): void {
  assertReleasedRGeneratedSourceBoundary(code, variableName);
  assert.ok(code.includes(".ow_text_position"));
  assert.ok(code.includes(JSON.stringify(sourceName)));
  assert.ok(code.includes(`.ow_text_find <- ${JSON.stringify(find)}`));
  assert.ok(code.includes(`.ow_text_replacement <- ${JSON.stringify(replacement)}`));
  assert.ok(code.includes(`.ow_text_regex <- ${regex ? "TRUE" : "FALSE"}`));
  assertReleasedROnly(code);
}

export function assertReleasedRCastGeneratedCode(
  code: string,
  sourceName: string,
  dtype: string,
  variableName = "orders_frame"
): void {
  assertReleasedRGeneratedSourceBoundary(code, variableName);
  assert.ok(code.includes(".ow_cast_position"));
  assert.ok(code.includes(".ow_cast_values"));
  assert.ok(code.includes(JSON.stringify(sourceName)));
  assert.ok(code.includes(JSON.stringify(dtype)));
  assertReleasedROnly(code);
}

export function assertReleasedRCloneGeneratedCode(
  code: string,
  sourceName: string,
  newName: string,
  variableName = "orders_frame"
): void {
  assertReleasedRGeneratedSourceBoundary(code, variableName);
  assert.ok(code.includes(".ow_clone_position"));
  assert.ok(code.includes(JSON.stringify(sourceName)));
  assert.ok(code.includes(JSON.stringify(newName)));
  assertReleasedROnly(code);
}

export function assertReleasedRSelectGeneratedCode(
  code: string,
  selectedNames: readonly string[],
  variableName = "orders_frame"
): void {
  assertReleasedRGeneratedSourceBoundary(code, variableName);
  assert.ok(code.includes(".ow_select_positions"));
  for (const name of selectedNames) assert.ok(code.includes(JSON.stringify(name)));
  assertReleasedROnly(code);
}
