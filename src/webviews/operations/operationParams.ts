import type { FilterModel } from "../../shared/filterModel";
import { isActiveColumnFilter } from "../../shared/filterModel";
import type {
  ColumnReference,
  ColumnSchema,
  OperationKind,
  TransformFilterModel,
  TransformStep
} from "../../shared/protocol";
import { buildFillMissingParams } from "./fillMissingModel";
import { portableRegexContract, validatePortableRegexOutputName } from "../../shared/portableRegex";
import { portablePivotLongerNameKey, validatePivotLongerOutputName } from "../../shared/pivotLonger";
import {
  MAX_PIVOT_WIDER_COLUMNS,
  pivotWiderKeyValue,
  portablePivotWiderNameKey,
  validatePivotWiderOutputName
} from "../../shared/pivotWider";

export type OperationParamsFor<Kind extends OperationKind> = Extract<TransformStep, { kind: Kind }>["params"];

export function buildParams<Kind extends OperationKind>(
  kind: Kind,
  form: FormData,
  filterModel: FilterModel,
  availableColumns: readonly ColumnSchema[],
  savedFilterModel?: TransformFilterModel
): OperationParamsFor<Kind>;
export function buildParams(
  kind: OperationKind,
  form: FormData,
  filterModel: FilterModel,
  availableColumns: readonly ColumnSchema[],
  savedFilterModel?: TransformFilterModel
): Record<string, unknown> {
  const value = (name: string) => String(form.get(name) ?? "");
  const optional = (target: Record<string, unknown>, name: string, transformed = value(name)) => {
    if (transformed !== "") target[name] = transformed;
  };
  const columnReference = (name: string) => referenceForId(value(name), availableColumns);
  const columnReferences = (name: string) =>
    form
      .getAll(name)
      .map(String)
      .map((id) => referenceForId(id, availableColumns));
  const requiredColumnReferences = (name: string, label: string) => {
    const references = columnReferences(name);
    if (references.length === 0) throw new Error(`${label} requires at least one compatible column.`);
    return references;
  };

  switch (kind) {
    case "sortRows": {
      const columns = columnReferences("sortColumn");
      if (columns.length === 0) throw new Error("Sort rows requires at least one sort rule.");
      const directions = form.getAll("sortDirection").map(String);
      const nulls = form.getAll("sortNulls").map(String);
      return {
        rules: columns.map((column, index) => ({
          column,
          direction: directions[index],
          nulls: nulls[index]
        }))
      };
    }
    case "filterRows": {
      const useSaved = savedFilterModel !== undefined && value("filterSource") !== "current";
      return { filterModel: useSaved ? savedFilterModel : transformFilterModel(filterModel, availableColumns) };
    }
    case "dropMissingRows": {
      const columns = columnReferences("columns");
      return { ...(columns.length > 0 ? { columns } : {}), how: value("how") };
    }
    case "fillMissingValues":
      return { ...buildFillMissingParams(form, availableColumns) };
    case "dropDuplicates": {
      const params: Record<string, unknown> = { keep: value("keep") };
      const columns = columnReferences("columns");
      if (columns.length) params.columns = columns;
      return params;
    }
    case "selectColumns":
    case "dropColumns":
      return {
        columns: requiredColumnReferences("columns", kind === "selectColumns" ? "Select columns" : "Drop columns")
      };
    case "oneHotEncode":
      return {
        columns: requiredColumnReferences("columns", "One-hot encoding"),
        prefixSeparator: value("prefixSeparator"),
        dropOriginal: form.has("dropOriginal")
      };
    case "renameColumn":
    case "cloneColumn":
      return { column: columnReference("column"), newName: value("newName") };
    case "castColumn":
      return { column: columnReference("column"), dtype: value("dtype") };
    case "formula": {
      const scalar = value("value").trim();
      if (value("operandMode") !== "column" && (scalar === "" || !Number.isFinite(Number(scalar)))) {
        throw new Error("Formula requires one finite numeric value or a right column.");
      }
      return {
        leftColumn: columnReference("leftColumn"),
        operator: value("operator"),
        newColumn: value("newColumn"),
        ...(value("operandMode") === "column"
          ? { rightColumn: columnReference("rightColumn") }
          : { value: Number(scalar) })
      };
    }
    case "textLength":
      return { column: columnReference("column"), newColumn: value("newColumn") };
    case "multiLabelBinarize": {
      const params: Record<string, unknown> = {
        column: columnReference("column"),
        delimiter: value("delimiter"),
        dropOriginal: form.has("dropOriginal")
      };
      if (value("prefixMode") === "custom") params.prefix = value("prefix");
      return params;
    }
    case "findReplace": {
      const params: Record<string, unknown> = {
        column: columnReference("column"),
        find: value("find"),
        replacement: value("replacement"),
        regex: form.has("regex")
      };
      optional(params, "newColumn");
      return params;
    }
    case "stripText": {
      const params: Record<string, unknown> = { column: columnReference("column") };
      optional(params, "characters");
      optional(params, "newColumn");
      return params;
    }
    case "splitText":
      return {
        column: columnReference("column"),
        delimiter: value("delimiter"),
        index: Number(value("index")),
        newColumn: value("newColumn")
      };
    case "splitTextColumns": {
      const delimiter = value("delimiter");
      const newColumns = form.getAll("newColumns").map(String);
      if (delimiter.length === 0) throw new TypeError("Split text into columns requires a literal delimiter.");
      if (
        newColumns.length < 2 ||
        newColumns.length > 64 ||
        newColumns.some((name) => name.length === 0) ||
        new Set(newColumns).size !== newColumns.length
      ) {
        throw new TypeError("Split text into columns requires 2 to 64 unique output names.");
      }
      return {
        column: columnReference("column"),
        delimiter,
        newColumns
      };
    }
    case "pivotLonger": {
      const columns = columnReferences("columns");
      if (columns.length < 2 || columns.length > 64) {
        throw new TypeError("Pivot longer requires 2 to 64 ordered columns.");
      }
      if (new Set(columns.map((column) => column.id)).size !== columns.length) {
        throw new TypeError("Pivot longer requires unique ordered columns.");
      }
      const selected = columns.map((reference) => {
        const column = availableColumns.find((candidate) => candidate.id === reference.id);
        if (!column) throw new TypeError("Pivot longer contains an unavailable column.");
        return column;
      });
      if (selected.some((column) => column.type !== selected[0]!.type || column.rawType !== selected[0]!.rawType)) {
        throw new TypeError("Pivot longer requires columns with one exactly compatible scalar type.");
      }
      const labelColumn = value("labelColumn");
      const valueColumn = value("valueColumn");
      validatePivotLongerOutputName(labelColumn, "Pivot longer label output name");
      validatePivotLongerOutputName(valueColumn, "Pivot longer value output name");
      const existing = new Set(availableColumns.map((column) => portablePivotLongerNameKey(column.name)));
      const labelKey = portablePivotLongerNameKey(labelColumn);
      const valueKey = portablePivotLongerNameKey(valueColumn);
      if (labelKey === valueKey || existing.has(labelKey) || existing.has(valueKey)) {
        throw new TypeError("Pivot-longer output names must be distinct from each other and the input schema.");
      }
      return { columns, labelColumn, valueColumn };
    }
    case "pivotWider": {
      const namesFrom = columnReference("namesFrom");
      const valuesFrom = columnReference("valuesFrom");
      if (namesFrom.id === valuesFrom.id) {
        throw new TypeError("Pivot wider requires distinct names-from and values-from columns.");
      }
      const keyValues = form.getAll("pivotWiderKey").map(String);
      const outputNames = form.getAll("pivotWiderName").map(String);
      if (keyValues.length < 2 || keyValues.length > 64 || keyValues.length !== outputNames.length) {
        throw new TypeError("Pivot wider requires 2 to 64 complete ordered outputs.");
      }
      const removed = new Set([namesFrom.id, valuesFrom.id]);
      const existing = new Set(
        availableColumns
          .filter((column) => !removed.has(column.id))
          .map((column) => portablePivotWiderNameKey(column.name))
      );
      const nameKeys: string[] = [];
      const outputs = keyValues.map((keyValue, index) => {
        const name = outputNames[index]!;
        validatePivotWiderOutputName(name, `Pivot wider output ${index + 1} name`);
        const nameKey = portablePivotWiderNameKey(name);
        if (existing.has(nameKey))
          throw new TypeError("Pivot-wider output names must not collide with retained columns.");
        nameKeys.push(nameKey);
        const key = {
          kind: "typedSelection" as const,
          version: 1 as const,
          columnType: "string" as const,
          cell: { kind: "string" as const, raw: keyValue, display: keyValue, isNull: false, isNaN: false }
        };
        pivotWiderKeyValue(key);
        return { key, name };
      });
      if (new Set(keyValues).size !== keyValues.length || new Set(nameKeys).size !== nameKeys.length) {
        throw new TypeError("Pivot wider requires unique typed keys and portable output names.");
      }
      if (availableColumns.length - 2 + outputs.length > MAX_PIVOT_WIDER_COLUMNS) {
        throw new TypeError(`Pivot wider cannot create more than ${MAX_PIVOT_WIDER_COLUMNS.toLocaleString()} columns.`);
      }
      return { namesFrom, valuesFrom, outputs };
    }
    case "extractRegexGroup": {
      const pattern = value("pattern");
      const group = Number(value("group"));
      portableRegexContract(pattern, group);
      validatePortableRegexOutputName(value("newColumn"));
      return {
        column: columnReference("column"),
        pattern,
        group,
        newColumn: value("newColumn")
      };
    }
    case "capitalizeText":
    case "lowerText":
    case "upperText":
    case "minMaxScale":
    case "floorNumber":
    case "ceilNumber": {
      const params: Record<string, unknown> = { column: columnReference("column") };
      optional(params, "newColumn");
      return params;
    }
    case "roundNumber": {
      const params: Record<string, unknown> = {
        column: columnReference("column"),
        decimals: Number(value("decimals"))
      };
      optional(params, "newColumn");
      return params;
    }
    case "formatDatetime": {
      const params: Record<string, unknown> = { column: columnReference("column"), format: value("format") };
      optional(params, "newColumn");
      return params;
    }
    case "groupBy": {
      const columns = form.getAll("aggregationColumn").map(String);
      const operations = form.getAll("aggregationOperation").map(String);
      const aliases = form.getAll("aggregationAlias").map(String);
      if (columns.length === 0 || columns.length !== operations.length || columns.length !== aliases.length) {
        throw new Error("Group by requires at least one complete compatible aggregation.");
      }
      return {
        keys: requiredColumnReferences("keys", "Group by"),
        aggregations: columns.map((id, index) => ({
          column: referenceForId(id, availableColumns),
          operation: operations[index],
          alias: aliases[index]
        }))
      };
    }
    case "byExample": {
      const examplesJson = value("examples");
      rejectUnsafeIntegerJsonTokens(examplesJson);
      let examples: unknown;
      try {
        examples = JSON.parse(examplesJson);
      } catch {
        throw new Error("Examples must be valid JSON.");
      }
      if (!Array.isArray(examples)) throw new Error("Examples JSON must be an array.");
      const sourceColumns = requiredColumnReferences("sourceColumns", "By-example");
      if (sourceColumns.length > 16) throw new Error("By-example supports at most 16 source columns.");
      if (examples.length < 2 || examples.length > 64) {
        throw new Error("By-example requires between 2 and 64 examples.");
      }
      for (const [index, example] of examples.entries()) {
        if (
          typeof example !== "object" ||
          example === null ||
          Array.isArray(example) ||
          !("inputs" in example) ||
          !Array.isArray(example.inputs) ||
          example.inputs.length !== sourceColumns.length ||
          !("output" in example)
        ) {
          throw new Error(
            `Example ${index + 1} inputs must be an array with ${sourceColumns.length} values in source-column order.`
          );
        }
        if (!example.inputs.every(isSafeByExampleScalar) || !isSafeByExampleScalar(example.output)) {
          throw new Error(
            `Example ${index + 1} values must be portable JSON scalars; negative zero is not supported and integer values must stay within JavaScript's exact safe range.`
          );
        }
      }
      return { sourceColumns, newColumn: value("newColumn"), examples };
    }
    case "customCode":
      return { code: value("code") };
    default:
      return unsupportedOperationKind(kind);
  }
}

export function columnReferenceId(value: unknown): string | undefined {
  return typeof value === "object" && value !== null && "id" in value && typeof value.id === "string"
    ? value.id
    : undefined;
}

function referenceForId(id: string, columns: readonly ColumnSchema[]): ColumnReference {
  const column = columns.find((candidate) => candidate.id === id);
  if (!column) throw new Error("The selected column is no longer available.");
  return { id: column.id, name: column.name };
}

function transformFilterModel(filterModel: FilterModel, columns: readonly ColumnSchema[]): TransformFilterModel {
  const referenceForName = (name: string): ColumnReference => {
    const matches = columns.filter((column) => column.name === name);
    if (matches.length === 0) {
      throw new Error(`Viewing query column “${name}” is no longer available in the operation input.`);
    }
    if (matches.length > 1) {
      throw new Error(
        `Viewing query column “${name}” is ambiguous because ${matches.length} input columns share that name.`
      );
    }
    return { id: matches[0].id, name: matches[0].name };
  };

  return {
    ...(filterModel.logic === undefined ? {} : { logic: filterModel.logic }),
    filters: filterModel.filters
      .filter(isActiveColumnFilter)
      .map((filter) => ({ ...filter, column: referenceForName(filter.column) })),
    sort: filterModel.sort.map((rule) => ({ ...rule, column: referenceForName(rule.column) }))
  };
}

function isSafeByExampleScalar(value: unknown): value is string | number | boolean | null {
  if (value === null || typeof value === "string" || typeof value === "boolean") return true;
  return (
    typeof value === "number" &&
    Number.isFinite(value) &&
    !Object.is(value, -0) &&
    (!Number.isInteger(value) || Number.isSafeInteger(value))
  );
}

function rejectUnsafeIntegerJsonTokens(source: string): void {
  let inString = false;
  let escaped = false;
  for (let index = 0; index < source.length; index += 1) {
    const character = source[index];
    if (inString) {
      if (escaped) escaped = false;
      else if (character === "\\") escaped = true;
      else if (character === '"') inString = false;
      continue;
    }
    if (character === '"') {
      inString = true;
      continue;
    }
    if (character !== "-" && (character < "0" || character > "9")) continue;
    const match = source.slice(index).match(/^-?(?:0|[1-9]\d*)(?:\.\d+)?(?:[eE][+-]?\d+)?/u);
    if (!match) continue;
    const token = match[0];
    const numeric = Number(token);
    if (Number.isFinite(numeric) && Number.isInteger(numeric) && !Number.isSafeInteger(numeric)) {
      throw new Error(
        `Integer token ${token} is outside JavaScript's exact safe range; use smaller examples to synthesize the same operation.`
      );
    }
    index += token.length - 1;
  }
}

function unsupportedOperationKind(kind: never): never {
  throw new Error(`Unsupported operation kind: ${String(kind)}`);
}
