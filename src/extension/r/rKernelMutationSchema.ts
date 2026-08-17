import { Buffer } from "node:buffer";
import { isDeepStrictEqual } from "node:util";
import type {
  CeilNumberTransformStep,
  ColumnSchema,
  CustomCodeTransformStep,
  DataDiff,
  FloorNumberTransformStep,
  FormatDatetimeTransformStep,
  FormulaTransformStep,
  GroupByTransformStep,
  MinMaxScaleTransformStep,
  RoundNumberTransformStep
} from "../../shared/protocol";
import { isRetainedTransformStep } from "../../shared/protocolValidation";
import { R_FRAME_CONTRACT_LIMITS, type RColumnSchema, type RFramePageContract } from "./rFrameContract";
import {
  schemaAfterCast,
  schemaAfterClone,
  schemaAfterDrop,
  schemaAfterFillMissing,
  schemaAfterSelect,
  schemaAfterTextLength,
  schemaAfterTextTransform
} from "./rKernelColumnSchema";
import { schemaFromRContract as schemaFromContract } from "./rKernelFrameMapping";
import {
  bindRByExampleProgram,
  bindRByExampleStep,
  isRNumericRoundingStep,
  type RPreviewTransformStep,
  type RRetainedByExampleStep
} from "./rKernelTransformBinding";
import {
  categoricalRetainedSchema,
  isRCategoricalTransformStep,
  isRMinMaxScaleInPlace,
  isRRowReductionStep,
  numericRoundingLabel,
  rowOperationLabel,
  type RCategoricalTransformStep
} from "./rKernelMutationDiff";
import type { RKernelTransformStep, RKernelViewQuery } from "./rKernelProtocol";
import { retainedKeyPrefix } from "./rKernelTransformState";
import { requireRTransformColumn as requireTransformColumn } from "./rKernelViewContract";

const R_PRIVATE_ROW_ID_PREFIX = "__open_wrangler_internal_row_id_";

export type RCustomRowIdentityConstraint = Readonly<{
  first: number;
  endExclusive: number;
  order: "exact" | "ascending" | "any";
}>;

export function rowNamesAfterRStep(
  input: RFramePageContract["frameSemantics"]["rowNames"],
  step: RPreviewTransformStep
): RFramePageContract["frameSemantics"]["rowNames"] {
  return step.kind === "groupBy" ? "positional" : input;
}

export function schemaAfterRStep(
  inputSchema: readonly ColumnSchema[],
  step: RPreviewTransformStep,
  activeKeyColumnIds: readonly string[]
): readonly ColumnSchema[] {
  if (
    step.kind === "sortRows" ||
    step.kind === "filterRows" ||
    step.kind === "dropMissingRows" ||
    step.kind === "dropDuplicates"
  ) {
    return Object.freeze(inputSchema.map((column) => Object.freeze({ ...column })));
  }
  if (step.kind === "selectColumns") return schemaAfterSelect(inputSchema, step);
  if (step.kind === "dropColumns") return schemaAfterDrop(inputSchema, step);
  if (step.kind === "groupBy") return schemaAfterGroupBy(inputSchema, step);
  if (step.kind === "cloneColumn") return schemaAfterClone(inputSchema, step);
  if (step.kind === "formula") return schemaAfterFormula(inputSchema, step);
  if (step.kind === "fillMissingValues") return schemaAfterFillMissing(inputSchema, step, activeKeyColumnIds);
  if (step.kind === "castColumn") return schemaAfterCast(inputSchema, step, activeKeyColumnIds);
  if (step.kind === "minMaxScale") return schemaAfterMinMaxScale(inputSchema, step, activeKeyColumnIds);
  if (isRNumericRoundingStep(step)) return schemaAfterNumericRounding(inputSchema, step, activeKeyColumnIds);
  if (step.kind === "formatDatetime") return schemaAfterFormatDatetime(inputSchema, step, activeKeyColumnIds);
  if (step.kind === "textLength") return schemaAfterTextLength(inputSchema, step);
  if (isRCategoricalTransformStep(step)) {
    throw new TypeError("Categorical R operations require a runtime-derived output schema.");
  }
  if (step.kind === "byExample") {
    throw new TypeError("Transform by Example requires a runtime-derived output schema.");
  }
  if (step.kind === "customCode") {
    throw new TypeError("Custom R code requires a runtime-derived output schema.");
  }
  if (
    step.kind === "findReplace" ||
    step.kind === "stripText" ||
    step.kind === "splitText" ||
    step.kind === "capitalizeText" ||
    step.kind === "lowerText" ||
    step.kind === "upperText"
  ) {
    return schemaAfterTextTransform(inputSchema, step, activeKeyColumnIds);
  }
  const matches = inputSchema.filter(
    (column) => column.id === step.params.column.id && column.name === step.params.column.name
  );
  if (matches.length !== 1) {
    throw new TypeError("The rename column reference no longer matches the active R dataframe.");
  }
  if (step.params.newName.length === 0) throw new TypeError("The new R column name may not be empty.");
  const target = matches[0] as ColumnSchema;
  if (inputSchema.some((column) => column.id !== target.id && column.name === step.params.newName)) {
    throw new TypeError(`The R column name ${JSON.stringify(step.params.newName)} already exists.`);
  }
  return Object.freeze(
    inputSchema.map((column) =>
      Object.freeze(column.id === target.id ? { ...column, name: step.params.newName } : { ...column })
    )
  );
}

export function dynamicCategoricalSchema(
  inputSchema: readonly ColumnSchema[],
  inputRSchema: readonly RColumnSchema[],
  step: RCategoricalTransformStep,
  contract: RFramePageContract
): readonly ColumnSchema[] {
  const retained = categoricalRetainedSchema(inputSchema, step);
  const actual = schemaFromContract(contract);
  const inputRById = new Map(inputRSchema.map((column) => [column.id, column]));
  if (actual.length <= retained.length) {
    throw new Error("The R kernel returned a categorical schema without a generated output.");
  }
  for (const [index, expected] of retained.entries()) {
    const candidate = actual[index];
    const actualRColumn = contract.schema[index];
    const expectedRColumn = inputRById.get(expected.id);
    if (
      !candidate ||
      !actualRColumn ||
      !expectedRColumn ||
      candidate.id !== expected.id ||
      candidate.name !== expected.name ||
      candidate.position !== expected.position ||
      candidate.rawType !== expected.rawType ||
      candidate.type !== expected.type ||
      candidate.nullable !== expected.nullable ||
      !isDeepStrictEqual(actualRColumn.semantics, expectedRColumn.semantics)
    ) {
      throw new Error("The R kernel changed a retained column while encoding categories.");
    }
  }
  const retainedNames = new Set(retained.map((column) => column.name));
  const generatedNames = new Set<string>();
  const requiredPrefixes =
    step.kind === "oneHotEncode"
      ? step.params.columns.map((column) => `${column.name}${step.params.prefixSeparator ?? "_"}`)
      : [step.params.prefix ?? `${step.params.column.name}_`];
  let previousGeneratedName: string | undefined;
  for (let index = retained.length; index < actual.length; index += 1) {
    const column = actual[index] as ColumnSchema;
    const rColumn = contract.schema[index];
    const ordinal = index - retained.length;
    if (
      column.id !== `c:step:${step.id}:${ordinal}` ||
      column.position !== index ||
      column.rawType !== "integer" ||
      column.type !== "integer" ||
      column.nullable ||
      !rColumn ||
      !isDeepStrictEqual(rColumn.semantics, {
        kind: "integer",
        storageMode: "integer",
        classes: ["integer"]
      })
    ) {
      throw new Error("The R kernel returned invalid categorical output metadata.");
    }
    if (
      column.name.length === 0 ||
      Buffer.byteLength(column.name, "utf8") > R_FRAME_CONTRACT_LIMITS.nameBytes ||
      column.name.toLowerCase().startsWith(R_PRIVATE_ROW_ID_PREFIX) ||
      retainedNames.has(column.name) ||
      generatedNames.has(column.name) ||
      !requiredPrefixes.some((prefix) => column.name.startsWith(prefix) && column.name.length > prefix.length)
    ) {
      throw new Error("The R kernel returned a colliding or reserved categorical output name.");
    }
    if (
      previousGeneratedName !== undefined &&
      Buffer.compare(Buffer.from(previousGeneratedName, "utf8"), Buffer.from(column.name, "utf8")) >= 0
    ) {
      throw new Error("The R kernel returned categorical outputs outside their canonical global order.");
    }
    previousGeneratedName = column.name;
    generatedNames.add(column.name);
  }
  return actual;
}

export function acceptRetainedByExampleStep(
  value: unknown,
  requested: RKernelTransformStep,
  inputSchema: readonly ColumnSchema[]
): RRetainedByExampleStep {
  if (requested.kind !== "byExample") {
    throw new Error("The R kernel returned a retained by-example step for the wrong request.");
  }
  if (!isRetainedTransformStep(value) || value.kind !== "byExample") {
    throw new Error("The R kernel did not return a valid retained by-example step.");
  }
  if (
    !Object.prototype.hasOwnProperty.call(value.params, "warnings") ||
    !Object.prototype.hasOwnProperty.call(value.params, "candidateCount")
  ) {
    throw new Error("The R kernel retained by-example step omitted its normalized warnings or candidate count.");
  }
  const requestedIdentity = {
    id: requested.id,
    sourceColumns: requested.params.sourceColumns,
    newColumn: requested.params.newColumn,
    examples: requested.params.examples
  };
  const returnedIdentity = {
    id: value.id,
    sourceColumns: value.params.sourceColumns,
    newColumn: value.params.newColumn,
    examples: value.params.examples
  };
  if (!isDeepStrictEqual(returnedIdentity, requestedIdentity)) {
    throw new Error("The R kernel retained by-example step does not match the exact preview request.");
  }
  if (requested.params.program !== undefined && !isDeepStrictEqual(value.params.program, requested.params.program)) {
    throw new Error("The R kernel changed a saved by-example program instead of revalidating it.");
  }
  const bound = bindRByExampleStep(value, inputSchema);
  if (
    bound.params.program === undefined ||
    bound.params.warnings === undefined ||
    bound.params.candidateCount === undefined
  ) {
    throw new Error("The R kernel returned incomplete normalized by-example parameters.");
  }
  return bound as RRetainedByExampleStep;
}

export function dynamicByExampleSchema(
  inputSchema: readonly ColumnSchema[],
  inputRSchema: readonly RColumnSchema[],
  step: RRetainedByExampleStep,
  contract: RFramePageContract
): readonly ColumnSchema[] {
  const actual = schemaFromContract(contract);
  if (actual.length !== inputSchema.length + 1 || contract.schema.length !== inputRSchema.length + 1) {
    throw new Error("The R kernel returned a by-example schema without exactly one derived output.");
  }
  for (const [index, expected] of inputSchema.entries()) {
    const candidate = actual[index];
    const expectedRColumn = inputRSchema[index];
    const actualRColumn = contract.schema[index];
    if (
      !candidate ||
      !expectedRColumn ||
      !actualRColumn ||
      !isDeepStrictEqual(candidate, expected) ||
      !isDeepStrictEqual(actualRColumn.semantics, expectedRColumn.semantics)
    ) {
      throw new Error("The R kernel changed an input column while deriving a by-example output.");
    }
  }
  const output = actual.at(-1);
  const outputRColumn = contract.schema.at(-1);
  const expectedId = `c:step:${step.id}:0`;
  const selectedIds = new Set(step.params.sourceColumns.map((column) => column.id));
  const sourceById = new Map(
    step.params.sourceColumns.map((reference) => [
      reference.id,
      requireTransformColumn(reference, inputSchema, "Transform by Example")
    ])
  );
  const expectedResult = bindRByExampleProgram(step.params.program, sourceById, selectedIds);
  if (
    !output ||
    !outputRColumn ||
    output.id !== expectedId ||
    output.name !== step.params.newColumn ||
    output.position !== inputSchema.length ||
    output.rawType !== expectedResult.rawType ||
    output.name.toLowerCase().startsWith(R_PRIVATE_ROW_ID_PREFIX)
  ) {
    throw new Error("The R kernel returned by-example output metadata that does not match the retained program.");
  }
  if (step.params.program.kind === "column") {
    const source = sourceById.get(step.params.program.column.id);
    const sourceRColumn = source === undefined ? undefined : inputRSchema[source.position];
    if (!source || !sourceRColumn || !isDeepStrictEqual(outputRColumn.semantics, sourceRColumn.semantics)) {
      throw new Error("The R kernel changed the native semantics of a direct by-example column result.");
    }
  }
  return actual;
}

export function dynamicCustomCodeSchema(
  inputSchema: readonly ColumnSchema[],
  step: CustomCodeTransformStep,
  contract: RFramePageContract
): readonly ColumnSchema[] {
  const actual = schemaFromContract(contract);
  if (actual.length === 0) {
    throw new Error("R custom code must return at least one public dataframe column.");
  }
  const inputIdsByName = new Map<string, string[]>();
  for (const column of inputSchema) {
    inputIdsByName.set(column.name, [...(inputIdsByName.get(column.name) ?? []), column.id]);
  }
  let createdOrdinal = 0;
  const expectedIds = actual.map((column) => {
    if (
      column.name.length === 0 ||
      Buffer.byteLength(column.name, "utf8") > R_FRAME_CONTRACT_LIMITS.nameBytes ||
      column.name.toLowerCase().startsWith(R_PRIVATE_ROW_ID_PREFIX)
    ) {
      throw new Error("R custom code returned an empty, oversized, or reserved column name.");
    }
    const retained = inputIdsByName.get(column.name)?.shift();
    if (retained !== undefined) return retained;
    const created = `c:step:${step.id}:${createdOrdinal}`;
    createdOrdinal += 1;
    if (Buffer.byteLength(created, "utf8") > R_FRAME_CONTRACT_LIMITS.columnIdBytes) {
      throw new Error("R custom code produced an oversized derived column identity.");
    }
    return created;
  });
  if (
    new Set(expectedIds).size !== expectedIds.length ||
    !isDeepStrictEqual(
      actual.map((column) => column.id),
      expectedIds
    )
  ) {
    throw new Error("The R kernel returned invalid custom-code column lineage.");
  }
  return actual;
}

export function schemaAfterFormula(
  inputSchema: readonly ColumnSchema[],
  step: FormulaTransformStep
): readonly ColumnSchema[] {
  const resolveOperand = (reference: FormulaTransformStep["params"]["leftColumn"], label: string): ColumnSchema => {
    const matches = inputSchema.filter((column) => column.id === reference.id && column.name === reference.name);
    if (matches.length !== 1) {
      throw new TypeError(`The ${label} formula column no longer matches the active R dataframe.`);
    }
    const column = matches[0] as ColumnSchema;
    if (column.name.toLowerCase().startsWith(R_PRIVATE_ROW_ID_PREFIX)) {
      throw new TypeError("Open Wrangler's reserved private row-identity column may not be transformed.");
    }
    if (column.rawType !== "integer" && column.rawType !== "double" && column.rawType !== "integer64") {
      throw new TypeError("Formula requires an R integer, double, or integer64 column.");
    }
    return column;
  };
  const left = resolveOperand(step.params.leftColumn, "left");
  const hasRight = step.params.rightColumn !== undefined;
  const hasValue = step.params.value !== undefined;
  if (hasRight === hasValue) {
    throw new TypeError("Formula requires exactly one right column or numeric value.");
  }
  const right = step.params.rightColumn === undefined ? undefined : resolveOperand(step.params.rightColumn, "right");
  if (step.params.value !== undefined && !Number.isFinite(step.params.value)) {
    throw new TypeError("Formula requires a finite numeric value.");
  }
  if (inputSchema.length >= R_FRAME_CONTRACT_LIMITS.columns) {
    throw new TypeError("Formula exceeds the R frame contract column limit.");
  }
  const name = step.params.newColumn;
  if (name.length === 0 || Buffer.byteLength(name, "utf8") > R_FRAME_CONTRACT_LIMITS.nameBytes) {
    throw new TypeError("The formula R column name is empty or exceeds the frame contract limit.");
  }
  if (name.toLowerCase().startsWith(R_PRIVATE_ROW_ID_PREFIX)) {
    throw new TypeError("The formula R column name uses Open Wrangler's reserved private row-identity prefix.");
  }
  if (inputSchema.some((column) => column.name === name)) {
    throw new TypeError(`The R column name ${JSON.stringify(name)} already exists.`);
  }
  const id = `c:step:${step.id}:0`;
  if (
    Buffer.byteLength(id, "utf8") > R_FRAME_CONTRACT_LIMITS.columnIdBytes ||
    inputSchema.some((column) => column.id === id)
  ) {
    throw new TypeError("The formula R column identity is invalid or already exists.");
  }
  const scalarRawType =
    step.params.value !== undefined &&
    Number.isInteger(step.params.value) &&
    step.params.value >= -2_147_483_647 &&
    step.params.value <= 2_147_483_647
      ? "integer"
      : "double";
  const rightRawType = right?.rawType ?? scalarRawType;
  const forceDouble =
    step.params.operator === "divide" ||
    step.params.operator === "power" ||
    ((left.rawType === "integer64" || rightRawType === "integer64") &&
      (left.rawType === "double" || rightRawType === "double"));
  const rawType = forceDouble
    ? "double"
    : left.rawType === "integer64" || rightRawType === "integer64"
      ? "integer64"
      : left.rawType === "double" || rightRawType === "double"
        ? "double"
        : "integer";
  return Object.freeze([
    ...inputSchema.map((column) => Object.freeze({ ...column })),
    Object.freeze({
      id,
      name,
      position: inputSchema.length,
      rawType,
      type: rawType === "double" ? ("float" as const) : ("integer" as const),
      nullable: left.nullable || (right?.nullable ?? false)
    })
  ]);
}

export function schemaAfterFormatDatetime(
  inputSchema: readonly ColumnSchema[],
  step: FormatDatetimeTransformStep,
  activeKeyColumnIds: readonly string[]
): readonly ColumnSchema[] {
  const matches = inputSchema.filter(
    (column) => column.id === step.params.column.id && column.name === step.params.column.name
  );
  if (matches.length !== 1) {
    throw new TypeError("The datetime-format column no longer matches the active R dataframe.");
  }
  const source = matches[0] as ColumnSchema;
  if (source.name.toLowerCase().startsWith(R_PRIVATE_ROW_ID_PREFIX)) {
    throw new TypeError("Open Wrangler's reserved private row-identity column may not be transformed.");
  }
  if (source.rawType !== "Date" && source.rawType !== "POSIXct") {
    throw new TypeError("Format Datetime requires an R Date or POSIXct column.");
  }
  if (
    step.params.format.length === 0 ||
    Buffer.byteLength(step.params.format, "utf8") > R_FRAME_CONTRACT_LIMITS.textBytes
  ) {
    throw new TypeError("Format Datetime requires a bounded non-empty format string.");
  }
  const outputName = step.params.newColumn;
  const inPlace = outputName === undefined || outputName === source.name;
  if (inPlace) {
    if (activeKeyColumnIds.includes(source.id)) {
      throw new TypeError("Format Datetime cannot replace a keyed data.table column in place.");
    }
    return Object.freeze(
      inputSchema.map((column) =>
        Object.freeze(
          column.id === source.id ? { ...column, rawType: "character", type: "string" as const } : { ...column }
        )
      )
    );
  }
  if (outputName === undefined || outputName.length === 0) {
    throw new TypeError("Format Datetime requires a non-empty output column name.");
  }
  if (inputSchema.length >= R_FRAME_CONTRACT_LIMITS.columns) {
    throw new TypeError("Format Datetime exceeds the R frame contract column limit.");
  }
  if (Buffer.byteLength(outputName, "utf8") > R_FRAME_CONTRACT_LIMITS.nameBytes) {
    throw new TypeError("The datetime-format R column name exceeds the frame contract limit.");
  }
  if (outputName.toLowerCase().startsWith(R_PRIVATE_ROW_ID_PREFIX)) {
    throw new TypeError("The datetime-format R column name uses Open Wrangler's reserved private row-identity prefix.");
  }
  if (inputSchema.some((column) => column.name === outputName)) {
    throw new TypeError(`The R column name ${JSON.stringify(outputName)} already exists.`);
  }
  const id = `c:step:${step.id}:0`;
  if (
    Buffer.byteLength(id, "utf8") > R_FRAME_CONTRACT_LIMITS.columnIdBytes ||
    inputSchema.some((column) => column.id === id)
  ) {
    throw new TypeError("The datetime-format R column identity is invalid or already exists.");
  }
  return Object.freeze([
    ...inputSchema.map((column) => Object.freeze({ ...column })),
    Object.freeze({
      id,
      name: outputName,
      position: inputSchema.length,
      rawType: "character",
      type: "string" as const,
      nullable: source.nullable
    })
  ]);
}

const rGroupScalarRawTypes = new Set([
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

export function schemaAfterGroupBy(
  inputSchema: readonly ColumnSchema[],
  step: GroupByTransformStep
): readonly ColumnSchema[] {
  if (step.params.keys.length === 0 || step.params.aggregations.length === 0) {
    throw new TypeError("Group and aggregate requires at least one key and one aggregation.");
  }
  if (step.params.keys.length + step.params.aggregations.length > R_FRAME_CONTRACT_LIMITS.columns) {
    throw new TypeError("Group and aggregate exceeds the R frame contract column limit.");
  }
  const byId = new Map(inputSchema.map((column) => [column.id, column]));
  const seenKeys = new Set<string>();
  const keys = step.params.keys.map((reference) => {
    const column = byId.get(reference.id);
    if (!column || column.name !== reference.name) {
      throw new TypeError("A Group and aggregate key no longer matches the active R dataframe.");
    }
    if (seenKeys.has(column.id)) throw new TypeError("Group and aggregate cannot repeat a key column.");
    if (!rGroupScalarRawTypes.has(column.rawType)) {
      throw new TypeError(`R ${column.rawType} columns cannot be used as group keys.`);
    }
    if (column.name.toLowerCase().startsWith(R_PRIVATE_ROW_ID_PREFIX)) {
      throw new TypeError("Open Wrangler's reserved private row-identity column may not be grouped.");
    }
    seenKeys.add(column.id);
    return Object.freeze({ ...column });
  });

  const keyNames = new Set(keys.map((column) => column.name));
  const aliases = new Set<string>();
  const outputIds = new Set(keys.map((column) => column.id));
  const aggregations = step.params.aggregations.map((aggregation, index) => {
    const source = byId.get(aggregation.column.id);
    if (!source || source.name !== aggregation.column.name) {
      throw new TypeError("A Group and aggregate input no longer matches the active R dataframe.");
    }
    const alias = aggregation.alias;
    if (alias.length === 0 || Buffer.byteLength(alias, "utf8") > R_FRAME_CONTRACT_LIMITS.nameBytes) {
      throw new TypeError("A Group and aggregate alias is empty or exceeds the R frame contract limit.");
    }
    if (alias.toLowerCase().startsWith(R_PRIVATE_ROW_ID_PREFIX)) {
      throw new TypeError("A Group and aggregate alias uses Open Wrangler's reserved private row-identity prefix.");
    }
    if (aliases.has(alias) || keyNames.has(alias)) {
      throw new TypeError("Group and aggregate aliases must be unique and cannot duplicate a key name.");
    }
    aliases.add(alias);

    const numeric = source.rawType === "integer" || source.rawType === "integer64" || source.rawType === "double";
    const ordered = rGroupScalarRawTypes.has(source.rawType);
    if (
      ((aggregation.operation === "sum" || aggregation.operation === "mean" || aggregation.operation === "median") &&
        !numeric) ||
      ((aggregation.operation === "min" || aggregation.operation === "max") && !ordered) ||
      ((aggregation.operation === "count" ||
        aggregation.operation === "nUnique" ||
        aggregation.operation === "first" ||
        aggregation.operation === "last") &&
        !ordered)
    ) {
      throw new TypeError(`R ${source.rawType} columns cannot use the ${aggregation.operation} group aggregation.`);
    }

    const id = `c:step:${step.id}:${index}`;
    if (Buffer.byteLength(id, "utf8") > R_FRAME_CONTRACT_LIMITS.columnIdBytes || outputIds.has(id)) {
      throw new TypeError("A Group and aggregate output identity is invalid or already exists.");
    }
    outputIds.add(id);
    const outputType =
      aggregation.operation === "count" || aggregation.operation === "nUnique"
        ? { rawType: "integer", type: "integer" as const, nullable: false }
        : aggregation.operation === "mean" || aggregation.operation === "median"
          ? { rawType: "double", type: "float" as const, nullable: source.nullable }
          : (aggregation.operation === "min" || aggregation.operation === "max") && source.rawType === "factor"
            ? { rawType: "character", type: "string" as const, nullable: source.nullable }
            : aggregation.operation === "sum"
              ? { rawType: source.rawType, type: source.type, nullable: false }
              : { rawType: source.rawType, type: source.type, nullable: source.nullable };
    return Object.freeze({
      id,
      name: alias,
      position: keys.length + index,
      ...outputType
    });
  });
  return Object.freeze([...keys.map((column, position) => Object.freeze({ ...column, position })), ...aggregations]);
}

export function schemaAfterNumericRounding(
  inputSchema: readonly ColumnSchema[],
  step: RoundNumberTransformStep | FloorNumberTransformStep | CeilNumberTransformStep,
  activeKeyColumnIds: readonly string[]
): readonly ColumnSchema[] {
  const label = numericRoundingLabel(step);
  const matches = inputSchema.filter(
    (column) => column.id === step.params.column.id && column.name === step.params.column.name
  );
  if (matches.length !== 1) {
    throw new TypeError(`The ${label.toLowerCase()} column reference no longer matches the active R dataframe.`);
  }
  const source = matches[0] as ColumnSchema;
  if (source.name.toLowerCase().startsWith(R_PRIVATE_ROW_ID_PREFIX)) {
    throw new TypeError("Open Wrangler's reserved private row-identity column may not be transformed.");
  }
  if (source.rawType !== "integer" && source.rawType !== "double" && source.rawType !== "integer64") {
    throw new TypeError(`${label} requires an R integer, double, or integer64 column.`);
  }
  if (
    step.kind === "roundNumber" &&
    step.params.decimals !== undefined &&
    (!Number.isSafeInteger(step.params.decimals) || Math.abs(step.params.decimals) > 2_147_483_647)
  ) {
    throw new TypeError("Round requires a decimal-place count within R's integer range.");
  }

  const outputName = step.params.newColumn;
  if (outputName !== undefined && outputName.length === 0) {
    throw new TypeError(`The ${label.toLowerCase()} R column name may not be empty.`);
  }
  const inPlace = outputName === undefined || outputName === source.name;
  const targetType =
    source.rawType === "integer64"
      ? { rawType: "integer64", type: "integer" as const }
      : { rawType: "double", type: "float" as const };
  if (inPlace) {
    if (activeKeyColumnIds.includes(source.id)) {
      throw new TypeError(`${label} cannot replace a keyed data.table column in place. Choose a new output column.`);
    }
    return Object.freeze(
      inputSchema.map((column) => Object.freeze(column.id === source.id ? { ...column, ...targetType } : { ...column }))
    );
  }
  if (inputSchema.length >= R_FRAME_CONTRACT_LIMITS.columns) {
    throw new TypeError(`${label} exceeds the R frame contract column limit.`);
  }
  if (Buffer.byteLength(outputName, "utf8") > R_FRAME_CONTRACT_LIMITS.nameBytes) {
    throw new TypeError(`The ${label.toLowerCase()} R column name exceeds the frame contract limit.`);
  }
  if (outputName.toLowerCase().startsWith(R_PRIVATE_ROW_ID_PREFIX)) {
    throw new TypeError(
      `The ${label.toLowerCase()} R column name uses Open Wrangler's reserved private row-identity prefix.`
    );
  }
  if (inputSchema.some((column) => column.name === outputName)) {
    throw new TypeError(`The R column name ${JSON.stringify(outputName)} already exists.`);
  }
  const id = `c:step:${step.id}:0`;
  if (Buffer.byteLength(id, "utf8") > R_FRAME_CONTRACT_LIMITS.columnIdBytes) {
    throw new TypeError(`The ${label.toLowerCase()} R column identity exceeds the frame contract limit.`);
  }
  if (inputSchema.some((column) => column.id === id)) {
    throw new TypeError(`The ${label.toLowerCase()} R column identity already exists in the active dataframe.`);
  }
  return Object.freeze([
    ...inputSchema.map((column) => Object.freeze({ ...column })),
    Object.freeze({
      id,
      name: outputName,
      position: inputSchema.length,
      ...targetType,
      nullable: source.nullable
    })
  ]);
}

export function schemaAfterMinMaxScale(
  inputSchema: readonly ColumnSchema[],
  step: MinMaxScaleTransformStep,
  activeKeyColumnIds: readonly string[]
): readonly ColumnSchema[] {
  const matches = inputSchema.filter(
    (column) => column.id === step.params.column.id && column.name === step.params.column.name
  );
  if (matches.length !== 1) {
    throw new TypeError("The min-max-scale column reference no longer matches the active R dataframe.");
  }
  const source = matches[0] as ColumnSchema;
  if (source.name.toLowerCase().startsWith(R_PRIVATE_ROW_ID_PREFIX)) {
    throw new TypeError("Open Wrangler's reserved private row-identity column may not be transformed.");
  }
  if (source.rawType !== "integer" && source.rawType !== "double" && source.rawType !== "integer64") {
    throw new TypeError("Min-max scale requires an R integer, double, or integer64 column.");
  }

  const outputName = step.params.newColumn;
  if (outputName !== undefined && outputName.length === 0) {
    throw new TypeError("The min-max-scale R column name may not be empty.");
  }
  const inPlace = isRMinMaxScaleInPlace(step);
  const targetType = { rawType: "double", type: "float" as const };
  if (inPlace) {
    if (activeKeyColumnIds.includes(source.id)) {
      throw new TypeError(
        "Min-max scale cannot replace a keyed data.table column in place. Choose a new output column."
      );
    }
    return Object.freeze(
      inputSchema.map((column) =>
        Object.freeze(column.id === source.id ? { ...column, ...targetType, nullable: true } : { ...column })
      )
    );
  }
  if (outputName === undefined) throw new TypeError("Min-max scale requires an output column for an appended result.");
  if (inputSchema.length >= R_FRAME_CONTRACT_LIMITS.columns) {
    throw new TypeError("Min-max scale exceeds the R frame contract column limit.");
  }
  if (Buffer.byteLength(outputName, "utf8") > R_FRAME_CONTRACT_LIMITS.nameBytes) {
    throw new TypeError("The min-max-scale R column name exceeds the frame contract limit.");
  }
  if (outputName.toLowerCase().startsWith(R_PRIVATE_ROW_ID_PREFIX)) {
    throw new TypeError("The min-max-scale R column name uses Open Wrangler's reserved private row-identity prefix.");
  }
  if (inputSchema.some((column) => column.name === outputName)) {
    throw new TypeError(`The R column name ${JSON.stringify(outputName)} already exists.`);
  }
  const id = `c:step:${step.id}:0`;
  if (Buffer.byteLength(id, "utf8") > R_FRAME_CONTRACT_LIMITS.columnIdBytes) {
    throw new TypeError("The min-max-scale R column identity exceeds the frame contract limit.");
  }
  if (inputSchema.some((column) => column.id === id)) {
    throw new TypeError("The min-max-scale R column identity already exists in the active dataframe.");
  }
  return Object.freeze([
    ...inputSchema.map((column) => Object.freeze({ ...column })),
    Object.freeze({
      id,
      name: outputName,
      position: inputSchema.length,
      ...targetType,
      nullable: true
    })
  ]);
}

export function keyColumnsAfterRStep(
  inputKeyColumnIds: readonly string[],
  outputSchema: readonly ColumnSchema[],
  step: RPreviewTransformStep
): readonly string[] {
  if (step.kind === "groupBy") return Object.freeze([]);
  if (step.kind === "sortRows" || (step.kind === "filterRows" && step.params.filterModel.sort.length > 0)) {
    return Object.freeze([]);
  }
  return Object.freeze([...retainedKeyPrefix(inputKeyColumnIds, outputSchema)]);
}

export function rowCountAfterRStep(step: RPreviewTransformStep, inputRows: number, diff: DataDiff): number {
  if (step.kind === "groupBy" || step.kind === "customCode") {
    if (diff.removedRows !== inputRows) {
      throw new Error(
        step.kind === "groupBy"
          ? "The R kernel returned invalid row counts for Group and aggregate."
          : "The R kernel returned invalid row counts for custom code."
      );
    }
    if (step.kind === "groupBy" && diff.addedRows > inputRows) {
      throw new Error("The R kernel returned invalid row counts for Group and aggregate.");
    }
    return diff.addedRows;
  }
  if (isRRowReductionStep(step)) {
    if (diff.addedRows !== 0 || diff.removedRows > inputRows) {
      throw new Error(`The R kernel returned invalid row counts for ${rowOperationLabel(step)}.`);
    }
    return inputRows - diff.removedRows;
  }
  if (diff.addedRows !== 0 || diff.removedRows !== 0) {
    throw new Error(`The R kernel returned an unexpected row-count change for ${step.kind}.`);
  }
  return inputRows;
}

export function rowIdentityDomainAfterRStep(
  step: RPreviewTransformStep,
  inputIdentityRows: number,
  outputRows: number
): number {
  if (step.kind !== "groupBy" && step.kind !== "customCode") return inputIdentityRows;
  const outputIdentityRows = inputIdentityRows + outputRows;
  if (!Number.isSafeInteger(outputIdentityRows) || outputIdentityRows > R_FRAME_CONTRACT_LIMITS.rows) {
    throw new Error(
      step.kind === "groupBy"
        ? "The grouped R dataframe exceeds the supported row-identity range."
        : "The custom-code R dataframe exceeds the supported row-identity range."
    );
  }
  return outputIdentityRows;
}

export function customRowIdentityConstraintAfterRStep(
  step: RPreviewTransformStep,
  input: RCustomRowIdentityConstraint | undefined,
  inputIdentityRows: number,
  outputRows: number
): RCustomRowIdentityConstraint | undefined {
  if (step.kind === "customCode") {
    return Object.freeze({
      first: inputIdentityRows,
      endExclusive: inputIdentityRows + outputRows,
      order: "exact" as const
    });
  }
  if (step.kind === "groupBy") return undefined;
  if (!input) return undefined;
  if (step.kind === "sortRows" || (step.kind === "filterRows" && step.params.filterModel.sort.length > 0)) {
    return input.order === "any" ? input : Object.freeze({ ...input, order: "any" as const });
  }
  if (step.kind === "filterRows" || step.kind === "dropMissingRows" || step.kind === "dropDuplicates") {
    return input.order === "exact" ? Object.freeze({ ...input, order: "ascending" as const }) : input;
  }
  return input;
}

export function assertCustomDerivedRowIdentities(
  contract: RFramePageContract,
  constraint: RCustomRowIdentityConstraint | undefined,
  view: RKernelViewQuery
): void {
  if (!constraint) return;
  const identities = contract.page.rows.map((row) => {
    const match = /^r:r:(0|[1-9][0-9]*)$/u.exec(row.id);
    const identity = match ? Number(match[1]) : Number.NaN;
    if (!Number.isSafeInteger(identity) || identity < constraint.first || identity >= constraint.endExclusive) {
      throw new Error("The R custom-derived response reused or returned an out-of-suffix row identity.");
    }
    return identity;
  });
  if (new Set(identities).size !== identities.length) {
    throw new Error("The R custom-derived response returned duplicate fresh row identities.");
  }
  const effectiveOrder =
    view.sorts.length > 0
      ? "any"
      : view.filters.length > 0 && constraint.order === "exact"
        ? "ascending"
        : constraint.order;
  if (effectiveOrder === "exact") {
    if (
      identities.some(
        (identity, position) => identity !== constraint.first + (contract.page.rows[position]?.rowNumber ?? -1)
      )
    ) {
      throw new Error("The R custom-derived page returned fresh row identities outside physical output order.");
    }
  } else if (
    effectiveOrder === "ascending" &&
    identities.some((identity, position) => position > 0 && identity <= (identities[position - 1] as number))
  ) {
    throw new Error("The R custom-derived page returned fresh row identities outside physical output order.");
  }
}
