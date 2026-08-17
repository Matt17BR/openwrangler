import { supportsViewPredicate } from "../../shared/filterModel";
import type {
  ColumnSchema,
  ColumnSummary,
  FilterModel,
  FilterRowsTransformStep,
  SortRowsTransformStep,
  ValueCount
} from "../../shared/protocol";
import { R_FRAME_CONTRACT_LIMITS, type RColumnType } from "./rFrameContract";
import type {
  RKernelColumnFilter,
  RKernelColumnReference,
  RKernelDatasetStatsResult,
  RKernelSortRule,
  RKernelTransformFilterModel,
  RKernelViewQuery
} from "./rKernelProtocol";

const R_PRIVATE_ROW_ID_PREFIX = "__open_wrangler_internal_row_id_";

type RViewContractSession = Readonly<{
  schema: readonly ColumnSchema[];
  rows: number;
}>;

export function resolveRViewQuery(filterModel: FilterModel, schema: readonly ColumnSchema[]): RKernelViewQuery {
  const filters = Object.freeze(
    filterModel.filters.map<RKernelColumnFilter>((filter) => {
      const column = resolveNamedRColumn(filter.column, schema, "filter");
      const schemaColumn = schema.find((candidate) => candidate.id === column.id) as ColumnSchema;
      const columnType = requireRColumnType(schemaColumn.type);
      if (filter.type !== columnType) {
        throw new TypeError(
          `The filter for ${JSON.stringify(filter.column)} declares ${filter.type}, but the R column is ${schemaColumn.type}.`
        );
      }
      return Object.freeze({
        column,
        type: columnType,
        ...(filter.logic ? { logic: filter.logic } : {}),
        ...(filter.valueFilter
          ? {
              valueFilter: Object.freeze({
                ...filter.valueFilter,
                selectedValues: Object.freeze([...filter.valueFilter.selectedValues])
              })
            }
          : {}),
        predicates: Object.freeze(filter.predicates.map((predicate) => Object.freeze({ ...predicate })))
      });
    })
  );
  return Object.freeze({
    ...(filterModel.logic ? { logic: filterModel.logic } : {}),
    filters,
    sorts: resolveRSorts(filterModel, schema)
  });
}

export function assertRColumnValuesContract(
  session: RViewContractSession,
  requested: RKernelColumnReference,
  result: Readonly<{ column: string; values: readonly ValueCount[]; hasMore: boolean; sampleSize?: number }>,
  limit: number,
  search: string | undefined
): void {
  const schema = session.schema.find((column) => column.id === requested.id);
  if (!schema || schema.name !== requested.name || result.column !== requested.name || result.values.length > limit) {
    throw new Error("The R kernel returned values for the wrong column or request limit.");
  }
  const expectedType = requireRColumnType(schema.type);
  if (
    result.sampleSize !== undefined &&
    (result.sampleSize !== R_FRAME_CONTRACT_LIMITS.profileSampleRows ||
      result.sampleSize >= session.rows ||
      (search !== undefined && search !== "") ||
      !result.hasMore)
  ) {
    throw new Error("The R kernel returned an invalid column-value sample size.");
  }
  const countDomain = result.sampleSize ?? session.rows;
  let returnedCount = 0;
  for (const entry of result.values) {
    if (
      !Number.isSafeInteger(entry.count) ||
      entry.count < 1 ||
      entry.count > countDomain ||
      entry.count > countDomain - returnedCount ||
      entry.selectionValue === undefined ||
      entry.selectionValue.columnType !== expectedType
    ) {
      throw new Error("The R kernel returned values with incompatible typed selections or row counts.");
    }
    returnedCount += entry.count;
  }
}

export function resolveNamedRColumn(
  name: string,
  schema: readonly ColumnSchema[],
  purpose: "filter" | "sort" | "values"
): RKernelColumnReference {
  const matches = schema.filter((column) => column.name === name);
  if (matches.length !== 1) {
    throw new TypeError(
      matches.length === 0
        ? `The ${purpose} column ${JSON.stringify(name)} is no longer in this R dataframe.`
        : `The ${purpose} column ${JSON.stringify(name)} is ambiguous because that name is repeated.`
    );
  }
  const column = matches[0] as ColumnSchema;
  return Object.freeze({ id: column.id, name: column.name });
}

export function resolveRTransformSortRules(
  rules: readonly SortRowsTransformStep["params"]["rules"][number][],
  schema: readonly ColumnSchema[],
  purpose: string
): readonly RKernelSortRule[] {
  if (rules.length > R_FRAME_CONTRACT_LIMITS.sortRules) {
    throw new TypeError(`${purpose} supports at most ${R_FRAME_CONTRACT_LIMITS.sortRules} sort rules.`);
  }
  const seen = new Set<string>();
  return Object.freeze(
    rules.map((rule) => {
      const column = requireRTransformColumn(rule.column, schema, purpose);
      if (seen.has(column.id)) throw new TypeError(`${purpose} repeats the same R column identity.`);
      seen.add(column.id);
      return Object.freeze({
        column: Object.freeze({ id: column.id, name: column.name }),
        direction: rule.direction,
        nulls: rule.nulls
      });
    })
  );
}

export function resolveRTransformFilterModel(
  model: FilterRowsTransformStep["params"]["filterModel"],
  schema: readonly ColumnSchema[]
): RKernelTransformFilterModel {
  if (model.filters.length > R_FRAME_CONTRACT_LIMITS.filters) {
    throw new TypeError(`Filter rows supports at most ${R_FRAME_CONTRACT_LIMITS.filters} column filters.`);
  }
  const seen = new Set<string>();
  const filters = Object.freeze(
    model.filters.map<RKernelColumnFilter>((filter) => {
      const column = requireRTransformColumn(filter.column, schema, "Filter rows");
      if (seen.has(column.id)) throw new TypeError("Filter rows repeats the same R column identity.");
      seen.add(column.id);
      const type = requireRColumnType(column.type);
      if (filter.type !== type) {
        throw new TypeError(
          `Filter rows declares ${filter.type} for ${JSON.stringify(column.name)}, but the R column is ${type}.`
        );
      }
      if (filter.predicates.length > R_FRAME_CONTRACT_LIMITS.predicatesPerFilter) {
        throw new TypeError(
          `Filter rows supports at most ${R_FRAME_CONTRACT_LIMITS.predicatesPerFilter} predicates per column.`
        );
      }
      for (const predicate of filter.predicates) {
        if (!supportsViewPredicate(type, predicate.operator)) {
          throw new TypeError(`The ${predicate.operator} predicate is not available for R ${type} columns.`);
        }
      }
      if (
        filter.valueFilter &&
        filter.valueFilter.selectedValues.length > R_FRAME_CONTRACT_LIMITS.selectedValuesPerFilter
      ) {
        throw new TypeError(
          `Filter rows supports at most ${R_FRAME_CONTRACT_LIMITS.selectedValuesPerFilter} selected values per column.`
        );
      }
      return Object.freeze({
        column: Object.freeze({ id: column.id, name: column.name }),
        type,
        ...(filter.logic ? { logic: filter.logic } : {}),
        ...(filter.valueFilter
          ? {
              valueFilter: Object.freeze({
                ...filter.valueFilter,
                selectedValues: Object.freeze([...filter.valueFilter.selectedValues])
              })
            }
          : {}),
        predicates: Object.freeze(filter.predicates.map((predicate) => Object.freeze({ ...predicate })))
      });
    })
  );
  return Object.freeze({
    ...(model.logic ? { logic: model.logic } : {}),
    filters,
    sort: resolveRTransformSortRules(model.sort, schema, "Filter rows")
  });
}

export function requireRTransformColumn(
  reference: Readonly<{ id: string; name: string }>,
  schema: readonly ColumnSchema[],
  purpose: string
): ColumnSchema {
  const matches = schema.filter((column) => column.id === reference.id && column.name === reference.name);
  if (matches.length !== 1) {
    throw new TypeError(`${purpose} contains a stale or mismatched R column reference.`);
  }
  const column = matches[0] as ColumnSchema;
  if (column.name.toLowerCase().startsWith(R_PRIVATE_ROW_ID_PREFIX)) {
    throw new TypeError("Open Wrangler's reserved private row-identity column may not be transformed.");
  }
  return column;
}

export function resolveRProfileColumns(
  columnIds: readonly string[],
  schema: readonly ColumnSchema[]
): readonly RKernelColumnReference[] {
  if (columnIds.length === 0 || new Set(columnIds).size !== columnIds.length) {
    throw new TypeError("R profile columns must be a non-empty unique list.");
  }
  const schemaById = new Map(schema.map((column) => [column.id, column]));
  return Object.freeze(
    columnIds.map((columnId) => {
      const column = schemaById.get(columnId);
      if (!column) throw new TypeError(`The profile column ${JSON.stringify(columnId)} is no longer available.`);
      return Object.freeze({ id: column.id, name: column.name });
    })
  );
}

export function assertRSummaryContract(
  session: RViewContractSession,
  requested: readonly RKernelColumnReference[],
  summaries: readonly ColumnSummary[],
  view: RKernelViewQuery
): void {
  if (summaries.length !== requested.length) {
    throw new Error("The R kernel returned summaries for the wrong column projection.");
  }
  const schemaById = new Map(session.schema.map((column) => [column.id, column]));
  const totalRows = summaries[0]?.totalCount ?? 0;
  if (
    totalRows > session.rows ||
    (view.filters.length === 0 && totalRows !== session.rows) ||
    summaries.some((summary) => summary.totalCount !== totalRows)
  ) {
    throw new Error("The R kernel returned summaries for inconsistent filtered views.");
  }
  for (const [index, summary] of summaries.entries()) {
    const reference = requested[index] as RKernelColumnReference;
    const schema = schemaById.get(reference.id);
    if (
      !schema ||
      summary.columnId !== reference.id ||
      summary.column !== reference.name ||
      summary.column !== schema.name ||
      summary.type !== schema.type ||
      summary.rawType !== schema.rawType ||
      summary.totalCount !== totalRows ||
      summary.nullCount + summary.nanCount > totalRows ||
      (summary.distinctCount !== undefined &&
        summary.distinctCount > totalRows - summary.nullCount - summary.nanCount) ||
      summary.topValues.reduce((count, value) => count + value.count, 0) >
        totalRows - summary.nullCount - summary.nanCount
    ) {
      throw new Error("The R kernel returned a summary that does not match the active dataframe.");
    }
    if (
      summary.visualization?.kind === "boolean" &&
      summary.visualization.trueCount + summary.visualization.falseCount !==
        totalRows - summary.nullCount - summary.nanCount
    ) {
      throw new Error("The R kernel returned inconsistent boolean profile counts.");
    }
  }
}

export function assertRDatasetStatsContract(
  session: RViewContractSession,
  result: RKernelDatasetStatsResult,
  view: RKernelViewQuery
): void {
  const rows = result.totalRows;
  const columns = session.schema.length;
  const duplicateRowsDomain = result.stats.duplicateRowsSampleSize ?? rows;
  if (
    rows > session.rows ||
    (view.filters.length === 0 && rows !== session.rows) ||
    result.stats.missingRows > rows ||
    duplicateRowsDomain > rows ||
    result.stats.duplicateRows > Math.max(0, duplicateRowsDomain - 1) ||
    result.stats.missingCells > rows * columns ||
    result.stats.missingValuesByColumn.length !== columns
  ) {
    throw new Error("The R kernel returned dataset statistics outside the active dataframe shape.");
  }
  let missingCells = 0;
  for (const [index, entry] of result.stats.missingValuesByColumn.entries()) {
    if (entry.column !== session.schema[index]?.name || entry.count > rows) {
      throw new Error("The R kernel returned dataset statistics for the wrong column projection.");
    }
    missingCells += entry.count;
  }
  if (missingCells !== result.stats.missingCells) {
    throw new Error("The R kernel returned inconsistent missing-value totals.");
  }
}

function requireRColumnType(type: ColumnSchema["type"]): RColumnType {
  if (
    type === "string" ||
    type === "integer" ||
    type === "float" ||
    type === "boolean" ||
    type === "datetime" ||
    type === "date" ||
    type === "duration"
  ) {
    return type;
  }
  throw new TypeError(`The R dataframe exposed an unsupported ${type} column type.`);
}

function resolveRSorts(filterModel: FilterModel, schema: readonly ColumnSchema[]): readonly RKernelSortRule[] {
  if (filterModel.sort.length > R_FRAME_CONTRACT_LIMITS.sortRules) {
    throw new TypeError(`R views support at most ${R_FRAME_CONTRACT_LIMITS.sortRules} sort rules.`);
  }
  const seen = new Set<string>();
  return Object.freeze(
    filterModel.sort.map((rule) => {
      const reference = resolveNamedRColumn(rule.column, schema, "sort");
      const column = schema.find((candidate) => candidate.id === reference.id) as ColumnSchema;
      if (seen.has(column.id)) throw new TypeError(`The sort column ${JSON.stringify(rule.column)} is repeated.`);
      seen.add(column.id);
      return Object.freeze({
        column: Object.freeze({ id: column.id, name: column.name }),
        direction: rule.direction,
        nulls: rule.nulls
      });
    })
  );
}
