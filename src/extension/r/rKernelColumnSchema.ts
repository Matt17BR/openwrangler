import { Buffer } from "node:buffer";
import type {
  CapitalizeTextTransformStep,
  CastColumnTransformStep,
  CloneColumnTransformStep,
  ColumnSchema,
  DropColumnsTransformStep,
  FillMissingValuesTransformStep,
  FilterModel,
  FindReplaceTransformStep,
  LowerTextTransformStep,
  SelectColumnsTransformStep,
  SplitTextTransformStep,
  SplitTextColumnsTransformStep,
  StripTextTransformStep,
  TextLengthTransformStep,
  UpperTextTransformStep
} from "../../shared/protocol";
import { R_FRAME_CONTRACT_LIMITS } from "./rFrameContract";
import { requireRTransformColumn, resolveRTransformSortRules } from "./rKernelViewContract";

const R_PRIVATE_ROW_ID_PREFIX = "__open_wrangler_internal_row_id_";

type RTextTransformStep =
  | FindReplaceTransformStep
  | StripTextTransformStep
  | SplitTextTransformStep
  | CapitalizeTextTransformStep
  | LowerTextTransformStep
  | UpperTextTransformStep;

export function schemaAfterSplitTextColumns(
  inputSchema: readonly ColumnSchema[],
  step: SplitTextColumnsTransformStep
): readonly ColumnSchema[] {
  const matches = inputSchema.filter(
    (column) => column.id === step.params.column.id && column.name === step.params.column.name
  );
  if (matches.length !== 1) {
    throw new TypeError("The split-text-columns reference no longer matches the active R dataframe.");
  }
  const source = matches[0] as ColumnSchema;
  if (source.type !== "string") throw new TypeError("Split text into columns requires an R string or factor column.");
  if (step.params.newColumns.length < 2 || step.params.newColumns.length > 64) {
    throw new TypeError("Split text into columns requires 2 to 64 output columns.");
  }
  const names = [...step.params.newColumns];
  if (new Set(names).size !== names.length) throw new TypeError("Split text output column names must be unique.");
  if (inputSchema.length + names.length > R_FRAME_CONTRACT_LIMITS.columns) {
    throw new TypeError("Split text into columns exceeds the R frame contract column limit.");
  }
  const existingNames = new Set(inputSchema.map((column) => column.name));
  const existingIds = new Set(inputSchema.map((column) => column.id));
  const outputs = names.map((name, index) => {
    if (name.length === 0 || Buffer.byteLength(name, "utf8") > R_FRAME_CONTRACT_LIMITS.nameBytes) {
      throw new TypeError("A split-text output column name is empty or exceeds the frame contract limit.");
    }
    if (name.toLowerCase().startsWith(R_PRIVATE_ROW_ID_PREFIX)) {
      throw new TypeError("A split-text output uses Open Wrangler's reserved private row-identity prefix.");
    }
    if (existingNames.has(name)) throw new TypeError(`The R column name ${JSON.stringify(name)} already exists.`);
    const id = `c:step:${step.id}:${index}`;
    if (Buffer.byteLength(id, "utf8") > R_FRAME_CONTRACT_LIMITS.columnIdBytes || existingIds.has(id)) {
      throw new TypeError("A split-text output column identity is invalid or already exists.");
    }
    return Object.freeze({
      id,
      name,
      position: inputSchema.length + index,
      rawType: "character",
      type: "string" as const,
      nullable: true
    });
  });
  return Object.freeze([...inputSchema.map((column) => Object.freeze({ ...column })), ...outputs]);
}

export function schemaAfterFillMissing(
  inputSchema: readonly ColumnSchema[],
  step: FillMissingValuesTransformStep,
  activeKeyColumnIds: readonly string[]
): readonly ColumnSchema[] {
  const matches = inputSchema.filter(
    (column) => column.id === step.params.column.id && column.name === step.params.column.name
  );
  if (matches.length !== 1) {
    throw new TypeError("The fill-missing column reference no longer matches the active R dataframe.");
  }
  const source = matches[0] as ColumnSchema;
  if (source.name.toLowerCase().startsWith(R_PRIVATE_ROW_ID_PREFIX)) {
    throw new TypeError("Open Wrangler's reserved private row-identity column may not be transformed.");
  }
  if (activeKeyColumnIds.includes(source.id)) {
    throw new TypeError("Fill Missing Values cannot replace a data.table key column. Clone the column first.");
  }
  const replacement = step.params.replacement;
  if (replacement.kind === "linearInterpolation") {
    if (source.type !== "float") {
      throw new TypeError(`Linear interpolation cannot fill R ${source.rawType}.`);
    }
    if (
      replacement.maxGap !== undefined &&
      (!Number.isSafeInteger(replacement.maxGap) || replacement.maxGap < 1 || replacement.maxGap > 1_000_000)
    ) {
      throw new TypeError("Linear interpolation requires a maximum gap between 1 and 1,000,000 when supplied.");
    }
    const coordinate = requireRTransformColumn(replacement.coordinate, inputSchema, "Linear interpolation");
    if (coordinate.id === source.id) {
      throw new TypeError("The fill target cannot also be the interpolation coordinate.");
    }
    if (coordinate.rawType === "integer64" || !new Set(["integer", "float", "date", "datetime"]).has(coordinate.type)) {
      throw new TypeError(`R ${coordinate.rawType} columns cannot be used as interpolation coordinates.`);
    }
    return Object.freeze(inputSchema.map((column) => Object.freeze({ ...column })));
  }
  if (replacement.kind === "groupedStatistic") {
    const compatible =
      (replacement.statistic === "mean" && source.type === "float") ||
      (replacement.statistic === "median" && (source.type === "integer" || source.type === "float")) ||
      (replacement.statistic === "mostFrequent" && (source.type === "string" || source.type === "boolean"));
    if (!compatible) {
      throw new TypeError(`Grouped ${replacement.statistic} cannot fill R ${source.rawType}.`);
    }
    if (replacement.keys.length === 0 || replacement.keys.length > R_FRAME_CONTRACT_LIMITS.columns) {
      throw new TypeError("Grouped fill requires at least one grouping column.");
    }
    const supportedKeyTypes = new Set(["string", "integer", "float", "boolean", "date", "datetime", "duration"]);
    const seen = new Set<string>();
    for (const reference of replacement.keys) {
      const key = requireRTransformColumn(reference, inputSchema, "Grouped fill");
      if (key.id === source.id) throw new TypeError("The fill target cannot also be a grouping column.");
      if (seen.has(key.id)) throw new TypeError("Grouped fill repeats the same R column identity.");
      if (!supportedKeyTypes.has(key.type)) {
        throw new TypeError(`R ${key.rawType} columns cannot be used as grouped-fill keys.`);
      }
      seen.add(key.id);
    }
    return Object.freeze(inputSchema.map((column) => Object.freeze({ ...column })));
  }
  if (replacement.kind === "directional") {
    if (replacement.direction !== "forward" && replacement.direction !== "backward") {
      throw new TypeError("Directional fill requires a forward or backward direction.");
    }
    if (
      !Number.isSafeInteger(replacement.maxGap ?? 1) ||
      (replacement.maxGap ?? 1) < 1 ||
      (replacement.maxGap ?? 1) > 1_000_000
    ) {
      throw new TypeError("Directional fill requires a maximum gap between 1 and 1,000,000 when supplied.");
    }
    const orderBy = resolveRTransformSortRules(replacement.orderBy, inputSchema, "Directional fill");
    if (orderBy.length === 0) throw new TypeError("Directional fill requires at least one ordering column.");
    if (orderBy.some((rule) => rule.column.id === source.id)) {
      throw new TypeError("The fill target cannot also be a directional ordering column.");
    }
    return Object.freeze(inputSchema.map((column) => Object.freeze({ ...column })));
  }
  if (replacement.kind === "fallbackColumns") {
    if (replacement.columns.length === 0 || replacement.columns.length > 64) {
      throw new TypeError("Fill Missing Values requires between 1 and 64 fallback columns.");
    }
    if (!["string", "integer", "float", "boolean", "date", "datetime"].includes(source.type)) {
      throw new TypeError(`Fallback columns cannot fill R ${source.rawType}.`);
    }
    const seen = new Set<string>();
    for (const reference of replacement.columns) {
      if (reference.id === source.id) {
        throw new TypeError("The fill target cannot also be a fallback column.");
      }
      if (seen.has(reference.id)) {
        throw new TypeError("Fill Missing Values cannot use the same fallback column more than once.");
      }
      seen.add(reference.id);
      const fallbackMatches = inputSchema.filter(
        (column) => column.id === reference.id && column.name === reference.name
      );
      if (fallbackMatches.length !== 1) {
        throw new TypeError("A fallback column reference no longer matches the active R dataframe.");
      }
      const fallback = fallbackMatches[0] as ColumnSchema;
      if (fallback.name.toLowerCase().startsWith(R_PRIVATE_ROW_ID_PREFIX)) {
        throw new TypeError("Open Wrangler's reserved private row-identity column may not be transformed.");
      }
      if (fallback.type !== source.type) {
        throw new TypeError(
          `Fallback column ${JSON.stringify(fallback.name)} is incompatible with R ${source.rawType}.`
        );
      }
    }
    return Object.freeze(inputSchema.map((column) => Object.freeze({ ...column })));
  }
  const compatible =
    (source.type === "string" && (replacement.kind === "mostFrequent" || replacement.kind === "string")) ||
    (source.type === "integer" && (replacement.kind === "median" || replacement.kind === "integer")) ||
    (source.type === "float" &&
      (replacement.kind === "mean" ||
        replacement.kind === "median" ||
        replacement.kind === "integer" ||
        replacement.kind === "float")) ||
    (source.type === "boolean" && (replacement.kind === "mostFrequent" || replacement.kind === "boolean")) ||
    (source.type === "date" && replacement.kind === "date") ||
    (source.type === "datetime" && replacement.kind === "datetime");
  if (!compatible) {
    throw new TypeError(`The ${replacement.kind} replacement is incompatible with R ${source.rawType}.`);
  }
  if (
    replacement.kind === "string" &&
    Buffer.byteLength(replacement.value, "utf8") > R_FRAME_CONTRACT_LIMITS.textBytes
  ) {
    throw new TypeError("The R replacement text exceeds the frame contract limit.");
  }
  return Object.freeze(
    inputSchema.map((column) => Object.freeze(column.id === source.id ? { ...column, nullable: false } : { ...column }))
  );
}

export function schemaAfterCast(
  inputSchema: readonly ColumnSchema[],
  step: CastColumnTransformStep,
  activeKeyColumnIds: readonly string[]
): readonly ColumnSchema[] {
  const matches = inputSchema.filter(
    (column) => column.id === step.params.column.id && column.name === step.params.column.name
  );
  if (matches.length !== 1) {
    throw new TypeError("The converted column reference no longer matches the active R dataframe.");
  }
  const source = matches[0] as ColumnSchema;
  if (source.name.toLowerCase().startsWith(R_PRIVATE_ROW_ID_PREFIX)) {
    throw new TypeError("Open Wrangler's reserved private row-identity column may not be transformed.");
  }
  if (activeKeyColumnIds.includes(source.id)) {
    throw new TypeError(
      "Convert type cannot replace a data.table key column. Clone the column first, then convert it."
    );
  }

  const target = rCastTarget(source.rawType, step.params.dtype);
  return Object.freeze(
    inputSchema.map((column) =>
      Object.freeze(
        column.id === source.id
          ? { ...column, rawType: target.rawType, type: target.type, nullable: source.nullable }
          : { ...column }
      )
    )
  );
}

function rCastTarget(
  sourceRawType: string,
  dtype: CastColumnTransformStep["params"]["dtype"]
): Readonly<{ rawType: string; type: ColumnSchema["type"] }> {
  const factor = sourceRawType === "factor" || sourceRawType === "ordered factor";
  const text = sourceRawType === "character" || factor;
  const ordinaryScalar =
    sourceRawType === "logical" || sourceRawType === "integer" || sourceRawType === "double" || text;
  if (dtype === "string") {
    if (
      !ordinaryScalar &&
      sourceRawType !== "Date" &&
      sourceRawType !== "POSIXct" &&
      sourceRawType !== "difftime" &&
      sourceRawType !== "integer64"
    ) {
      throw new TypeError(`Convert type does not support R ${sourceRawType} columns.`);
    }
    return { rawType: "character", type: "string" };
  }
  if (dtype === "integer") {
    if (sourceRawType === "integer64") return { rawType: "integer64", type: "integer" };
    if (!ordinaryScalar) throw unsupportedRCast(sourceRawType, dtype);
    return { rawType: "integer", type: "integer" };
  }
  if (dtype === "float") {
    if (!ordinaryScalar) throw unsupportedRCast(sourceRawType, dtype);
    return { rawType: "double", type: "float" };
  }
  if (dtype === "boolean") {
    if (!ordinaryScalar) throw unsupportedRCast(sourceRawType, dtype);
    return { rawType: "logical", type: "boolean" };
  }
  if (dtype === "date") {
    if (!text && sourceRawType !== "Date" && sourceRawType !== "POSIXct") {
      throw unsupportedRCast(sourceRawType, dtype);
    }
    return { rawType: "Date", type: "date" };
  }
  if (dtype === "datetime") {
    if (!text && sourceRawType !== "Date" && sourceRawType !== "POSIXct") {
      throw unsupportedRCast(sourceRawType, dtype);
    }
    return { rawType: "POSIXct", type: "datetime" };
  }
  throw new TypeError("Convert type received an unsupported R target type.");
}

function unsupportedRCast(sourceRawType: string, dtype: string): TypeError {
  return new TypeError(`Convert type cannot safely convert R ${sourceRawType} values to ${dtype}.`);
}

export function schemaAfterTextTransform(
  inputSchema: readonly ColumnSchema[],
  step: RTextTransformStep,
  activeKeyColumnIds: readonly string[]
): readonly ColumnSchema[] {
  const label = textTransformLabel(step);
  const description = label.toLowerCase();
  const matches = inputSchema.filter(
    (column) => column.id === step.params.column.id && column.name === step.params.column.name
  );
  if (matches.length !== 1) {
    throw new TypeError(`The ${description} column reference no longer matches the active R dataframe.`);
  }
  const source = matches[0] as ColumnSchema;
  if (source.name.toLowerCase().startsWith(R_PRIVATE_ROW_ID_PREFIX)) {
    throw new TypeError("Open Wrangler's reserved private row-identity column may not be transformed.");
  }
  if (source.type !== "string") throw new TypeError(`${label} requires an R string or factor column.`);
  const outputName = step.params.newColumn;
  if (outputName !== undefined && outputName.length === 0) {
    throw new TypeError(`The ${description} R column name may not be empty.`);
  }
  const inPlace = outputName === undefined || outputName === source.name;
  if (step.kind === "splitText" && inPlace) {
    throw new TypeError("Split text requires a new output column.");
  }
  if (inPlace) {
    if (activeKeyColumnIds.includes(source.id)) {
      throw new TypeError(
        `${label} cannot replace a keyed data.table column in place. Choose a new output column instead.`
      );
    }
    return Object.freeze(
      inputSchema.map((column) =>
        Object.freeze(
          column.id === source.id ? { ...column, rawType: "character", type: "string" as const } : { ...column }
        )
      )
    );
  }
  if (inputSchema.length >= R_FRAME_CONTRACT_LIMITS.columns) {
    throw new TypeError(`${label} exceeds the R frame contract column limit.`);
  }
  if (Buffer.byteLength(outputName, "utf8") > R_FRAME_CONTRACT_LIMITS.nameBytes) {
    throw new TypeError(`The ${description} R column name exceeds the frame contract limit.`);
  }
  if (outputName.toLowerCase().startsWith(R_PRIVATE_ROW_ID_PREFIX)) {
    throw new TypeError(`The ${description} R column name uses Open Wrangler's reserved private row-identity prefix.`);
  }
  if (inputSchema.some((column) => column.name === outputName)) {
    throw new TypeError(`The R column name ${JSON.stringify(outputName)} already exists.`);
  }
  const id = `c:step:${step.id}:0`;
  if (Buffer.byteLength(id, "utf8") > R_FRAME_CONTRACT_LIMITS.columnIdBytes) {
    throw new TypeError(`The ${description} R column identity exceeds the frame contract limit.`);
  }
  if (inputSchema.some((column) => column.id === id)) {
    throw new TypeError(`The ${description} R column identity already exists in the active dataframe.`);
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

function textTransformLabel(
  step: RTextTransformStep
): "Find and Replace" | "Strip text" | "Split text" | "Capitalize" | "Lowercase" | "Uppercase" {
  if (step.kind === "findReplace") return "Find and Replace";
  if (step.kind === "stripText") return "Strip text";
  if (step.kind === "splitText") return "Split text";
  if (step.kind === "capitalizeText") return "Capitalize";
  if (step.kind === "lowerText") return "Lowercase";
  return "Uppercase";
}

export function schemaAfterTextLength(
  inputSchema: readonly ColumnSchema[],
  step: TextLengthTransformStep
): readonly ColumnSchema[] {
  const matches = inputSchema.filter(
    (column) => column.id === step.params.column.id && column.name === step.params.column.name
  );
  if (matches.length !== 1) {
    throw new TypeError("The text-length column reference no longer matches the active R dataframe.");
  }
  const source = matches[0] as ColumnSchema;
  if (source.name.toLowerCase().startsWith(R_PRIVATE_ROW_ID_PREFIX)) {
    throw new TypeError("Open Wrangler's reserved private row-identity column may not be transformed.");
  }
  if (source.type !== "string") {
    throw new TypeError("Text Length requires an R string column.");
  }
  if (inputSchema.length >= R_FRAME_CONTRACT_LIMITS.columns) {
    throw new TypeError("Text Length exceeds the R frame contract column limit.");
  }
  if (step.params.newColumn.length === 0) throw new TypeError("The text-length R column name may not be empty.");
  if (Buffer.byteLength(step.params.newColumn, "utf8") > R_FRAME_CONTRACT_LIMITS.nameBytes) {
    throw new TypeError("The text-length R column name exceeds the frame contract limit.");
  }
  if (step.params.newColumn.toLowerCase().startsWith(R_PRIVATE_ROW_ID_PREFIX)) {
    throw new TypeError("The text-length R column name uses Open Wrangler's reserved private row-identity prefix.");
  }
  if (inputSchema.some((column) => column.name === step.params.newColumn)) {
    throw new TypeError(`The R column name ${JSON.stringify(step.params.newColumn)} already exists.`);
  }
  const id = `c:step:${step.id}:0`;
  if (Buffer.byteLength(id, "utf8") > R_FRAME_CONTRACT_LIMITS.columnIdBytes) {
    throw new TypeError("The text-length R column identity exceeds the frame contract limit.");
  }
  if (inputSchema.some((column) => column.id === id)) {
    throw new TypeError("The text-length R column identity already exists in the active dataframe.");
  }
  return Object.freeze([
    ...inputSchema.map((column) => Object.freeze({ ...column })),
    Object.freeze({
      id,
      name: step.params.newColumn,
      position: inputSchema.length,
      rawType: "integer",
      type: "integer" as const,
      nullable: source.nullable
    })
  ]);
}

export function schemaAfterClone(
  inputSchema: readonly ColumnSchema[],
  step: CloneColumnTransformStep
): readonly ColumnSchema[] {
  const matches = inputSchema.filter(
    (column) => column.id === step.params.column.id && column.name === step.params.column.name
  );
  if (matches.length !== 1) {
    throw new TypeError("The clone column reference no longer matches the active R dataframe.");
  }
  const source = matches[0] as ColumnSchema;
  if (source.name.toLowerCase().startsWith(R_PRIVATE_ROW_ID_PREFIX)) {
    throw new TypeError("Open Wrangler's reserved private row-identity column may not be cloned.");
  }
  if (inputSchema.length >= R_FRAME_CONTRACT_LIMITS.columns) {
    throw new TypeError("Clone Column exceeds the R frame contract column limit.");
  }
  if (step.params.newName.length === 0) throw new TypeError("The cloned R column name may not be empty.");
  if (Buffer.byteLength(step.params.newName, "utf8") > R_FRAME_CONTRACT_LIMITS.nameBytes) {
    throw new TypeError("The cloned R column name exceeds the frame contract limit.");
  }
  if (step.params.newName.toLowerCase().startsWith(R_PRIVATE_ROW_ID_PREFIX)) {
    throw new TypeError("The cloned R column name uses Open Wrangler's reserved private row-identity prefix.");
  }
  if (inputSchema.some((column) => column.name === step.params.newName)) {
    throw new TypeError(`The R column name ${JSON.stringify(step.params.newName)} already exists.`);
  }
  const id = `c:step:${step.id}:0`;
  if (Buffer.byteLength(id, "utf8") > R_FRAME_CONTRACT_LIMITS.columnIdBytes) {
    throw new TypeError("The cloned R column identity exceeds the frame contract limit.");
  }
  if (inputSchema.some((column) => column.id === id)) {
    throw new TypeError("The cloned R column identity already exists in the active dataframe.");
  }
  return Object.freeze([
    ...inputSchema.map((column) => Object.freeze({ ...column })),
    Object.freeze({
      id,
      name: step.params.newName,
      position: inputSchema.length,
      rawType: source.rawType,
      type: source.type,
      nullable: source.nullable
    })
  ]);
}

export function schemaAfterSelect(
  inputSchema: readonly ColumnSchema[],
  step: SelectColumnsTransformStep
): readonly ColumnSchema[] {
  if (
    !Array.isArray(step.params.columns) ||
    step.params.columns.length === 0 ||
    step.params.columns.length > R_FRAME_CONTRACT_LIMITS.columns
  ) {
    throw new TypeError("Select Columns requires a bounded non-empty R column list.");
  }
  const inputById = new Map(inputSchema.map((column) => [column.id, column]));
  const selectedIds = new Set<string>();
  return Object.freeze(
    step.params.columns.map((reference, position) => {
      const column = inputById.get(reference.id);
      if (!column || column.name !== reference.name) {
        throw new TypeError("A selected column reference no longer matches the active R dataframe.");
      }
      if (selectedIds.has(reference.id)) {
        throw new TypeError("Select Columns contains a repeated R column identity.");
      }
      selectedIds.add(reference.id);
      return Object.freeze({ ...column, position });
    })
  );
}

export function schemaAfterDrop(
  inputSchema: readonly ColumnSchema[],
  step: DropColumnsTransformStep
): readonly ColumnSchema[] {
  if (!Array.isArray(step.params.columns) || step.params.columns.length === 0) {
    throw new TypeError("Drop Columns requires at least one R column.");
  }
  const inputById = new Map(inputSchema.map((column) => [column.id, column]));
  const droppedIds = new Set<string>();
  for (const reference of step.params.columns) {
    const column = inputById.get(reference.id);
    if (!column || column.name !== reference.name) {
      throw new TypeError("A drop column reference no longer matches the active R dataframe.");
    }
    if (droppedIds.has(reference.id)) throw new TypeError("Drop Columns contains a repeated R column identity.");
    droppedIds.add(reference.id);
  }
  if (droppedIds.size >= inputSchema.length) {
    throw new TypeError("Drop Columns must leave at least one visible R column.");
  }
  return Object.freeze(
    inputSchema
      .filter((column) => !droppedIds.has(column.id))
      .map((column, position) => Object.freeze({ ...column, position }))
  );
}

export function reconcileFilterModelById(
  model: FilterModel,
  previousSchema: readonly ColumnSchema[],
  nextSchema: readonly ColumnSchema[]
): FilterModel {
  const uniquePreviousByName = uniqueColumnsByName(previousSchema);
  const nextById = new Map(nextSchema.map((column) => [column.id, column]));
  const uniqueNextByName = uniqueColumnsByName(nextSchema);
  const filters = model.filters.flatMap((filter) => {
    const previous = uniquePreviousByName.get(filter.column);
    const next = previous ? nextById.get(previous.id) : undefined;
    if (
      !previous ||
      !next ||
      uniqueNextByName.get(next.name)?.id !== next.id ||
      previous.type !== filter.type ||
      next.type !== filter.type
    ) {
      return [];
    }
    return [
      {
        ...filter,
        column: next.name,
        predicates: filter.predicates.map((predicate) => ({ ...predicate })),
        ...(filter.valueFilter
          ? { valueFilter: { ...filter.valueFilter, selectedValues: [...filter.valueFilter.selectedValues] } }
          : {})
      }
    ];
  });
  const sort = model.sort.flatMap((rule) => {
    const previous = uniquePreviousByName.get(rule.column);
    const next = previous ? nextById.get(previous.id) : undefined;
    if (!previous || !next || uniqueNextByName.get(next.name)?.id !== next.id || previous.type !== next.type) return [];
    return [{ ...rule, column: next.name }];
  });
  return {
    ...(model.logic ? { logic: model.logic } : {}),
    filters,
    sort
  };
}

function uniqueColumnsByName(schema: readonly ColumnSchema[]): Map<string, ColumnSchema> {
  const grouped = new Map<string, ColumnSchema[]>();
  for (const column of schema) grouped.set(column.name, [...(grouped.get(column.name) ?? []), column]);
  return new Map(
    [...grouped.entries()].flatMap(([name, columns]) =>
      columns.length === 1 ? [[name, columns[0] as ColumnSchema]] : []
    )
  );
}
