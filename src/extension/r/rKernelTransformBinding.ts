import { Buffer } from "node:buffer";
import type {
  ByExampleProgram,
  ByExampleTransformStep,
  CapitalizeTextTransformStep,
  CastColumnTransformStep,
  CeilNumberTransformStep,
  CloneColumnTransformStep,
  ColumnSchema,
  CustomCodeTransformStep,
  DropColumnsTransformStep,
  DropDuplicatesTransformStep,
  DropMissingRowsTransformStep,
  FillMissingReplacement,
  FillMissingValuesTransformStep,
  FilterRowsTransformStep,
  FindReplaceTransformStep,
  FloorNumberTransformStep,
  FormulaTransformStep,
  FormatDatetimeTransformStep,
  GroupByTransformStep,
  LowerTextTransformStep,
  MinMaxScaleTransformStep,
  MultiLabelBinarizeTransformStep,
  OneHotEncodeTransformStep,
  RenameColumnTransformStep,
  RoundNumberTransformStep,
  SelectColumnsTransformStep,
  SortRowsTransformStep,
  SplitTextTransformStep,
  SplitTextColumnsTransformStep,
  StripTextTransformStep,
  TextLengthTransformStep,
  UpperTextTransformStep
} from "../../shared/protocol";
import { isTransformStep } from "../../shared/protocolValidation";
import { R_FRAME_CONTRACT_LIMITS } from "./rFrameContract";
import {
  assertRKernelByExampleTransportStrings,
  assertRKernelCustomCodeTransportCode,
  type RKernelColumnReference,
  type RKernelFillMissingReplacement,
  type RKernelGroupByStep,
  type RKernelSortRule,
  type RKernelTransformStep
} from "./rKernelProtocol";
import {
  requireRTransformColumn as requireTransformColumn,
  resolveRTransformFilterModel as resolveTransformFilterModel,
  resolveRTransformSortRules as resolveTransformSortRules
} from "./rKernelViewContract";

const R_PRIVATE_ROW_ID_PREFIX = "__open_wrangler_internal_row_id_";
export type RTransformStepWithoutByExample =
  | SortRowsTransformStep
  | FilterRowsTransformStep
  | DropMissingRowsTransformStep
  | FillMissingValuesTransformStep
  | DropDuplicatesTransformStep
  | RenameColumnTransformStep
  | CloneColumnTransformStep
  | CastColumnTransformStep
  | FormulaTransformStep
  | TextLengthTransformStep
  | FindReplaceTransformStep
  | StripTextTransformStep
  | SplitTextTransformStep
  | SplitTextColumnsTransformStep
  | CapitalizeTextTransformStep
  | LowerTextTransformStep
  | UpperTextTransformStep
  | MinMaxScaleTransformStep
  | RoundNumberTransformStep
  | FloorNumberTransformStep
  | CeilNumberTransformStep
  | FormatDatetimeTransformStep
  | OneHotEncodeTransformStep
  | MultiLabelBinarizeTransformStep
  | GroupByTransformStep
  | CustomCodeTransformStep
  | DropColumnsTransformStep
  | SelectColumnsTransformStep;

export type RRetainedByExampleStep = ByExampleTransformStep &
  Readonly<{
    params: ByExampleTransformStep["params"] &
      Readonly<{
        program: ByExampleProgram;
        warnings: string[];
        candidateCount: number;
      }>;
  }>;

export type RTransformStep = RTransformStepWithoutByExample | RRetainedByExampleStep;
export type RPreviewTransformStep = RTransformStepWithoutByExample | ByExampleTransformStep;

type FallbackFillMissingReplacement = Extract<FillMissingReplacement, { kind: "fallbackColumns" }>;
type DirectionalFillMissingReplacement = Extract<FillMissingReplacement, { kind: "directional" }>;
type GroupedFillMissingReplacement = Extract<FillMissingReplacement, { kind: "groupedStatistic" }>;
type LinearInterpolationFillMissingReplacement = Extract<FillMissingReplacement, { kind: "linearInterpolation" }>;

export function copyFillMissingReplacement(replacement: FillMissingReplacement): FillMissingReplacement {
  if (replacement.kind === "linearInterpolation") {
    return {
      kind: "linearInterpolation",
      coordinate: { ...replacement.coordinate },
      ...(replacement.maxGap === undefined ? {} : { maxGap: replacement.maxGap })
    };
  }
  if (replacement.kind === "groupedStatistic") {
    const keys = replacement.keys.map((key) => ({ ...key }));
    if (!keys[0]) throw new TypeError("Grouped fill requires at least one grouping column.");
    return {
      kind: "groupedStatistic",
      statistic: replacement.statistic,
      keys: keys as GroupedFillMissingReplacement["keys"]
    };
  }
  if (replacement.kind === "directional") {
    const orderBy = replacement.orderBy.map((rule) => ({ ...rule, column: { ...rule.column } }));
    if (!orderBy[0]) throw new TypeError("Directional fill requires at least one ordering column.");
    return {
      kind: "directional",
      direction: replacement.direction,
      orderBy: orderBy as DirectionalFillMissingReplacement["orderBy"],
      ...(replacement.maxGap === undefined ? {} : { maxGap: replacement.maxGap })
    };
  }
  if (replacement.kind !== "fallbackColumns") return { ...replacement };
  const columns = replacement.columns.map((column) => ({ ...column }));
  if (!columns[0]) throw new TypeError("Fill Missing Values requires at least one fallback column.");
  return {
    kind: "fallbackColumns",
    columns: columns as FallbackFillMissingReplacement["columns"]
  };
}

function freezeFillMissingReplacement(
  replacement: FillMissingReplacement,
  inputSchema: readonly ColumnSchema[],
  targetColumnId: string
): RKernelFillMissingReplacement {
  const copied = copyFillMissingReplacement(replacement);
  if (copied.kind === "linearInterpolation") {
    const coordinate = requireTransformColumn(copied.coordinate, inputSchema, "Linear interpolation");
    if (coordinate.id === targetColumnId) {
      throw new TypeError("The fill target cannot also be the interpolation coordinate.");
    }
    return Object.freeze({
      kind: "linearInterpolation",
      coordinate: Object.freeze({ id: coordinate.id, name: coordinate.name }),
      ...(copied.maxGap === undefined ? {} : { maxGap: copied.maxGap })
    } satisfies LinearInterpolationFillMissingReplacement);
  }
  if (copied.kind === "groupedStatistic") {
    const seen = new Set<string>();
    const keys = copied.keys.map((reference) => {
      const key = requireTransformColumn(reference, inputSchema, "Grouped fill");
      if (key.id === targetColumnId) throw new TypeError("The fill target cannot also be a grouping column.");
      if (seen.has(key.id)) throw new TypeError("Grouped fill repeats the same R column identity.");
      seen.add(key.id);
      return Object.freeze({ id: key.id, name: key.name });
    });
    if (!keys[0]) throw new TypeError("Grouped fill requires at least one grouping column.");
    return Object.freeze({
      kind: "groupedStatistic",
      statistic: copied.statistic,
      keys: Object.freeze(keys) as readonly [RKernelColumnReference, ...RKernelColumnReference[]]
    });
  }
  if (copied.kind === "directional") {
    const orderBy = resolveTransformSortRules(copied.orderBy, inputSchema, "Directional fill");
    if (orderBy.length === 0) throw new TypeError("Directional fill requires at least one ordering column.");
    if (orderBy.some((rule) => rule.column.id === targetColumnId)) {
      throw new TypeError("The fill target cannot also be a directional ordering column.");
    }
    return Object.freeze({
      kind: "directional",
      direction: copied.direction,
      orderBy: orderBy as readonly [RKernelSortRule, ...RKernelSortRule[]],
      ...(copied.maxGap === undefined ? {} : { maxGap: copied.maxGap })
    });
  }
  if (copied.kind === "fallbackColumns") {
    for (const column of copied.columns) Object.freeze(column);
    Object.freeze(copied.columns);
  }
  return Object.freeze(copied);
}

const R_BY_EXAMPLE_NATIVE_RAW_TYPES = new Set<string>([
  "character",
  "factor",
  "ordered factor",
  "integer",
  "integer64",
  "double",
  "logical",
  "Date",
  "POSIXct",
  "difftime"
]);
const R_NON_MISSING_INTEGER_MINIMUM = -2_147_483_647;
const R_INTEGER_MAXIMUM = 2_147_483_647;
const R_BY_EXAMPLE_TEXT_TYPES = new Set<ByExampleSemanticType>(["string", "integer", "date", "null"]);
const R_BY_EXAMPLE_CONCAT_TYPES = new Set<ByExampleSemanticType>(["string", "integer", "date"]);
const R_BY_EXAMPLE_ARITHMETIC_TYPES = new Set<ByExampleSemanticType>(["integer", "float"]);

type ByExampleSemanticType = ColumnSchema["type"] | "null";

export function bindRByExampleStep(
  step: ByExampleTransformStep,
  inputSchema: readonly ColumnSchema[]
): ByExampleTransformStep {
  if (!isTransformStep(step) || step.kind !== "byExample") {
    throw new TypeError("Transform by Example parameters are malformed or exceed their bounded public contract.");
  }
  assertRKernelByExampleTransportStrings(step);
  if (inputSchema.length >= R_FRAME_CONTRACT_LIMITS.columns) {
    throw new TypeError("Transform by Example exceeds the R frame contract column limit.");
  }
  const selectedIds = new Set<string>();
  const sourceColumns = step.params.sourceColumns.map((reference) => {
    const column = requireTransformColumn(reference, inputSchema, "Transform by Example");
    if (selectedIds.has(column.id)) {
      throw new TypeError("Transform by Example cannot select the same R source column more than once.");
    }
    if (!R_BY_EXAMPLE_NATIVE_RAW_TYPES.has(column.rawType)) {
      throw new TypeError(
        `Transform by Example source ${JSON.stringify(column.name)} has unsupported R ${column.rawType} values.`
      );
    }
    selectedIds.add(column.id);
    return Object.freeze({ id: column.id, name: column.name });
  });
  if (sourceColumns.length === 0 || sourceColumns.length > 16) {
    throw new TypeError("Transform by Example requires between 1 and 16 R source columns.");
  }
  const firstSource = sourceColumns[0];
  if (!firstSource) throw new TypeError("Transform by Example requires at least one R source column.");
  const newColumn = step.params.newColumn;
  if (newColumn.length === 0 || Buffer.byteLength(newColumn, "utf8") > R_FRAME_CONTRACT_LIMITS.nameBytes) {
    throw new TypeError("The Transform by Example R output name is empty or exceeds the frame contract limit.");
  }
  if (newColumn.toLowerCase().startsWith(R_PRIVATE_ROW_ID_PREFIX)) {
    throw new TypeError("The Transform by Example R output name uses Open Wrangler's reserved private namespace.");
  }
  if (inputSchema.some((column) => column.name === newColumn)) {
    throw new TypeError(`The R column name ${JSON.stringify(newColumn)} already exists.`);
  }
  const outputId = `c:step:${step.id}:0`;
  if (
    Buffer.byteLength(outputId, "utf8") > R_FRAME_CONTRACT_LIMITS.columnIdBytes ||
    inputSchema.some((column) => column.id === outputId)
  ) {
    throw new TypeError("The Transform by Example R output identity is invalid or already exists.");
  }

  const sourceById = new Map(
    sourceColumns.map((reference) => [
      reference.id,
      requireTransformColumn(reference, inputSchema, "Transform by Example")
    ])
  );
  const examples = step.params.examples.map((example) => {
    for (const input of example.inputs) assertRByExamplePortableScalar(input);
    assertRByExamplePortableScalar(example.output);
    return Object.freeze({ inputs: Object.freeze([...example.inputs]), output: example.output });
  });
  const firstExample = examples[0];
  const secondExample = examples[1];
  if (!firstExample || !secondExample) throw new TypeError("Transform by Example requires at least two examples.");
  const program =
    step.params.program === undefined
      ? undefined
      : bindRByExampleProgram(step.params.program, sourceById, selectedIds).program;
  return Object.freeze({
    id: step.id,
    kind: "byExample" as const,
    params: Object.freeze({
      sourceColumns: Object.freeze(sourceColumns) as ByExampleTransformStep["params"]["sourceColumns"],
      newColumn,
      examples: Object.freeze(examples) as ByExampleTransformStep["params"]["examples"],
      ...(program === undefined ? {} : { program }),
      ...(step.params.warnings === undefined ? {} : { warnings: Object.freeze([...step.params.warnings]) as string[] }),
      ...(step.params.candidateCount === undefined ? {} : { candidateCount: step.params.candidateCount })
    })
  });
}

export function bindRByExampleProgram(
  program: ByExampleProgram,
  sourceById: ReadonlyMap<string, ColumnSchema>,
  selectedIds: ReadonlySet<string>
): Readonly<{ program: ByExampleProgram; type: ByExampleSemanticType; rawType: string }> {
  if (program.kind === "column") {
    const column = sourceById.get(program.column.id);
    if (!column || column.name !== program.column.name || !selectedIds.has(column.id)) {
      throw new TypeError("The by-example program contains a stale column or one outside sourceColumns.");
    }
    return {
      program: Object.freeze({ kind: "column", column: Object.freeze({ id: column.id, name: column.name }) }),
      type: column.type,
      rawType: column.rawType
    };
  }
  if (program.kind === "literal") {
    const rawType = rByExampleLiteralRawType(program.value);
    const type: ByExampleSemanticType =
      program.value === null
        ? "null"
        : rawType === "character"
          ? "string"
          : rawType === "logical"
            ? "boolean"
            : rawType === "double"
              ? "float"
              : "integer";
    return { program: Object.freeze({ kind: "literal", value: program.value }), type, rawType };
  }
  if (program.kind === "concat") {
    const parts = program.parts.map((part) => bindRByExampleProgram(part, sourceById, selectedIds));
    if (parts.some((part) => !R_BY_EXAMPLE_CONCAT_TYPES.has(part.type))) {
      throw new TypeError("R by-example concat operands must be string, integer, or date values.");
    }
    const firstPart = parts[0];
    if (!firstPart) throw new TypeError("R by-example concat requires at least one part.");
    const copiedParts = Object.freeze([
      firstPart.program,
      ...parts.slice(1).map((part) => part.program)
    ]) as unknown as [ByExampleProgram, ...ByExampleProgram[]];
    return {
      program: Object.freeze({
        kind: "concat",
        parts: copiedParts
      }),
      type: "string",
      rawType: "character"
    };
  }
  if (program.kind === "arithmetic") {
    const left = bindRByExampleProgram(program.left, sourceById, selectedIds);
    const right = bindRByExampleProgram(program.right, sourceById, selectedIds);
    if (!R_BY_EXAMPLE_ARITHMETIC_TYPES.has(left.type) || !R_BY_EXAMPLE_ARITHMETIC_TYPES.has(right.type)) {
      throw new TypeError("R by-example arithmetic operands must be integer or float values.");
    }
    const rawType =
      program.operator === "divide" || left.rawType === "double" || right.rawType === "double" ? "double" : "integer64";
    return {
      program: Object.freeze({
        kind: "arithmetic",
        left: left.program,
        operator: program.operator,
        right: right.program
      }),
      type: rawType === "double" ? "float" : "integer",
      rawType
    };
  }

  const input = bindRByExampleProgram(program.input, sourceById, selectedIds);
  if (!R_BY_EXAMPLE_TEXT_TYPES.has(input.type)) {
    throw new TypeError(`R by-example ${program.kind} input must be a portable text-coercible value.`);
  }
  if (program.kind === "slice") {
    return {
      program: Object.freeze({
        kind: "slice",
        input: input.program,
        start: program.start,
        ...(program.stop === undefined ? {} : { stop: program.stop })
      }),
      type: "string",
      rawType: "character"
    };
  }
  if (program.kind === "split") {
    return {
      program: Object.freeze({
        kind: "split",
        input: input.program,
        delimiter: program.delimiter,
        index: program.index
      }),
      type: "string",
      rawType: "character"
    };
  }
  if (program.kind === "regexExtract") {
    return {
      program: Object.freeze({
        kind: "regexExtract",
        input: input.program,
        pattern: program.pattern,
        group: program.group
      }),
      type: "string",
      rawType: "character"
    };
  }
  if (program.kind === "regexReplace") {
    return {
      program: Object.freeze({
        kind: "regexReplace",
        input: input.program,
        pattern: program.pattern,
        replacement: program.replacement
      }),
      type: "string",
      rawType: "character"
    };
  }
  if (program.kind === "case") {
    return {
      program: Object.freeze({ kind: "case", style: program.style, input: input.program }),
      type: "string",
      rawType: "character"
    };
  }
  return {
    program: Object.freeze({
      kind: "datetimeFormat",
      input: input.program,
      inputFormat: program.inputFormat,
      outputFormat: program.outputFormat
    }),
    type: "string",
    rawType: "character"
  };
}

function rByExampleLiteralRawType(
  value: string | number | boolean | null
): "character" | "logical" | "integer" | "integer64" | "double" {
  if (value === null || typeof value === "boolean") return "logical";
  if (typeof value === "string") return "character";
  if (Number.isInteger(value)) {
    if (!Number.isSafeInteger(value)) {
      throw new TypeError("Native R by-example rejects whole JSON numbers outside the safe integer range.");
    }
    if (value >= R_NON_MISSING_INTEGER_MINIMUM && value <= R_INTEGER_MAXIMUM) return "integer";
    return "integer64";
  }
  return "double";
}

function assertRByExamplePortableScalar(value: string | number | boolean | null): void {
  if (typeof value !== "number") return;
  if (Object.is(value, -0)) {
    throw new TypeError("Native R by-example rejects negative zero because JSON transport cannot preserve its sign.");
  }
  if (Number.isInteger(value) && !Number.isSafeInteger(value)) {
    throw new TypeError("Native R by-example examples reject whole JSON numbers outside the safe integer range.");
  }
}

export function isRNumericRoundingStep(
  step: RPreviewTransformStep
): step is RoundNumberTransformStep | FloorNumberTransformStep | CeilNumberTransformStep {
  return step.kind === "roundNumber" || step.kind === "floorNumber" || step.kind === "ceilNumber";
}

export function rTransformStep(
  step: RPreviewTransformStep,
  inputSchema: readonly ColumnSchema[]
): RKernelTransformStep {
  if (step.kind === "customCode") {
    assertRKernelCustomCodeTransportCode(step.params.code);
    return Object.freeze({
      id: step.id,
      kind: "customCode" as const,
      params: Object.freeze({ code: step.params.code })
    });
  }
  if (step.kind === "sortRows") {
    const rules = resolveTransformSortRules(step.params.rules, inputSchema, "Sort rows");
    const first = rules[0];
    if (!first) throw new TypeError("Sort rows requires at least one R sort rule.");
    return Object.freeze({
      id: step.id,
      kind: "sortRows" as const,
      params: Object.freeze({
        rules: rules as readonly [RKernelSortRule, ...RKernelSortRule[]]
      })
    });
  }
  if (step.kind === "filterRows") {
    return Object.freeze({
      id: step.id,
      kind: "filterRows" as const,
      params: Object.freeze({ filterModel: resolveTransformFilterModel(step.params.filterModel, inputSchema) })
    });
  }
  if (step.kind === "dropMissingRows") {
    const columns = resolveRowReductionColumns(step.params.columns, inputSchema, "Drop missing rows", true);
    return Object.freeze({
      id: step.id,
      kind: "dropMissingRows" as const,
      params: Object.freeze({
        ...(columns === undefined ? {} : { columns }),
        ...(step.params.how === undefined ? {} : { how: step.params.how })
      })
    });
  }
  if (step.kind === "dropDuplicates") {
    const columns = resolveRowReductionColumns(step.params.columns, inputSchema, "Drop duplicates", false);
    return Object.freeze({
      id: step.id,
      kind: "dropDuplicates" as const,
      params: Object.freeze({
        ...(columns === undefined
          ? {}
          : { columns: columns as readonly [RKernelColumnReference, ...RKernelColumnReference[]] }),
        ...(step.params.keep === undefined ? {} : { keep: step.params.keep })
      })
    });
  }
  if (step.kind === "groupBy") {
    const keys = step.params.keys.map((column) => Object.freeze({ ...column }));
    const firstKey = keys[0];
    const aggregations = step.params.aggregations.map((aggregation) =>
      Object.freeze({
        column: Object.freeze({ ...aggregation.column }),
        operation: aggregation.operation,
        alias: aggregation.alias
      })
    );
    const firstAggregation = aggregations[0];
    if (!firstKey || !firstAggregation) throw new TypeError("Group and aggregate requires a key and an aggregation.");
    return Object.freeze({
      id: step.id,
      kind: "groupBy" as const,
      params: Object.freeze({
        keys: Object.freeze(keys) as readonly [RKernelColumnReference, ...RKernelColumnReference[]],
        aggregations: Object.freeze(aggregations) as RKernelGroupByStep["params"]["aggregations"]
      })
    });
  }
  if (step.kind === "byExample") return bindRByExampleStep(step, inputSchema);
  if (step.kind === "selectColumns") {
    const columns = step.params.columns.map((column) => Object.freeze({ ...column }));
    if (!columns[0]) throw new TypeError("Select Columns requires at least one R column.");
    return Object.freeze({
      id: step.id,
      kind: "selectColumns" as const,
      params: Object.freeze({
        columns: Object.freeze(columns) as readonly [RKernelColumnReference, ...RKernelColumnReference[]]
      })
    });
  }
  if (step.kind === "dropColumns") {
    const columns = step.params.columns.map((column) => Object.freeze({ ...column }));
    if (!columns[0]) throw new TypeError("Drop Columns requires at least one R column.");
    return Object.freeze({
      id: step.id,
      kind: "dropColumns" as const,
      params: Object.freeze({
        columns: Object.freeze(columns) as readonly [RKernelColumnReference, ...RKernelColumnReference[]]
      })
    });
  }
  if (step.kind === "cloneColumn") {
    return Object.freeze({
      id: step.id,
      kind: "cloneColumn" as const,
      params: Object.freeze({ column: Object.freeze({ ...step.params.column }), newName: step.params.newName })
    });
  }
  if (step.kind === "fillMissingValues") {
    return Object.freeze({
      id: step.id,
      kind: "fillMissingValues" as const,
      params: Object.freeze({
        column: Object.freeze({ ...step.params.column }),
        replacement: freezeFillMissingReplacement(step.params.replacement, inputSchema, step.params.column.id)
      })
    });
  }
  if (step.kind === "castColumn") {
    return Object.freeze({
      id: step.id,
      kind: "castColumn" as const,
      params: Object.freeze({ column: Object.freeze({ ...step.params.column }), dtype: step.params.dtype })
    });
  }
  if (step.kind === "formula") {
    return Object.freeze({
      id: step.id,
      kind: "formula" as const,
      params: Object.freeze({
        leftColumn: Object.freeze({ ...step.params.leftColumn }),
        operator: step.params.operator,
        newColumn: step.params.newColumn,
        ...(step.params.rightColumn === undefined
          ? { value: step.params.value as number }
          : { rightColumn: Object.freeze({ ...step.params.rightColumn }) })
      })
    });
  }
  if (step.kind === "textLength") {
    return Object.freeze({
      id: step.id,
      kind: "textLength" as const,
      params: Object.freeze({ column: Object.freeze({ ...step.params.column }), newColumn: step.params.newColumn })
    });
  }
  if (step.kind === "oneHotEncode") {
    const columns = step.params.columns.map((column) => Object.freeze({ ...column }));
    if (!columns[0]) throw new TypeError("One-hot encoding requires at least one R column.");
    return Object.freeze({
      id: step.id,
      kind: "oneHotEncode" as const,
      params: Object.freeze({
        columns: Object.freeze(columns) as readonly [RKernelColumnReference, ...RKernelColumnReference[]],
        ...(step.params.prefixSeparator === undefined ? {} : { prefixSeparator: step.params.prefixSeparator }),
        ...(step.params.dropOriginal === undefined ? {} : { dropOriginal: step.params.dropOriginal })
      })
    });
  }
  if (step.kind === "multiLabelBinarize") {
    return Object.freeze({
      id: step.id,
      kind: "multiLabelBinarize" as const,
      params: Object.freeze({
        column: Object.freeze({ ...step.params.column }),
        delimiter: step.params.delimiter,
        ...(step.params.prefix === undefined ? {} : { prefix: step.params.prefix }),
        ...(step.params.dropOriginal === undefined ? {} : { dropOriginal: step.params.dropOriginal })
      })
    });
  }
  if (step.kind === "capitalizeText") {
    return Object.freeze({
      id: step.id,
      kind: "capitalizeText" as const,
      params: Object.freeze({
        column: Object.freeze({ ...step.params.column }),
        ...(step.params.newColumn === undefined ? {} : { newColumn: step.params.newColumn })
      })
    });
  }
  if (step.kind === "stripText") {
    return Object.freeze({
      id: step.id,
      kind: "stripText" as const,
      params: Object.freeze({
        column: Object.freeze({ ...step.params.column }),
        ...(step.params.characters === undefined ? {} : { characters: step.params.characters }),
        ...(step.params.newColumn === undefined ? {} : { newColumn: step.params.newColumn })
      })
    });
  }
  if (step.kind === "splitText") {
    return Object.freeze({
      id: step.id,
      kind: "splitText" as const,
      params: Object.freeze({
        column: Object.freeze({ ...step.params.column }),
        delimiter: step.params.delimiter,
        index: step.params.index,
        newColumn: step.params.newColumn
      })
    });
  }
  if (step.kind === "splitTextColumns") {
    return Object.freeze({
      id: step.id,
      kind: "splitTextColumns" as const,
      params: Object.freeze({
        column: Object.freeze({ ...step.params.column }),
        delimiter: step.params.delimiter,
        newColumns: Object.freeze([...step.params.newColumns])
      })
    });
  }
  if (step.kind === "lowerText") {
    return Object.freeze({
      id: step.id,
      kind: "lowerText" as const,
      params: Object.freeze({
        column: Object.freeze({ ...step.params.column }),
        ...(step.params.newColumn === undefined ? {} : { newColumn: step.params.newColumn })
      })
    });
  }
  if (step.kind === "upperText") {
    return Object.freeze({
      id: step.id,
      kind: "upperText" as const,
      params: Object.freeze({
        column: Object.freeze({ ...step.params.column }),
        ...(step.params.newColumn === undefined ? {} : { newColumn: step.params.newColumn })
      })
    });
  }
  if (step.kind === "findReplace") {
    return Object.freeze({
      id: step.id,
      kind: "findReplace" as const,
      params: Object.freeze({
        column: Object.freeze({ ...step.params.column }),
        find: step.params.find,
        replacement: step.params.replacement,
        ...(step.params.regex === undefined ? {} : { regex: step.params.regex }),
        ...(step.params.newColumn === undefined ? {} : { newColumn: step.params.newColumn })
      })
    });
  }
  if (isRNumericRoundingStep(step)) {
    return Object.freeze({
      id: step.id,
      kind: step.kind,
      params: Object.freeze({
        column: Object.freeze({ ...step.params.column }),
        ...(step.kind === "roundNumber" && step.params.decimals !== undefined
          ? { decimals: step.params.decimals }
          : {}),
        ...(step.params.newColumn === undefined ? {} : { newColumn: step.params.newColumn })
      })
    });
  }
  if (step.kind === "minMaxScale") {
    return Object.freeze({
      id: step.id,
      kind: "minMaxScale" as const,
      params: Object.freeze({
        column: Object.freeze({ ...step.params.column }),
        ...(step.params.newColumn === undefined ? {} : { newColumn: step.params.newColumn })
      })
    });
  }
  if (step.kind === "formatDatetime") {
    return Object.freeze({
      id: step.id,
      kind: "formatDatetime" as const,
      params: Object.freeze({
        column: Object.freeze({ ...step.params.column }),
        format: step.params.format,
        ...(step.params.newColumn === undefined ? {} : { newColumn: step.params.newColumn })
      })
    });
  }
  return Object.freeze({
    id: step.id,
    kind: "renameColumn" as const,
    params: Object.freeze({ column: Object.freeze({ ...step.params.column }), newName: step.params.newName })
  });
}

function resolveRowReductionColumns(
  columns: readonly RKernelColumnReference[] | undefined,
  inputSchema: readonly ColumnSchema[],
  operation: "Drop missing rows" | "Drop duplicates",
  allowEmpty: boolean
): readonly RKernelColumnReference[] | undefined {
  if (columns === undefined) return undefined;
  if (allowEmpty && columns.length === 0) return undefined;
  if ((!allowEmpty && columns.length === 0) || columns.length > inputSchema.length) {
    throw new TypeError(`${operation} requires a bounded${allowEmpty ? "" : " non-empty"} R column selection.`);
  }
  const seen = new Set<string>();
  return Object.freeze(
    columns.map((reference) => {
      if (seen.has(reference.id)) throw new TypeError(`${operation} cannot target the same R column more than once.`);
      seen.add(reference.id);
      const matches = inputSchema.filter((column) => column.id === reference.id && column.name === reference.name);
      if (matches.length !== 1) {
        throw new TypeError(`${operation} contains a column reference that no longer matches the active R dataframe.`);
      }
      const column = matches[0] as ColumnSchema;
      if (column.name.toLowerCase().startsWith(R_PRIVATE_ROW_ID_PREFIX)) {
        throw new TypeError("Open Wrangler's reserved private row-identity column may not be transformed.");
      }
      return Object.freeze({ id: column.id, name: column.name });
    })
  );
}
