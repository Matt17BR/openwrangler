import { useId, useRef, useState } from "react";
import type { ColumnSchema, SessionMetadata, TransformSortRule, TransformStep } from "../../shared/protocol";
import { columnTypePresentation } from "../columnTypes";
import {
  defaultFillModeForColumn,
  directionalOrderColumnsForTarget,
  explicitFillValue,
  explicitFillValueKind,
  fallbackColumnsForTarget,
  fillModeForReplacement,
  fillModesForColumn,
  fillTargetColumns,
  fillValueKindForColumn,
  groupedKeyColumnsForTarget,
  interpolationCoordinateColumnsForTarget,
  maxFillDirectionalGap,
  maxFillFallbackColumns,
  normalizeFillNumericValue,
  retainDistinctAvailableIds
} from "./fillMissingModel";
import type { FillMode, FillValueKind } from "./fillMissingModel";
import {
  ColumnReferenceSelect,
  ColumnReferencesSelect,
  Fieldset,
  moveItem,
  RowActions,
  SelectField,
  TextField
} from "./operationFormControls";

interface FillFallbackRow {
  readonly key: string;
  readonly columnId: string;
}

interface FillOrderRow {
  readonly key: string;
  readonly columnId: string;
  readonly direction: TransformSortRule["direction"];
  readonly nulls: TransformSortRule["nulls"];
}

const fillValueKindOptions: readonly [FillValueKind, string][] = [
  ["string", "Text"],
  ["integer", "Integer"],
  ["float", "Number"],
  ["decimal", "Decimal"],
  ["boolean", "True / false"],
  ["date", "Date"],
  ["datetime", "Date and time"]
];

export function FillMissingFields({
  backend,
  columns,
  initialStep
}: {
  backend: SessionMetadata["backend"];
  columns: ColumnSchema[];
  initialStep?: TransformStep;
}) {
  const initialParams = initialStep?.kind === "fillMissingValues" ? initialStep.params : undefined;
  const initialReplacement = initialParams?.replacement;
  const availableColumns = fillTargetColumns(columns);
  const savedColumnId = initialParams?.column.id;
  const [selectedColumnId, setSelectedColumnId] = useState(() =>
    savedColumnId && availableColumns.some((column) => column.id === savedColumnId)
      ? savedColumnId
      : (availableColumns.find((column) => column.nullable)?.id ?? availableColumns[0]?.id ?? "")
  );
  const selectedColumn = availableColumns.find((column) => column.id === selectedColumnId);
  const savedInterpolationCoordinateId =
    initialReplacement?.kind === "linearInterpolation" ? initialReplacement.coordinate.id : undefined;
  const initialInterpolationCoordinates = interpolationCoordinateColumnsForTarget(selectedColumn, columns);
  const [interpolationCoordinateId, setInterpolationCoordinateId] = useState(() =>
    savedInterpolationCoordinateId &&
    initialInterpolationCoordinates.some((column) => column.id === savedInterpolationCoordinateId)
      ? savedInterpolationCoordinateId
      : (initialInterpolationCoordinates[0]?.id ?? "")
  );
  const savedFallbackColumnIds =
    initialReplacement?.kind === "fallbackColumns" ? initialReplacement.columns.map((column) => column.id) : [];
  const initialFallbackColumns = fallbackColumnsForTarget(selectedColumn, columns);
  const restoredFallbackIds = retainDistinctAvailableIds(
    savedFallbackColumnIds,
    initialFallbackColumns,
    maxFillFallbackColumns
  );
  const initialFallbackIds =
    restoredFallbackIds.length > 0
      ? restoredFallbackIds
      : initialFallbackColumns[0]
        ? [initialFallbackColumns[0].id]
        : [];
  const nextFallbackRowId = useRef(Math.max(1, initialFallbackIds.length));
  const [fallbackRows, setFallbackRows] = useState<FillFallbackRow[]>(() =>
    initialFallbackIds.map((columnId, index) => ({ key: `fill-fallback-${index}`, columnId }))
  );
  const savedGroupedKeyIds =
    initialReplacement?.kind === "groupedStatistic" ? initialReplacement.keys.map((column) => column.id) : [];
  const initialGroupedKeyColumns = groupedKeyColumnsForTarget(selectedColumn, columns);
  const restoredGroupedKeyIds = retainDistinctAvailableIds(savedGroupedKeyIds, initialGroupedKeyColumns);
  const initialGroupedKeyIds =
    restoredGroupedKeyIds.length > 0
      ? restoredGroupedKeyIds
      : initialGroupedKeyColumns[0]
        ? [initialGroupedKeyColumns[0].id]
        : [];
  const [groupedKeyIds, setGroupedKeyIds] = useState<string[]>(initialGroupedKeyIds);
  const savedDirectionalRules = initialReplacement?.kind === "directional" ? initialReplacement.orderBy : ([] as const);
  const initialOrderColumns = directionalOrderColumnsForTarget(selectedColumn, columns);
  const initialOrderRows = (() => {
    const availableIds = new Set(initialOrderColumns.map((column) => column.id));
    const seen = new Set<string>();
    const restored = savedDirectionalRules.flatMap((rule, index): FillOrderRow[] => {
      if (!availableIds.has(rule.column.id) || seen.has(rule.column.id)) return [];
      seen.add(rule.column.id);
      return [
        {
          key: `fill-order-${index}`,
          columnId: rule.column.id,
          direction: rule.direction,
          nulls: rule.nulls
        }
      ];
    });
    if (restored.length > 0) return restored;
    const first = initialOrderColumns[0];
    return first
      ? [{ key: "fill-order-0", columnId: first.id, direction: "asc" as const, nulls: "last" as const }]
      : [];
  })();
  const nextOrderRowId = useRef(Math.max(1, initialOrderRows.length));
  const [orderRows, setOrderRows] = useState<FillOrderRow[]>(initialOrderRows);
  const savedMode = fillModeForReplacement(initialReplacement);
  const fallbackColumns = fallbackColumnsForTarget(selectedColumn, columns);
  const [mode, setMode] = useState<FillMode>(() =>
    savedMode && fillModesForColumn(selectedColumn, columns).includes(savedMode)
      ? savedMode
      : defaultFillModeForColumn(selectedColumn, columns)
  );
  const [unknownValueKind, setUnknownValueKind] = useState<FillValueKind>(
    explicitFillValueKind(initialReplacement) ?? "string"
  );

  const changeColumn = (id: string) => {
    setSelectedColumnId(id);
    const column = availableColumns.find((candidate) => candidate.id === id);
    const nextFallbackColumns = fallbackColumnsForTarget(column, columns);
    setFallbackRows((current) => {
      const retainedIds = new Set(
        retainDistinctAvailableIds(
          current.map((row) => row.columnId),
          nextFallbackColumns,
          maxFillFallbackColumns
        )
      );
      const retained = current.filter((row) => retainedIds.delete(row.columnId));
      if (retained.length > 0) return retained;
      const first = nextFallbackColumns[0];
      return first ? [{ key: `fill-fallback-${nextFallbackRowId.current++}`, columnId: first.id }] : [];
    });
    const nextGroupedKeyColumns = groupedKeyColumnsForTarget(column, columns);
    setGroupedKeyIds((current) => {
      const retained = retainDistinctAvailableIds(current, nextGroupedKeyColumns);
      if (retained.length > 0) return retained;
      return nextGroupedKeyColumns[0] ? [nextGroupedKeyColumns[0].id] : [];
    });
    const nextInterpolationCoordinates = interpolationCoordinateColumnsForTarget(column, columns);
    setInterpolationCoordinateId((current) =>
      nextInterpolationCoordinates.some((candidate) => candidate.id === current)
        ? current
        : (nextInterpolationCoordinates[0]?.id ?? "")
    );
    const nextOrderColumns = directionalOrderColumnsForTarget(column, columns);
    setOrderRows((current) => {
      const retainedIds = new Set(
        retainDistinctAvailableIds(
          current.map((row) => row.columnId),
          nextOrderColumns
        )
      );
      const retained = current.filter((row) => retainedIds.delete(row.columnId));
      if (retained.length > 0) return retained;
      const first = nextOrderColumns[0];
      return first
        ? [
            {
              key: `fill-order-${nextOrderRowId.current++}`,
              columnId: first.id,
              direction: "asc",
              nulls: "last"
            }
          ]
        : [];
    });
    setUnknownValueKind(column?.type === "unknown" ? "string" : fillValueKindForColumn(column?.type));
    setMode((current) =>
      fillModesForColumn(column, columns).includes(current) ? current : defaultFillModeForColumn(column, columns)
    );
  };
  const valueKind =
    selectedColumn?.type === "unknown" ? unknownValueKind : fillValueKindForColumn(selectedColumn?.type);
  const fillModes = fillModesForColumn(selectedColumn, columns);
  const interpolationCoordinates = interpolationCoordinateColumnsForTarget(selectedColumn, columns);
  const groupedKeyColumns = groupedKeyColumnsForTarget(selectedColumn, columns);
  const orderColumns = directionalOrderColumnsForTarget(selectedColumn, columns);
  const selectedOrderIds = new Set(orderRows.map((row) => row.columnId));
  const nextUnusedOrder = orderColumns.find((column) => !selectedOrderIds.has(column.id));
  const selectedFallbackIds = new Set(fallbackRows.map((row) => row.columnId));
  const nextUnusedFallback = fallbackColumns.find((column) => !selectedFallbackIds.has(column.id));
  const incompatibleFallbackCount = selectedColumn
    ? columns.filter((column) => column.id !== selectedColumn.id && column.type !== selectedColumn.type).length
    : 0;
  const methodHelpId = useId();
  const methodDescription = selectedColumn
    ? `Available methods are based on the selected ${columnTypePresentation(selectedColumn).label.toLowerCase()} column.`
    : "Choose a supported column to see its available methods.";

  return (
    <>
      <ColumnReferenceSelect
        name="column"
        label="Column"
        columns={availableColumns}
        value={selectedColumnId}
        onChange={changeColumn}
        emptyMessage="No supported columns are available."
      />
      <label className="formField">
        <span>Method</span>
        <select
          name="fillMode"
          aria-label="Method"
          aria-describedby={methodHelpId}
          value={mode}
          onChange={(event) => setMode(event.target.value as FillMode)}
        >
          {fillModes.some((candidate) => ["median", "mean", "mostFrequent"].includes(candidate)) && (
            <optgroup label="Column statistics">
              {fillModes.includes("median") && <option value="median">Median</option>}
              {fillModes.includes("mean") && <option value="mean">Mean</option>}
              {fillModes.includes("mostFrequent") && <option value="mostFrequent">Most common value</option>}
            </optgroup>
          )}
          {fillModes.some((candidate) =>
            ["groupedMedian", "groupedMean", "groupedMostFrequent"].includes(candidate)
          ) && (
            <optgroup label="Within groups">
              {fillModes.includes("groupedMedian") && <option value="groupedMedian">Median within groups</option>}
              {fillModes.includes("groupedMean") && <option value="groupedMean">Mean within groups</option>}
              {fillModes.includes("groupedMostFrequent") && (
                <option value="groupedMostFrequent">Most common value within groups</option>
              )}
            </optgroup>
          )}
          {fillModes.some((candidate) =>
            ["linearInterpolation", "directionalForward", "directionalBackward"].includes(candidate)
          ) && (
            <optgroup label="Ordered data">
              {fillModes.includes("linearInterpolation") && (
                <option value="linearInterpolation">Linear interpolation</option>
              )}
              {fillModes.includes("directionalForward") && <option value="directionalForward">Previous value</option>}
              {fillModes.includes("directionalBackward") && <option value="directionalBackward">Next value</option>}
            </optgroup>
          )}
          {fillModes.includes("fallbackColumns") && (
            <optgroup label="Other columns">
              <option value="fallbackColumns">Fallback columns (same row)</option>
            </optgroup>
          )}
          {fillModes.includes("value") && (
            <optgroup label="Manual">
              <option value="value">Specific value</option>
            </optgroup>
          )}
        </select>
        <small id={methodHelpId}>{methodDescription}</small>
      </label>
      {mode === "median" ? (
        <p className="panelNote">
          The median ignores null and NaN cells and keeps the column type. Integer and decimal medians must fit that
          type exactly. If every cell is missing, choose a specific value.
        </p>
      ) : mode === "mean" ? (
        <p className="panelNote">
          Uses the mean of all non-missing values after earlier cleaning steps. Filters in the current view do not
          affect this calculation. If every cell is missing, choose a specific value.
        </p>
      ) : mode === "linearInterpolation" ? (
        <>
          <ColumnReferenceSelect
            name="fillInterpolationCoordinate"
            label="Coordinate column"
            columns={interpolationCoordinates}
            value={interpolationCoordinateId}
            onChange={setInterpolationCoordinateId}
            emptyMessage="No numeric, date, or date-time coordinate is available."
          />
          <TextField
            name="fillInterpolationMaxGap"
            label="Maximum missing cells in a run (optional)"
            defaultValue={
              initialReplacement?.kind === "linearInterpolation" && initialReplacement.maxGap !== undefined
                ? String(initialReplacement.maxGap)
                : ""
            }
            type="number"
            min={1}
            max={maxFillDirectionalGap}
            step={1}
            inputMode="numeric"
            description="Leave this blank to interpolate runs of any length. A longer run stays missing."
          />
          <p className="panelNote">
            Fills a missing run only when finite values exist on both sides. The coordinate must contain unique,
            non-missing numeric, date, or date-time values. Leading and trailing gaps stay missing. Current view filters
            and sorts are ignored, and row order does not change.
          </p>
        </>
      ) : mode === "mostFrequent" ? (
        <p className="panelNote">
          Uses the most common non-missing value in this column after earlier cleaning steps. Filters in the current
          view do not affect this calculation. If there is no non-missing value or several values tie, choose a specific
          value.
        </p>
      ) : mode === "groupedMedian" || mode === "groupedMean" || mode === "groupedMostFrequent" ? (
        <>
          <ColumnReferencesSelect
            name="fillGroupKeys"
            label="Group by"
            columns={groupedKeyColumns}
            defaultValue={initialGroupedKeyIds}
            value={groupedKeyIds}
            onChange={setGroupedKeyIds}
            searchLabel="Search group columns"
          />
          <p className="panelNote">
            Uses data after earlier cleaning steps. Filters and sorts in the current view are ignored, and row order
            stays unchanged. Missing values in a grouping column match other missing values in that column.
            {mode === "groupedMostFrequent"
              ? " A group with no non-missing value or a tie stays missing."
              : " If every target value in a group is missing, those cells stay missing."}
            {mode === "groupedMedian" &&
              (selectedColumn?.type === "integer" || selectedColumn?.type === "decimal") &&
              " Preview fails if a group median cannot fit the column type."}
          </p>
        </>
      ) : mode === "directionalForward" || mode === "directionalBackward" ? (
        <>
          <Fieldset legend="Calculation order">
            {orderRows.map((row, index) => {
              const rowColumns = orderColumns.filter(
                (column) => column.id === row.columnId || !selectedOrderIds.has(column.id)
              );
              return (
                <div className="compoundRow operationInputRow" key={row.key}>
                  <ColumnReferenceSelect
                    name="fillOrderColumn"
                    label={`Order column ${index + 1}`}
                    columns={rowColumns}
                    value={row.columnId}
                    onChange={(columnId) =>
                      setOrderRows((current) =>
                        current.map((candidate) =>
                          candidate.key === row.key &&
                          !current.some((other) => other.key !== row.key && other.columnId === columnId)
                            ? { ...candidate, columnId }
                            : candidate
                        )
                      )
                    }
                  />
                  <label className="formField">
                    <span>Direction</span>
                    <select
                      name="fillOrderDirection"
                      aria-label={`Direction ${index + 1}`}
                      value={row.direction}
                      onChange={(event) =>
                        setOrderRows((current) =>
                          current.map((candidate) =>
                            candidate.key === row.key
                              ? { ...candidate, direction: event.target.value as TransformSortRule["direction"] }
                              : candidate
                          )
                        )
                      }
                    >
                      <option value="asc">Ascending</option>
                      <option value="desc">Descending</option>
                    </select>
                  </label>
                  <label className="formField">
                    <span>Order missing values</span>
                    <select
                      name="fillOrderNulls"
                      aria-label={`Order missing values ${index + 1}`}
                      value={row.nulls}
                      onChange={(event) =>
                        setOrderRows((current) =>
                          current.map((candidate) =>
                            candidate.key === row.key
                              ? { ...candidate, nulls: event.target.value as TransformSortRule["nulls"] }
                              : candidate
                          )
                        )
                      }
                    >
                      <option value="last">Last</option>
                      <option value="first">First</option>
                    </select>
                  </label>
                  <RowActions
                    label={`fill order rule ${index + 1}`}
                    canRemove={orderRows.length > 1}
                    canMoveUp={index > 0}
                    canMoveDown={index < orderRows.length - 1}
                    onRemove={() => setOrderRows((current) => current.filter((candidate) => candidate.key !== row.key))}
                    onMoveUp={() => setOrderRows((current) => moveItem(current, index, index - 1))}
                    onMoveDown={() => setOrderRows((current) => moveItem(current, index, index + 1))}
                  />
                </div>
              );
            })}
            <button
              type="button"
              className="secondaryButton"
              disabled={!nextUnusedOrder}
              onClick={() => {
                if (!nextUnusedOrder) return;
                setOrderRows((current) => [
                  ...current,
                  {
                    key: `fill-order-${nextOrderRowId.current++}`,
                    columnId: nextUnusedOrder.id,
                    direction: "asc",
                    nulls: "last"
                  }
                ]);
              }}
            >
              Add order column
            </button>
            <small>
              Order column 1 has the highest priority. Move rows to change the priority; each column can appear once.
            </small>
          </Fieldset>
          <TextField
            name="fillMaxGap"
            label="Maximum gap length (optional)"
            defaultValue={
              initialReplacement?.kind === "directional" && initialReplacement.maxGap !== undefined
                ? String(initialReplacement.maxGap)
                : ""
            }
            type="number"
            min={1}
            max={maxFillDirectionalGap}
            step={1}
            inputMode="numeric"
            description="Leave this blank to fill runs of any length. If a missing run is longer than the limit, the whole run stays missing."
          />
          <p className="panelNote">
            {mode === "directionalForward"
              ? "Previous value uses the nearest earlier non-missing value in this calculation order. A missing run at the start can stay missing."
              : "Next value uses the nearest later non-missing value in this calculation order. A missing run at the end can stay missing."}
            {
              " Current view filters and sorts do not affect the calculation, and the displayed row order does not change."
            }
          </p>
        </>
      ) : mode === "fallbackColumns" ? (
        <>
          <Fieldset legend="Fallback order">
            {fallbackRows.map((row, index) => {
              const rowColumns = fallbackColumns.filter(
                (column) => column.id === row.columnId || !selectedFallbackIds.has(column.id)
              );
              return (
                <div className="compoundRow fallbackColumnRow" key={row.key}>
                  <ColumnReferenceSelect
                    name="fallbackColumns"
                    label={`Fallback ${index + 1}`}
                    columns={rowColumns}
                    value={row.columnId}
                    onChange={(columnId) =>
                      setFallbackRows((current) =>
                        current.map((candidate) =>
                          candidate.key === row.key &&
                          !current.some((other) => other.key !== row.key && other.columnId === columnId)
                            ? { ...candidate, columnId }
                            : candidate
                        )
                      )
                    }
                  />
                  <RowActions
                    label={`fallback column ${index + 1}`}
                    canRemove={fallbackRows.length > 1}
                    canMoveUp={index > 0}
                    canMoveDown={index < fallbackRows.length - 1}
                    onRemove={() =>
                      setFallbackRows((current) => current.filter((candidate) => candidate.key !== row.key))
                    }
                    onMoveUp={() => setFallbackRows((current) => moveItem(current, index, index - 1))}
                    onMoveDown={() => setFallbackRows((current) => moveItem(current, index, index + 1))}
                  />
                </div>
              );
            })}
            <button
              type="button"
              className="secondaryButton"
              disabled={!nextUnusedFallback || fallbackRows.length >= maxFillFallbackColumns}
              onClick={() => {
                if (!nextUnusedFallback || fallbackRows.length >= maxFillFallbackColumns) return;
                setFallbackRows((current) => [
                  ...current,
                  { key: `fill-fallback-${nextFallbackRowId.current++}`, columnId: nextUnusedFallback.id }
                ]);
              }}
            >
              Add fallback column
            </button>
            <small>Fallback 1 is checked first. Move rows to change the priority; each column can appear once.</small>
          </Fieldset>
          <p className="panelNote">
            For each missing cell, uses the first present value in the same row. Only columns with the same type are
            available. Rows where every fallback is missing stay missing.
            {incompatibleFallbackCount > 0 && " Convert another column's type first if you want to use it here."}
          </p>
        </>
      ) : (
        <>
          {selectedColumn?.type === "unknown" ? (
            <label className="formField">
              <span>Value type</span>
              <select
                name="fillValueKind"
                value={unknownValueKind}
                onChange={(event) => setUnknownValueKind(event.target.value as FillValueKind)}
              >
                {fillValueKindOptions.map(([value, label]) => (
                  <option key={value} value={value}>
                    {label}
                  </option>
                ))}
              </select>
            </label>
          ) : (
            <input type="hidden" name="fillValueKind" value={valueKind} />
          )}
          <FillReplacementInput
            backend={backend}
            kind={valueKind}
            defaultValue={explicitFillValue(initialReplacement)}
          />
          {selectedColumn?.type === "string" && (
            <p className="panelNote">
              {backend === "r"
                ? "Character columns stay character. For factor columns, a new value is added as a level and the factor type is kept."
                : "For categorical columns, a specific value may convert the column to text. Most common value keeps the category type."}
            </p>
          )}
        </>
      )}
    </>
  );
}

function FillReplacementInput({
  backend,
  kind,
  defaultValue
}: {
  backend: SessionMetadata["backend"];
  kind: FillValueKind;
  defaultValue: string;
}) {
  if (kind === "boolean") {
    return (
      <SelectField
        name="fillValue"
        label="Replacement value"
        defaultValue={defaultValue === "true" ? "true" : "false"}
        options={[
          ["false", "False"],
          ["true", "True"]
        ]}
      />
    );
  }
  if (kind === "date") {
    return <TextField name="fillValue" label="Replacement value" type="date" defaultValue={defaultValue} required />;
  }
  const label =
    kind === "string"
      ? "Replacement value"
      : kind === "datetime"
        ? "Replacement value (ISO date and time)"
        : "Replacement number";
  const rTextLimit = backend === "r" && kind === "string" ? 8_192 : undefined;
  return (
    <TextField
      key={kind}
      name="fillValue"
      label={label}
      defaultValue={defaultValue}
      required={kind !== "string"}
      inputMode={kind === "integer" ? "numeric" : kind === "float" || kind === "decimal" ? "decimal" : undefined}
      maxLength={kind === "string" ? (rTextLimit ?? 65_536) : kind === "integer" ? 40 : kind === "decimal" ? 128 : 64}
      maxUtf8Bytes={rTextLimit}
      normalizeOnBlur={
        kind === "integer" || kind === "float" || kind === "decimal"
          ? (value) => normalizeFillNumericValue(kind, value)
          : undefined
      }
    />
  );
}
