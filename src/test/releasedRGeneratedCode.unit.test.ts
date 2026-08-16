import { describe, expect, it } from "vitest";
import {
  assertReleasedRCastGeneratedCode,
  assertReleasedRCategoricalGeneratedCode,
  assertReleasedRCloneGeneratedCode,
  assertReleasedRCustomCodeGeneratedCode,
  assertReleasedRDropGeneratedCode,
  assertReleasedRFindReplaceCodeSurface,
  assertReleasedRFindReplaceGeneratedCode,
  assertReleasedRFormatDatetimeGeneratedCode,
  assertReleasedRFormulaGeneratedCode,
  assertReleasedRGeneratedCode,
  assertReleasedRGeneratedSourceBoundary,
  assertReleasedRRowGeneratedCode,
  assertReleasedRRowReductionGeneratedCode,
  assertReleasedRSelectGeneratedCode,
  assertReleasedRTextLengthGeneratedCode,
  releasedRCategoricalGeneratedCall,
  type ReleasedRCategoricalGeneratedExpectation
} from "./extensionHost/releasedRGeneratedCode";

function generatedR(body: readonly string[], variableName = "orders_frame"): string {
  return [
    "base::evalq({",
    "  .ow_caller_environment <- base::environment()",
    "  .ow_source_environment <- base::list2env(",
    "    base::list(.ow_caller_environment = base::environment()), parent = base::baseenv()",
    "  )",
    `  .ow_result <- base::get(${JSON.stringify(variableName)}, envir = .ow_source_environment, inherits = FALSE)`,
    "  .ow_generated_result <- base::evalq({",
    ...body,
    "  }, envir = base::list2env(",
    "    base::list(.ow_source_environment = .ow_caller_environment, .ow_custom_parent_environment = .ow_caller_environment),",
    "    parent = base::baseenv()",
    "  ))",
    '  .ow_publication_name <- "open_wrangler_result"',
    "  base::assign(.ow_publication_name, .ow_generated_result, envir = .ow_caller_environment, inherits = FALSE)",
    "}, envir = base::new.env(parent = base::baseenv()))"
  ].join("\n");
}

const oneHotExpectation: ReleasedRCategoricalGeneratedExpectation = {
  kind: "oneHotEncode",
  sourceId: "r:c:1",
  sourceName: 'group "quoted"',
  sourcePosition: 2,
  sourceKind: "character",
  sourceStorageMode: "character",
  sourceClasses: ["ordered", "factor"],
  sourceTimezone: "Europe/Berlin",
  sourceUnits: null,
  prefixSeparator: "::",
  dropOriginal: true,
  stepId: "categorical-step"
};

const multiLabelExpectation: ReleasedRCategoricalGeneratedExpectation = {
  kind: "multiLabelBinarize",
  sourceId: "r:c:2",
  sourceName: "labels",
  sourcePosition: 3,
  sourceKind: "character",
  sourceStorageMode: "character",
  sourceClasses: [],
  sourceTimezone: null,
  sourceUnits: "items",
  delimiter: "|",
  prefix: "label_",
  dropOriginal: false,
  stepId: "multi-label-step"
};

describe("released R generated-code contracts", () => {
  it("accepts only the isolated caller/source/publication boundary", () => {
    const code = generatedR(["  .ow_generated_result <- .ow_result"]);
    expect(() => assertReleasedRGeneratedSourceBoundary(code)).not.toThrow();

    expect(() =>
      assertReleasedRGeneratedSourceBoundary(code.replaceAll("parent = base::baseenv()", "parent = emptyenv()"))
    ).toThrowError(/base-parent/u);
    expect(() =>
      assertReleasedRGeneratedSourceBoundary(`${code}\nopen_wrangler_result <- base::evalq({})`)
    ).toThrowError(/legacy-result-absent/u);
    expect(() => assertReleasedRGeneratedSourceBoundary(`${code}\nparent.env(environment())`)).toThrowError(
      /dynamic-parent-absent/u
    );
  });

  it("serializes exact categorical source metadata and fixed resource limits", () => {
    const oneHot = releasedRCategoricalGeneratedCall(oneHotExpectation);
    expect(oneHot).toContain('id = "r:c:1", name = "group \\"quoted\\"", position = 2L');
    expect(oneHot).toContain('classes = c("ordered", "factor"), timezone = "Europe/Berlin", units = NULL');
    expect(oneHot).toContain('"::", NULL, NULL, TRUE');
    expect(oneHot).toContain("2048L, 1024L, 8192L, 16777216L, 67108864L, 8L, 1024L, 512L");

    const multiLabel = releasedRCategoricalGeneratedCall(multiLabelExpectation);
    expect(multiLabel).toContain('classes = character(), timezone = NULL, units = "items"');
    expect(multiLabel).toContain('NULL, "|", "label_", FALSE');
  });

  it("requires one exact categorical call and its value/lineage publication", () => {
    const call = releasedRCategoricalGeneratedCall(oneHotExpectation);
    const code = generatedR([
      call,
      '  .ow_result <- base::.subset2(.ow_categorical_result, "value")',
      '  .ow_result_ids <- base::.subset2(.ow_categorical_result, "outputIds")',
      "  base::rm(.ow_categorical_result)"
    ]);
    expect(() => assertReleasedRCategoricalGeneratedCode(code, oneHotExpectation)).not.toThrow();
    expect(() => assertReleasedRCategoricalGeneratedCode(`${code}\n${call}`, oneHotExpectation)).toThrowError(
      /one exact categorical operation call/u
    );
    expect(() =>
      assertReleasedRCategoricalGeneratedCode(
        code.replace('base::.subset2(.ow_categorical_result, "value")', "NULL"),
        oneHotExpectation
      )
    ).toThrowError(/publish the categorical value and lineage/u);
  });

  it("owns row, structural, text, datetime, cast, clone, and select markers", () => {
    const code = generatedR([
      "  # Sort rows",
      "  # Filter rows",
      "  # Drop missing rows",
      "  # Drop duplicates",
      "  .ow_rows <- integer()",
      "  .ow_sort_values <- NULL",
      "  .ow_filter_mask_1 <- logical()",
      "  .ow_formula_left_position <- 1L",
      "  .ow_formula_values <- .ow_formula_left + .ow_formula_right",
      '  .ow_datetime_position <- "ordered_at"',
      "  .ow_datetime_values <- base::format(.ow_result)",
      '  .ow_datetime_format <- "%Y-%m-%d"',
      '  .ow_drop_positions <- "obsolete"',
      '  .ow_text_length_position <- "label"',
      '  text_size <- nchar("label")',
      '  .ow_text_length_output <- "text_size"',
      '  .ow_text_position <- "label"',
      '  .ow_text_find <- "before"',
      '  .ow_text_replacement <- "after"',
      "  .ow_text_regex <- TRUE",
      "  replaced <- gsub(.ow_text_find, .ow_text_replacement, .ow_result)",
      '  .ow_cast_position <- "score"',
      '  .ow_cast_values <- "double"',
      '  .ow_clone_position <- "label"',
      '  .ow_select_positions <- c("label", "score")',
      '  output_names <- c("score_plus_2", "formatted_date", "label_copy")'
    ]);

    expect(() => assertReleasedRRowGeneratedCode(code, "sortRows")).not.toThrow();
    expect(() => assertReleasedRRowGeneratedCode(code, "filterRows")).not.toThrow();
    expect(() => assertReleasedRRowReductionGeneratedCode(code, "dropMissingRows")).not.toThrow();
    expect(() => assertReleasedRRowReductionGeneratedCode(code, "dropDuplicates")).not.toThrow();
    expect(() => assertReleasedRFormulaGeneratedCode(code, "score", "score_plus_2", "add", 2)).not.toThrow();
    expect(() =>
      assertReleasedRFormatDatetimeGeneratedCode(code, "ordered_at", "formatted_date", "%Y-%m-%d")
    ).not.toThrow();
    expect(() => assertReleasedRDropGeneratedCode(code, "obsolete")).not.toThrow();
    expect(() => assertReleasedRTextLengthGeneratedCode(code, "label", "text_size")).not.toThrow();
    expect(() => assertReleasedRFindReplaceCodeSurface(code, "label", "before", "after", true)).not.toThrow();
    expect(() => assertReleasedRFindReplaceGeneratedCode(code, "label", "before", "after", true)).not.toThrow();
    expect(() => assertReleasedRCastGeneratedCode(code, "score", "double")).not.toThrow();
    expect(() => assertReleasedRCloneGeneratedCode(code, "label", "label_copy")).not.toThrow();
    expect(() => assertReleasedRSelectGeneratedCode(code, ["label", "score"])).not.toThrow();
    expect(() => assertReleasedRGeneratedCode(code, "score_plus_2")).not.toThrow();
  });

  it("preserves custom code as one quoted scalar and rejects foreign-engine code", () => {
    const custom = 'result <- transform(frame, label = "safe")';
    const code = generatedR([
      `  .ow_custom_code <- ${JSON.stringify(custom)}`,
      "  base::parse(text = .ow_custom_code)"
    ]);
    expect(() => assertReleasedRCustomCodeGeneratedCode(code, custom)).not.toThrow();
    expect(() => assertReleasedRCustomCodeGeneratedCode(`${code}\npandas`, custom)).toThrow();
  });
});
