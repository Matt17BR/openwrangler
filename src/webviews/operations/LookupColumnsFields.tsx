import { useEffect, useEffectEvent, useRef, useState } from "react";
import {
  LOOKUP_KEY_TYPES,
  LOOKUP_OUTPUT_TYPES,
  MAX_LOOKUP_KEYS,
  MAX_LOOKUP_OUTPUTS,
  type LookupFileState
} from "../../shared/lookupColumns";
import { portablePivotLongerNameKey } from "../../shared/pivotLonger";
import type { ColumnSchema, ColumnType, LookupColumnsParams, LookupFileColumn } from "../../shared/protocol";
import { compatibleColumns } from "./operationFieldCompatibility";
import { ColumnReferenceSelect, Fieldset, moveItem, RowActions } from "./operationFormControls";
import { requestLookupFile, subscribeLookupFileState } from "./lookupFileChannel";

type DescribedLookupFile = Extract<LookupFileState, { status: "described" }>;

interface KeyRow {
  rowId: string;
  columnId: string;
  lookupColumn: string;
}

interface OutputRow {
  rowId: string;
  lookupColumn: string;
  newColumn: string;
  suggested: boolean;
}

export function LookupColumnsFields({ columns, initial }: { columns: ColumnSchema[]; initial?: LookupColumnsParams }) {
  const keyColumns = compatibleColumns(columns, LOOKUP_KEY_TYPES);
  const [described, setDescribed] = useState<DescribedLookupFile>();
  const [pending, setPending] = useState<"choosing" | "reading" | undefined>(initial ? "reading" : undefined);
  const [error, setError] = useState<string>();
  const [keys, setKeys] = useState<KeyRow[]>([]);
  const [outputs, setOutputs] = useState<OutputRow[]>([]);
  const requestId = useRef<string | undefined>(undefined);
  const restoreInitial = useRef(initial);
  const nextRowId = useRef(0);
  const rowId = (prefix: string) => `${prefix}-${nextRowId.current++}`;

  const settle = useEffectEvent((id: string, state: LookupFileState) => {
    if (id !== requestId.current) return;
    requestId.current = undefined;
    setPending(undefined);
    if (state.status === "cancelled") return;
    if (state.status === "failed") {
      setError(state.message);
      return;
    }
    setError(undefined);
    setDescribed(state);
    const saved = restoreInitial.current;
    restoreInitial.current = undefined;
    if (saved && saved.file.path === state.file.path && saved.file.format === state.file.format) {
      setKeys(
        saved.keys.map((key) => ({
          rowId: rowId("lookup-key"),
          columnId: key.column.id,
          lookupColumn: key.lookupColumn
        }))
      );
      setOutputs(
        saved.columns.map((output) => ({
          rowId: rowId("lookup-output"),
          lookupColumn: output.lookupColumn,
          newColumn: output.newColumn,
          suggested: false
        }))
      );
      return;
    }
    const key = defaultKey(keyColumns, state.columns);
    setKeys([{ rowId: rowId("lookup-key"), ...key }]);
    setOutputs(
      defaultOutputs(state.columns, key.lookupColumn, columns).map((output) => ({
        rowId: rowId("lookup-output"),
        ...output
      }))
    );
  });

  useEffect(() => {
    const unsubscribe = subscribeLookupFileState(settle);
    const saved = restoreInitial.current;
    if (saved) requestId.current = requestLookupFile(saved.file);
    return unsubscribe;
  }, []);

  const choose = () => {
    setError(undefined);
    setPending("choosing");
    requestId.current = requestLookupFile();
  };

  const lookupColumns = described?.columns ?? [];
  const outputColumns = lookupColumns.filter((column) => LOOKUP_OUTPUT_TYPES.has(column.type));
  const existingNames = new Set(columns.map((column) => portablePivotLongerNameKey(column.name)));
  const status =
    pending === "choosing"
      ? "Choose a file in the dialog."
      : pending === "reading"
        ? "Reading the lookup file's columns…"
        : undefined;

  return (
    <>
      <input type="hidden" name="lookupFilePath" value={described?.file.path ?? ""} />
      <input type="hidden" name="lookupFileFormat" value={described?.file.format ?? ""} />
      <div className="formField">
        <span>Lookup file</span>
        <div className="compoundRow">
          <strong className="lookupFileName" title={described?.file.path}>
            {described ? fileName(described.file.path) : "No file chosen"}
          </strong>
          <button type="button" className="secondaryButton" disabled={pending !== undefined} onClick={choose}>
            {described ? "Choose another file" : "Choose file"}
          </button>
        </div>
        <small role="status" aria-live="polite">
          {status ??
            (described
              ? `${described.rowCount.toLocaleString()} ${described.rowCount === 1 ? "row" : "rows"} in ${described.file.path}`
              : "CSV, TSV, Parquet or JSON Lines. CSV and TSV files need a header row.")}
        </small>
      </div>
      {error && (
        <p className="operationFormError" role="alert">
          {error}
        </p>
      )}
      {described && (
        <>
          <p className="panelNote">
            Each row gets the values from the lookup row with the same keys. Rows without a match get missing values,
            and a key that appears more than once in the lookup file stops the step.
          </p>
          <Fieldset legend="Match keys">
            {keys.map((key, index) => {
              const columnType = keyColumns.find((column) => column.id === key.columnId)?.type;
              const candidates = lookupColumns.filter((column) => column.type === columnType);
              return (
                <div className="compoundRow operationInputRow" key={key.rowId}>
                  <ColumnReferenceSelect
                    name="lookupKeyColumn"
                    label={`Key ${index + 1}`}
                    columns={keyColumns}
                    value={key.columnId}
                    onChange={(columnId) => {
                      const nextType = keyColumns.find((column) => column.id === columnId)?.type;
                      setKeys((current) =>
                        current.map((row) =>
                          row.rowId === key.rowId
                            ? {
                                ...row,
                                columnId,
                                lookupColumn: matchingLookupColumn(columnId, nextType, row, keyColumns, lookupColumns)
                              }
                            : row
                        )
                      );
                    }}
                    emptyMessage="No text, integer, Boolean or date column is available to match on."
                  />
                  <LookupColumnSelect
                    name="lookupKeyLookupColumn"
                    label={`Lookup key ${index + 1}`}
                    columns={candidates}
                    value={key.lookupColumn}
                    emptyMessage={
                      columnType
                        ? `The lookup file has no ${typeLabel(columnType)} column.`
                        : "Choose a key column first."
                    }
                    onChange={(lookupColumn) =>
                      setKeys((current) =>
                        current.map((row) => (row.rowId === key.rowId ? { ...row, lookupColumn } : row))
                      )
                    }
                  />
                  <RowActions
                    label={`key ${index + 1}`}
                    canRemove={keys.length > 1}
                    canMoveUp={index > 0}
                    canMoveDown={index < keys.length - 1}
                    onRemove={() => setKeys((current) => current.filter((row) => row.rowId !== key.rowId))}
                    onMoveUp={() => setKeys((current) => moveItem(current, index, index - 1))}
                    onMoveDown={() => setKeys((current) => moveItem(current, index, index + 1))}
                  />
                </div>
              );
            })}
            <button
              type="button"
              className="secondaryButton"
              disabled={keys.length >= MAX_LOOKUP_KEYS}
              onClick={() => {
                const used = new Set(keys.map((key) => key.columnId));
                const column = keyColumns.find((candidate) => !used.has(candidate.id)) ?? keyColumns[0];
                setKeys((current) => [
                  ...current,
                  {
                    rowId: rowId("lookup-key"),
                    columnId: column?.id ?? "",
                    lookupColumn: column
                      ? matchingLookupColumn(column.id, column.type, undefined, keyColumns, lookupColumns)
                      : ""
                  }
                ]);
              }}
            >
              Add key
            </button>
          </Fieldset>
          <Fieldset legend="Columns to add">
            {outputs.map((output, index) => (
              <div className="compoundRow operationInputRow" key={output.rowId}>
                <LookupColumnSelect
                  name="lookupOutputColumn"
                  label={`Lookup column ${index + 1}`}
                  columns={outputColumns}
                  value={output.lookupColumn}
                  emptyMessage="The lookup file has no column that can be added."
                  onChange={(lookupColumn) =>
                    setOutputs((current) =>
                      current.map((row) =>
                        row.rowId === output.rowId
                          ? {
                              ...row,
                              lookupColumn,
                              ...(row.suggested ? { newColumn: suggestedName(lookupColumn, existingNames) } : {})
                            }
                          : row
                      )
                    )
                  }
                />
                <label className="formField">
                  <span>New column {index + 1}</span>
                  <input
                    aria-label={`New column ${index + 1}`}
                    name="lookupOutputName"
                    value={output.newColumn}
                    required
                    onChange={(event) => {
                      const newColumn = event.target.value;
                      setOutputs((current) =>
                        current.map((row) =>
                          row.rowId === output.rowId ? { ...row, newColumn, suggested: false } : row
                        )
                      );
                    }}
                  />
                </label>
                <RowActions
                  label={`added column ${index + 1}`}
                  canRemove={outputs.length > 1}
                  canMoveUp={index > 0}
                  canMoveDown={index < outputs.length - 1}
                  onRemove={() => setOutputs((current) => current.filter((row) => row.rowId !== output.rowId))}
                  onMoveUp={() => setOutputs((current) => moveItem(current, index, index - 1))}
                  onMoveDown={() => setOutputs((current) => moveItem(current, index, index + 1))}
                />
              </div>
            ))}
            <button
              type="button"
              className="secondaryButton"
              disabled={outputs.length >= MAX_LOOKUP_OUTPUTS || outputColumns.length === 0}
              onClick={() => {
                const used = new Set(outputs.map((output) => output.lookupColumn));
                const column = outputColumns.find((candidate) => !used.has(candidate.name)) ?? outputColumns[0]!;
                setOutputs((current) => [
                  ...current,
                  {
                    rowId: rowId("lookup-output"),
                    lookupColumn: column.name,
                    newColumn: suggestedName(column.name, existingNames),
                    suggested: true
                  }
                ]);
              }}
            >
              Add column
            </button>
          </Fieldset>
        </>
      )}
    </>
  );
}

function LookupColumnSelect({
  name,
  label,
  columns,
  value,
  emptyMessage,
  onChange
}: {
  name: string;
  label: string;
  columns: LookupFileColumn[];
  value: string;
  emptyMessage: string;
  onChange(value: string): void;
}) {
  const available = columns.some((column) => column.name === value);
  return (
    <label className="formField">
      <span>{label}</span>
      <select
        aria-label={label}
        name={name}
        value={available ? value : ""}
        required
        disabled={columns.length === 0}
        onChange={(event) => onChange(event.target.value)}
      >
        {!available && (
          <option value="">
            {columns.length === 0
              ? "No compatible columns"
              : value
                ? "Saved column is not in this file"
                : "Choose a column"}
          </option>
        )}
        {columns.map((column) => (
          <option key={column.name} value={column.name}>
            {column.name} ({column.rawType})
          </option>
        ))}
      </select>
      {columns.length === 0 && <small className="operationCompatibilityNote">{emptyMessage}</small>}
    </label>
  );
}

function defaultKey(keyColumns: ColumnSchema[], lookupColumns: LookupFileColumn[]): Omit<KeyRow, "rowId"> {
  for (const column of keyColumns) {
    const name = portablePivotLongerNameKey(column.name);
    const match = lookupColumns.find(
      (candidate) => candidate.type === column.type && portablePivotLongerNameKey(candidate.name) === name
    );
    if (match) return { columnId: column.id, lookupColumn: match.name };
  }
  for (const column of keyColumns) {
    const match = lookupColumns.find((candidate) => candidate.type === column.type);
    if (match) return { columnId: column.id, lookupColumn: match.name };
  }
  return { columnId: keyColumns[0]?.id ?? "", lookupColumn: "" };
}

function defaultOutputs(
  lookupColumns: LookupFileColumn[],
  keyLookupColumn: string,
  columns: ColumnSchema[]
): Omit<OutputRow, "rowId">[] {
  const existing = new Set(columns.map((column) => portablePivotLongerNameKey(column.name)));
  const copyable = lookupColumns.filter((column) => LOOKUP_OUTPUT_TYPES.has(column.type));
  const values = copyable.filter((column) => column.name !== keyLookupColumn);
  return (values.length > 0 ? values : copyable).slice(0, MAX_LOOKUP_OUTPUTS).map((column) => {
    const newColumn = suggestedName(column.name, existing);
    existing.add(portablePivotLongerNameKey(newColumn));
    return { lookupColumn: column.name, newColumn, suggested: true };
  });
}

function matchingLookupColumn(
  columnId: string,
  columnType: ColumnType | undefined,
  row: KeyRow | undefined,
  keyColumns: ColumnSchema[],
  lookupColumns: LookupFileColumn[]
): string {
  const candidates = lookupColumns.filter((column) => column.type === columnType);
  if (row && candidates.some((column) => column.name === row.lookupColumn)) return row.lookupColumn;
  const name = keyColumns.find((column) => column.id === columnId)?.name;
  const folded = name === undefined ? undefined : portablePivotLongerNameKey(name);
  return (
    candidates.find((column) => portablePivotLongerNameKey(column.name) === folded)?.name ?? candidates[0]?.name ?? ""
  );
}

/** The lookup column's own name, or a numbered `_lookup` name when the data already has that column. */
function suggestedName(lookupColumn: string, existing: ReadonlySet<string>): string {
  if (!existing.has(portablePivotLongerNameKey(lookupColumn))) return lookupColumn;
  for (let suffix = 1; ; suffix += 1) {
    const candidate = suffix === 1 ? `${lookupColumn}_lookup` : `${lookupColumn}_lookup_${suffix}`;
    if (!existing.has(portablePivotLongerNameKey(candidate))) return candidate;
  }
}

function typeLabel(type: ColumnType): string {
  return type === "string" ? "text" : type === "boolean" ? "Boolean" : type;
}

function fileName(path: string): string {
  return path.split(/[\\/]/u).pop() || path;
}
