import type {
  ByExampleProgram,
  ByExampleTransformStep,
  ColumnSchema,
  FilterRowsTransformStep,
  GroupByTransformStep,
  OneHotEncodeTransformStep,
  RetainedTransformStep,
  SortRowsTransformStep
} from "../../shared/protocol";
import { isRetainedTransformStep } from "../../shared/protocolValidation";
import type { RKernelColumnReference } from "./rKernelProtocol";
import {
  copyFillMissingReplacement,
  isRNumericRoundingStep,
  type RRetainedByExampleStep,
  type RTransformStep,
  type RTransformStepWithoutByExample
} from "./rKernelTransformBinding";

export function copyByExampleProgram(program: ByExampleProgram): ByExampleProgram {
  if (program.kind === "column") return { kind: "column", column: { ...program.column } };
  if (program.kind === "literal") return { kind: "literal", value: program.value };
  if (program.kind === "slice") {
    return {
      kind: "slice",
      input: copyByExampleProgram(program.input),
      start: program.start,
      ...(program.stop === undefined ? {} : { stop: program.stop })
    };
  }
  if (program.kind === "split") {
    return {
      kind: "split",
      input: copyByExampleProgram(program.input),
      delimiter: program.delimiter,
      index: program.index
    };
  }
  if (program.kind === "concat") {
    const parts = program.parts.map(copyByExampleProgram);
    const first = parts[0];
    if (!first) throw new TypeError("A retained by-example concat program requires at least one part.");
    return { kind: "concat", parts: [first, ...parts.slice(1)] };
  }
  if (program.kind === "regexExtract") {
    return {
      kind: "regexExtract",
      input: copyByExampleProgram(program.input),
      pattern: program.pattern,
      group: program.group
    };
  }
  if (program.kind === "regexReplace") {
    return {
      kind: "regexReplace",
      input: copyByExampleProgram(program.input),
      pattern: program.pattern,
      replacement: program.replacement
    };
  }
  if (program.kind === "case") {
    return { kind: "case", style: program.style, input: copyByExampleProgram(program.input) };
  }
  if (program.kind === "datetimeFormat") {
    return {
      kind: "datetimeFormat",
      input: copyByExampleProgram(program.input),
      inputFormat: program.inputFormat,
      outputFormat: program.outputFormat
    };
  }
  return {
    kind: "arithmetic",
    left: copyByExampleProgram(program.left),
    operator: program.operator,
    right: copyByExampleProgram(program.right)
  };
}

export function copyRTransformStep(step: RTransformStep): RTransformStep {
  if (step.kind === "customCode") {
    return { id: step.id, kind: "customCode", params: { code: step.params.code } };
  }
  if (step.kind === "byExample") {
    const sourceColumns = step.params.sourceColumns.map((column) => ({ ...column }));
    const firstSource = sourceColumns[0];
    const examples = step.params.examples.map((example) => ({ inputs: [...example.inputs], output: example.output }));
    const firstExample = examples[0];
    const secondExample = examples[1];
    if (!firstSource || !firstExample || !secondExample) {
      throw new TypeError("A retained by-example step is missing its bounded sources or examples.");
    }
    return {
      id: step.id,
      kind: "byExample",
      params: {
        sourceColumns: sourceColumns as ByExampleTransformStep["params"]["sourceColumns"],
        newColumn: step.params.newColumn,
        examples: examples as ByExampleTransformStep["params"]["examples"],
        program: copyByExampleProgram(step.params.program),
        warnings: [...step.params.warnings],
        candidateCount: step.params.candidateCount
      }
    };
  }
  if (step.kind === "sortRows") {
    const rules = step.params.rules.map((rule) => ({ ...rule, column: { ...rule.column } }));
    const first = rules[0];
    if (!first) throw new TypeError("Sort rows requires at least one R sort rule.");
    return {
      id: step.id,
      kind: "sortRows",
      params: { rules: rules as SortRowsTransformStep["params"]["rules"] }
    };
  }
  if (step.kind === "filterRows") {
    return {
      id: step.id,
      kind: "filterRows",
      params: { filterModel: copyTransformFilterModel(step.params.filterModel) }
    };
  }
  if (step.kind === "dropMissingRows") {
    return {
      id: step.id,
      kind: "dropMissingRows",
      params: {
        ...(step.params.columns === undefined ? {} : { columns: step.params.columns.map((column) => ({ ...column })) }),
        ...(step.params.how === undefined ? {} : { how: step.params.how })
      }
    };
  }
  if (step.kind === "dropDuplicates") {
    const columns = step.params.columns?.map((column) => ({ ...column }));
    if (columns !== undefined && !columns[0]) {
      throw new TypeError("Drop duplicates requires at least one R column when a selection is supplied.");
    }
    return {
      id: step.id,
      kind: "dropDuplicates",
      params: {
        ...(columns === undefined
          ? {}
          : {
              columns: columns as [RKernelColumnReference, ...RKernelColumnReference[]]
            }),
        ...(step.params.keep === undefined ? {} : { keep: step.params.keep })
      }
    };
  }
  if (step.kind === "groupBy") {
    const keys = step.params.keys.map((column) => ({ ...column }));
    const aggregations = step.params.aggregations.map((aggregation) => ({
      column: { ...aggregation.column },
      operation: aggregation.operation,
      alias: aggregation.alias
    }));
    if (!keys[0] || !aggregations[0]) throw new TypeError("Group and aggregate requires a key and an aggregation.");
    return {
      id: step.id,
      kind: "groupBy",
      params: {
        keys: keys as GroupByTransformStep["params"]["keys"],
        aggregations: aggregations as GroupByTransformStep["params"]["aggregations"]
      }
    };
  }
  if (step.kind === "selectColumns") {
    const columns = step.params.columns.map((column) => ({ ...column }));
    if (!columns[0]) throw new TypeError("Select Columns requires at least one R column.");
    return {
      id: step.id,
      kind: "selectColumns",
      params: { columns: columns as [RKernelColumnReference, ...RKernelColumnReference[]] }
    };
  }
  if (step.kind === "dropColumns") {
    const columns = step.params.columns.map((column) => ({ ...column }));
    if (!columns[0]) throw new TypeError("Drop Columns requires at least one R column.");
    return {
      id: step.id,
      kind: "dropColumns",
      params: { columns: columns as [RKernelColumnReference, ...RKernelColumnReference[]] }
    };
  }
  if (step.kind === "cloneColumn") {
    return {
      id: step.id,
      kind: "cloneColumn",
      params: { column: { ...step.params.column }, newName: step.params.newName }
    };
  }
  if (step.kind === "fillMissingValues") {
    return {
      id: step.id,
      kind: "fillMissingValues",
      params: { column: { ...step.params.column }, replacement: copyFillMissingReplacement(step.params.replacement) }
    };
  }
  if (step.kind === "castColumn") {
    return {
      id: step.id,
      kind: "castColumn",
      params: { column: { ...step.params.column }, dtype: step.params.dtype }
    };
  }
  if (step.kind === "formula") {
    return {
      id: step.id,
      kind: "formula",
      params: {
        leftColumn: { ...step.params.leftColumn },
        operator: step.params.operator,
        newColumn: step.params.newColumn,
        ...(step.params.rightColumn === undefined
          ? { value: step.params.value as number }
          : { rightColumn: { ...step.params.rightColumn } })
      }
    };
  }
  if (step.kind === "textLength") {
    return {
      id: step.id,
      kind: "textLength",
      params: { column: { ...step.params.column }, newColumn: step.params.newColumn }
    };
  }
  if (step.kind === "oneHotEncode") {
    const columns = step.params.columns.map((column) => ({ ...column }));
    if (!columns[0]) throw new TypeError("One-hot encoding requires at least one R column.");
    return {
      id: step.id,
      kind: "oneHotEncode",
      params: {
        columns: columns as OneHotEncodeTransformStep["params"]["columns"],
        ...(step.params.prefixSeparator === undefined ? {} : { prefixSeparator: step.params.prefixSeparator }),
        ...(step.params.dropOriginal === undefined ? {} : { dropOriginal: step.params.dropOriginal })
      }
    };
  }
  if (step.kind === "multiLabelBinarize") {
    return {
      id: step.id,
      kind: "multiLabelBinarize",
      params: {
        column: { ...step.params.column },
        delimiter: step.params.delimiter,
        ...(step.params.prefix === undefined ? {} : { prefix: step.params.prefix }),
        ...(step.params.dropOriginal === undefined ? {} : { dropOriginal: step.params.dropOriginal })
      }
    };
  }
  if (step.kind === "capitalizeText") {
    return {
      id: step.id,
      kind: "capitalizeText",
      params: {
        column: { ...step.params.column },
        ...(step.params.newColumn === undefined ? {} : { newColumn: step.params.newColumn })
      }
    };
  }
  if (step.kind === "stripText") {
    return {
      id: step.id,
      kind: "stripText",
      params: {
        column: { ...step.params.column },
        ...(step.params.characters === undefined ? {} : { characters: step.params.characters }),
        ...(step.params.newColumn === undefined ? {} : { newColumn: step.params.newColumn })
      }
    };
  }
  if (step.kind === "splitText") {
    return {
      id: step.id,
      kind: "splitText",
      params: {
        column: { ...step.params.column },
        delimiter: step.params.delimiter,
        index: step.params.index,
        newColumn: step.params.newColumn
      }
    };
  }
  if (step.kind === "splitTextColumns") {
    return {
      id: step.id,
      kind: "splitTextColumns",
      params: {
        column: { ...step.params.column },
        delimiter: step.params.delimiter,
        newColumns: [...step.params.newColumns]
      }
    };
  }
  if (step.kind === "lowerText") {
    return {
      id: step.id,
      kind: "lowerText",
      params: {
        column: { ...step.params.column },
        ...(step.params.newColumn === undefined ? {} : { newColumn: step.params.newColumn })
      }
    };
  }
  if (step.kind === "upperText") {
    return {
      id: step.id,
      kind: "upperText",
      params: {
        column: { ...step.params.column },
        ...(step.params.newColumn === undefined ? {} : { newColumn: step.params.newColumn })
      }
    };
  }
  if (step.kind === "findReplace") {
    return {
      id: step.id,
      kind: "findReplace",
      params: {
        column: { ...step.params.column },
        find: step.params.find,
        replacement: step.params.replacement,
        ...(step.params.regex === undefined ? {} : { regex: step.params.regex }),
        ...(step.params.newColumn === undefined ? {} : { newColumn: step.params.newColumn })
      }
    };
  }
  if (isRNumericRoundingStep(step)) {
    return {
      id: step.id,
      kind: step.kind,
      params: {
        column: { ...step.params.column },
        ...(step.kind === "roundNumber" && step.params.decimals !== undefined
          ? { decimals: step.params.decimals }
          : {}),
        ...(step.params.newColumn === undefined ? {} : { newColumn: step.params.newColumn })
      }
    };
  }
  if (step.kind === "minMaxScale") {
    return {
      id: step.id,
      kind: "minMaxScale",
      params: {
        column: { ...step.params.column },
        ...(step.params.newColumn === undefined ? {} : { newColumn: step.params.newColumn })
      }
    };
  }
  if (step.kind === "formatDatetime") {
    return {
      id: step.id,
      kind: "formatDatetime",
      params: {
        column: { ...step.params.column },
        format: step.params.format,
        ...(step.params.newColumn === undefined ? {} : { newColumn: step.params.newColumn })
      }
    };
  }
  return {
    id: step.id,
    kind: "renameColumn",
    params: { column: { ...step.params.column }, newName: step.params.newName }
  };
}

export function copyTransformFilterModel(
  model: FilterRowsTransformStep["params"]["filterModel"]
): FilterRowsTransformStep["params"]["filterModel"] {
  return {
    ...(model.logic ? { logic: model.logic } : {}),
    filters: model.filters.map((filter) => ({
      ...filter,
      column: { ...filter.column },
      predicates: filter.predicates.map((predicate) => ({ ...predicate })),
      ...(filter.valueFilter
        ? {
            valueFilter: {
              ...filter.valueFilter,
              selectedValues: [...filter.valueFilter.selectedValues]
            }
          }
        : {})
    })),
    sort: model.sort.map((rule) => ({ ...rule, column: { ...rule.column } }))
  };
}

export function copyRetainedStep(step: RetainedTransformStep): RetainedTransformStep {
  if (
    step.kind !== "sortRows" &&
    step.kind !== "filterRows" &&
    step.kind !== "dropMissingRows" &&
    step.kind !== "fillMissingValues" &&
    step.kind !== "dropDuplicates" &&
    step.kind !== "renameColumn" &&
    step.kind !== "cloneColumn" &&
    step.kind !== "castColumn" &&
    step.kind !== "formula" &&
    step.kind !== "textLength" &&
    step.kind !== "oneHotEncode" &&
    step.kind !== "multiLabelBinarize" &&
    step.kind !== "findReplace" &&
    step.kind !== "stripText" &&
    step.kind !== "splitText" &&
    step.kind !== "splitTextColumns" &&
    step.kind !== "capitalizeText" &&
    step.kind !== "lowerText" &&
    step.kind !== "upperText" &&
    step.kind !== "minMaxScale" &&
    step.kind !== "roundNumber" &&
    step.kind !== "floorNumber" &&
    step.kind !== "ceilNumber" &&
    step.kind !== "formatDatetime" &&
    step.kind !== "groupBy" &&
    step.kind !== "byExample" &&
    step.kind !== "customCode" &&
    step.kind !== "dropColumns" &&
    step.kind !== "selectColumns"
  ) {
    throw new TypeError("The R bridge retained an unsupported cleaning step.");
  }
  if (step.kind === "byExample") {
    if (
      !isRetainedTransformStep(step) ||
      step.params.warnings === undefined ||
      step.params.candidateCount === undefined
    ) {
      throw new TypeError("The R bridge retained an incomplete by-example step.");
    }
    return copyRTransformStep(step as RRetainedByExampleStep);
  }
  return copyRTransformStep(step as RTransformStepWithoutByExample);
}

export function retainedKeyPrefix(
  sourceKeyColumnIds: readonly string[],
  schema: readonly ColumnSchema[]
): readonly string[] {
  const ids = new Set(schema.map((column) => column.id));
  const retained: string[] = [];
  for (const id of sourceKeyColumnIds) {
    if (!ids.has(id)) break;
    retained.push(id);
  }
  return retained;
}
