import { useId, useMemo, useState } from "react";
import type { ReactNode } from "react";
import type { ColumnSchema } from "../../shared/protocol";

export function Fieldset({ legend, children }: { legend: string; children: ReactNode }) {
  return (
    <fieldset className="formFieldset">
      <legend>{legend}</legend>
      {children}
    </fieldset>
  );
}

export function moveItem<T>(items: readonly T[], from: number, to: number): T[] {
  if (from < 0 || from >= items.length || to < 0 || to >= items.length || from === to) return [...items];
  const result = [...items];
  const [item] = result.splice(from, 1);
  result.splice(to, 0, item);
  return result;
}

export function RowActions({
  label,
  canRemove,
  canMoveUp,
  canMoveDown,
  onRemove,
  onMoveUp,
  onMoveDown
}: {
  label: string;
  canRemove: boolean;
  canMoveUp: boolean;
  canMoveDown: boolean;
  onRemove(): void;
  onMoveUp(): void;
  onMoveDown(): void;
}) {
  return (
    <div className="operationRowActions" role="group" aria-label={`Actions for ${label}`}>
      <button
        type="button"
        className="iconButton codicon codicon-arrow-up"
        aria-label={`Move ${label} up`}
        title="Move up"
        disabled={!canMoveUp}
        onClick={onMoveUp}
      />
      <button
        type="button"
        className="iconButton codicon codicon-arrow-down"
        aria-label={`Move ${label} down`}
        title="Move down"
        disabled={!canMoveDown}
        onClick={onMoveDown}
      />
      <button
        type="button"
        className="operationRemoveButton"
        aria-label={`Remove ${label}`}
        disabled={!canRemove}
        title={canRemove ? `Remove ${label}` : "At least one row is required"}
        onClick={onRemove}
      >
        <span className="codicon codicon-trash" aria-hidden="true" />
        <span>Remove</span>
      </button>
    </div>
  );
}

export function ColumnReferenceSelect({
  name,
  label,
  columns,
  defaultValue,
  value,
  onChange,
  emptyMessage
}: {
  name: string;
  label: string;
  columns: ColumnSchema[];
  defaultValue?: string;
  value?: string;
  onChange?(value: string): void;
  emptyMessage?: string;
}) {
  const fallbackValue =
    defaultValue && columns.some((column) => column.id === defaultValue) ? defaultValue : columns[0]?.id;
  const controlled = value !== undefined;
  const optionLabels = useMemo(() => columnOptionLabels(columns), [columns]);
  return (
    <label className="formField">
      <span>{label}</span>
      <select
        aria-label={label}
        name={name}
        {...(controlled ? { value } : { defaultValue: fallbackValue })}
        required
        disabled={columns.length === 0}
        onChange={onChange ? (event) => onChange(event.target.value) : undefined}
      >
        {columns.length === 0 && <option value="">No compatible columns</option>}
        {columns.map((column) => (
          <option key={column.id} value={column.id}>
            {optionLabels.get(column.id)}
          </option>
        ))}
      </select>
      {columns.length === 0 && <small className="operationCompatibilityNote">{emptyMessage}</small>}
    </label>
  );
}

export function ColumnReferencesSelect({
  name,
  label,
  columns,
  defaultValue,
  required = true,
  preserveSelectionOrder = false,
  searchLabel,
  value,
  onChange
}: {
  name: string;
  label: string;
  columns: ColumnSchema[];
  defaultValue: string[];
  required?: boolean;
  preserveSelectionOrder?: boolean;
  searchLabel?: string;
  value?: string[];
  onChange?(value: string[]): void;
}) {
  const selectId = useId();
  const helpId = `${selectId}-help`;
  const orderId = `${selectId}-order`;
  const selectionId = `${selectId}-selection`;
  const validColumnIds = new Set(columns.map((column) => column.id));
  const optionLabels = useMemo(() => columnOptionLabels(columns), [columns]);
  const [searchQuery, setSearchQuery] = useState("");
  const [internalSelectedIds, setInternalSelectedIds] = useState(defaultValue.filter((id) => validColumnIds.has(id)));
  const selectedIds = (value ?? internalSelectedIds).filter((id) => validColumnIds.has(id));
  const updateSelectedIds = (next: string[]) => {
    if (onChange) onChange(next);
    else setInternalSelectedIds(next);
  };
  const selectedLabels = selectedIds.map((id) => optionLabels.get(id) ?? id);
  const selectedSummary =
    selectedLabels.length <= 5
      ? selectedLabels.join(", ")
      : `${selectedLabels.slice(0, 5).join(", ")}, and ${selectedLabels.length - 5} more`;
  const normalizedQuery = searchQuery.trim().toLowerCase();
  const visibleColumns =
    normalizedQuery === ""
      ? columns
      : columns.filter((column) =>
          (optionLabels.get(column.id) ?? column.name).toLowerCase().includes(normalizedQuery)
        );
  return (
    <fieldset
      className="columnSelectionField"
      aria-describedby={
        selectedLabels.length === 0
          ? helpId
          : preserveSelectionOrder
            ? `${helpId} ${orderId}`
            : searchLabel
              ? `${helpId} ${selectionId}`
              : helpId
      }
    >
      <legend>{label}</legend>
      {selectedIds.map((id) => (
        <input key={id} type="hidden" name={name} value={id} />
      ))}
      {searchLabel && columns.length > 1 && (
        <label className="formField columnSelectionSearch">
          <span>{searchLabel}</span>
          <input
            type="search"
            value={searchQuery}
            onChange={(event) => setSearchQuery(event.target.value)}
            aria-controls={selectId}
            placeholder="Type a column name"
            autoComplete="off"
          />
        </label>
      )}
      <div className="columnChecklist" id={selectId}>
        {visibleColumns.map((column) => (
          <label className="columnChecklistItem" key={column.id}>
            <input
              type="checkbox"
              value={column.id}
              checked={selectedIds.includes(column.id)}
              onChange={(event) => {
                const checked = event.currentTarget.checked;
                const next = (() => {
                  const current = selectedIds;
                  if (!checked) return current.filter((id) => id !== column.id);
                  if (current.includes(column.id)) return current;
                  if (preserveSelectionOrder) return [...current, column.id];
                  const selected = new Set([...current, column.id]);
                  return columns.filter((candidate) => selected.has(candidate.id)).map((candidate) => candidate.id);
                })();
                updateSelectedIds(next);
              }}
            />
            <span>{optionLabels.get(column.id)}</span>
          </label>
        ))}
        {columns.length === 0 && <span className="mutedText">No compatible columns are available.</span>}
        {columns.length > 0 && visibleColumns.length === 0 && <span className="mutedText">No matching columns.</span>}
      </div>
      <small id={helpId}>
        {required ? "Select at least one column. " : ""}
        {preserveSelectionOrder
          ? "Check columns in the order you want to use them. Uncheck any column to remove it."
          : "Check each column you want to include. No keyboard modifier is required."}
      </small>
      {preserveSelectionOrder && selectedLabels.length > 0 && (
        <small id={orderId} aria-live="polite">
          Selected order: {selectedLabels.join(" → ")}
        </small>
      )}
      {!preserveSelectionOrder && searchLabel && selectedLabels.length > 0 && (
        <small id={selectionId} aria-live="polite">
          Selected ({selectedLabels.length}): {selectedSummary}
        </small>
      )}
    </fieldset>
  );
}

function columnOptionLabels(columns: readonly ColumnSchema[]): ReadonlyMap<string, string> {
  const nameCounts = new Map<string, number>();
  for (const column of columns) nameCounts.set(column.name, (nameCounts.get(column.name) ?? 0) + 1);

  const labels = new Map<string, string>();
  const occupiedLabels = new Set<string>();

  // Preserve every ordinary unique source name exactly. Positional labels are
  // then fitted around those names instead of making the common case verbose.
  for (const column of columns) {
    if (column.name === "" || nameCounts.get(column.name) !== 1) continue;
    labels.set(column.id, column.name);
    occupiedLabels.add(column.name);
  }

  for (const column of columns) {
    if (labels.has(column.id)) continue;
    const displayName = column.name === "" ? "(empty name)" : column.name;
    const humanPosition = column.position + 1;
    let label = `${displayName}, column ${humanPosition}`;
    if (occupiedLabels.has(label)) {
      const alternate = `${displayName}, source column ${humanPosition}`;
      label = alternate;
      let disambiguator = 2;
      while (occupiedLabels.has(label)) {
        label = `${alternate} (${disambiguator})`;
        disambiguator += 1;
      }
    }
    labels.set(column.id, label);
    occupiedLabels.add(label);
  }
  return labels;
}

export function SelectField({
  name,
  label,
  defaultValue,
  options
}: {
  name: string;
  label: string;
  defaultValue: string;
  options: (readonly [string, string])[];
}) {
  return (
    <label className="formField">
      <span>{label}</span>
      <select aria-label={label} name={name} defaultValue={defaultValue}>
        {options.map(([value, title]) => (
          <option key={value} value={value}>
            {title}
          </option>
        ))}
      </select>
    </label>
  );
}

export function TextField({
  name,
  label,
  defaultValue,
  required = false,
  type = "text",
  min,
  max,
  step,
  inputMode,
  maxLength,
  maxUtf8Bytes,
  description,
  normalizeOnBlur
}: {
  name: string;
  label: string;
  defaultValue: string;
  required?: boolean;
  type?: string;
  min?: number;
  max?: number;
  step?: number | "any";
  inputMode?: "numeric" | "decimal";
  maxLength?: number;
  maxUtf8Bytes?: number;
  description?: ReactNode;
  normalizeOnBlur?: (value: string) => string;
}) {
  const helpId = useId();
  const validateByteLength = (input: HTMLInputElement) => {
    if (maxUtf8Bytes === undefined) return;
    const byteLength = new TextEncoder().encode(input.value).byteLength;
    input.setCustomValidity(
      byteLength > maxUtf8Bytes ? `Use at most ${maxUtf8Bytes.toLocaleString()} UTF-8 bytes.` : ""
    );
  };
  return (
    <label className="formField">
      <span>{label}</span>
      <input
        aria-label={label}
        name={name}
        type={type}
        min={min}
        max={max}
        step={step}
        inputMode={inputMode}
        maxLength={maxLength}
        defaultValue={defaultValue}
        required={required}
        aria-describedby={maxUtf8Bytes === undefined && description === undefined ? undefined : helpId}
        onInput={(event) => validateByteLength(event.currentTarget)}
        onBlur={
          normalizeOnBlur || maxUtf8Bytes !== undefined
            ? (event) => {
                if (normalizeOnBlur) event.currentTarget.value = normalizeOnBlur(event.currentTarget.value);
                validateByteLength(event.currentTarget);
              }
            : undefined
        }
      />
      {(description !== undefined || maxUtf8Bytes !== undefined) && (
        <small id={helpId}>
          {description ?? `R text replacements can use up to ${maxUtf8Bytes?.toLocaleString()} UTF-8 bytes.`}
        </small>
      )}
    </label>
  );
}
