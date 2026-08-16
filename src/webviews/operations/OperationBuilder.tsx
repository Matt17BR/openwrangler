import { useEffect, useMemo, useRef, useState } from "react";
import type { FormEvent, KeyboardEvent as ReactKeyboardEvent } from "react";
import type { FilterModel } from "../../shared/filterModel";
import { hasActiveViewQuery, isActiveColumnFilter } from "../../shared/filterModel";
import type { ColumnSchema, ColumnType, OperationKind, SessionMetadata, TransformStep } from "../../shared/protocol";
import {
  operationGroups,
  operationByKind,
  supportedOperationCatalog,
  supportsOperation
} from "../../shared/operations";
import { isTransformStep } from "../../shared/protocolValidation";
import { FillMissingFields } from "./FillMissingFields";
import {
  ColumnReferenceSelect,
  ColumnReferencesSelect,
  Fieldset,
  moveItem,
  RowActions,
  SelectField,
  TextField
} from "./operationFormControls";
import { buildParams, columnReferenceId } from "./operationParams";
import { savedStepEditError } from "./savedStepEditValidation";

interface OperationBuilderProps {
  metadata: SessionMetadata;
  filterModel: FilterModel;
  initialKind?: OperationKind;
  initialStep?: TransformStep;
  busy?: boolean;
  onClose(): void;
  onPreview(step: TransformStep, replaceStepId?: string): void;
}

const formulaOperators = ["add", "subtract", "multiply", "divide", "modulo", "power"] as const;
const aggregationOperations = ["sum", "mean", "min", "max", "median", "count", "nUnique", "first", "last"];
const numericColumnTypes: ReadonlySet<ColumnType> = new Set(["integer", "float", "decimal"]);
const textColumnTypes: ReadonlySet<ColumnType> = new Set(["string"]);
const datetimeColumnTypes: ReadonlySet<ColumnType> = new Set(["date", "datetime"]);
const portableScalarColumnTypes: ReadonlySet<ColumnType> = new Set([
  "string",
  "integer",
  "float",
  "decimal",
  "boolean",
  "datetime",
  "date",
  "duration",
  "binary"
]);
const orderedAggregationColumnTypes: ReadonlySet<ColumnType> = new Set([
  "string",
  "integer",
  "float",
  "decimal",
  "boolean",
  "datetime",
  "date",
  "duration"
]);
const dialogFocusableSelector = [
  "button:not(:disabled)",
  "input:not(:disabled):not([type='hidden'])",
  "select:not(:disabled)",
  "textarea:not(:disabled)",
  "a[href]",
  "[tabindex]:not([tabindex='-1'])"
].join(",");

function trapDialogFocus(event: ReactKeyboardEvent<HTMLElement>): void {
  if (event.key !== "Tab") return;
  const dialog = event.currentTarget;
  const focusable = Array.from(dialog.querySelectorAll<HTMLElement>(dialogFocusableSelector))
    .filter((element) => element.getAttribute("aria-hidden") !== "true")
    .sort((left, right) =>
      left.compareDocumentPosition(right) & Node.DOCUMENT_POSITION_FOLLOWING ? -1 : left === right ? 0 : 1
    );
  if (focusable.length === 0) {
    event.preventDefault();
    dialog.focus();
    return;
  }

  const first = focusable[0];
  const last = focusable.at(-1) ?? first;
  const active = document.activeElement;
  if (event.shiftKey && (active === first || active === dialog || !dialog.contains(active))) {
    event.preventDefault();
    last.focus();
  } else if (!event.shiftKey && (active === last || active === dialog || !dialog.contains(active))) {
    event.preventDefault();
    first.focus();
  }
}

export function OperationBuilder({
  metadata,
  filterModel,
  initialKind,
  initialStep,
  busy = false,
  onClose,
  onPreview
}: OperationBuilderProps) {
  const requestedInitialKind = initialKind ?? initialStep?.kind;
  const [selectedKind, setSelectedKind] = useState<OperationKind | undefined>(() =>
    requestedInitialKind && supportsOperation(metadata.capabilities, requestedInitialKind)
      ? requestedInitialKind
      : undefined
  );
  const [search, setSearch] = useState("");
  const [formError, setFormError] = useState<string>();
  const dialogRef = useRef<HTMLElement | null>(null);
  const availableCatalog = useMemo(() => supportedOperationCatalog(metadata.capabilities), [metadata.capabilities]);
  const filteredCatalog = useMemo(() => {
    const query = search.trim().toLowerCase();
    return query
      ? availableCatalog.filter(
          (operation) =>
            operation.title.toLowerCase().includes(query) || operation.description.toLowerCase().includes(query)
        )
      : availableCatalog;
  }, [availableCatalog, search]);
  const activeInitial = initialStep?.kind === selectedKind ? initialStep : undefined;
  const availableColumns = initialStep ? (metadata.latestStepInputSchema ?? []) : metadata.schema;
  const editPreflightError = initialStep ? savedStepEditError(initialStep, metadata.latestStepInputSchema) : undefined;
  const savedFilterModel = activeInitial?.kind === "filterRows" ? activeInitial.params.filterModel : undefined;
  const selectedFilterQueryIsEmpty =
    selectedKind === "filterRows" &&
    (savedFilterModel ? !hasActiveViewQuery(savedFilterModel) : !hasActiveViewQuery(filterModel));

  useEffect(() => {
    if (!busy) return;
    if (!document.hasFocus()) return;
    const dialog = dialogRef.current;
    const active = document.activeElement;
    if (!dialog || (active instanceof HTMLElement && dialog.contains(active) && !active.matches(":disabled"))) return;
    dialog?.focus();
  }, [busy]);

  const submit = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (busy || !selectedKind || editPreflightError || !supportsOperation(metadata.capabilities, selectedKind)) return;
    try {
      const form = new FormData(event.currentTarget);
      const params = buildParams(selectedKind, form, filterModel, availableColumns, savedFilterModel);
      const step = {
        id: initialStep?.id ?? `${selectedKind}-${Date.now().toString(36)}`,
        kind: selectedKind,
        params
      };
      if (!isTransformStep(step)) {
        throw new Error("The operation contains invalid or incomplete parameters.");
      }
      setFormError(undefined);
      onPreview(step, initialStep?.id);
    } catch (error) {
      setFormError(error instanceof Error ? error.message : String(error));
    }
  };

  return (
    <div
      className="operationDialogBackdrop"
      role="presentation"
      onMouseDown={(event) => !busy && event.target === event.currentTarget && onClose()}
    >
      <section
        ref={dialogRef}
        className="operationDialog"
        role="dialog"
        aria-modal="true"
        aria-labelledby="operation-dialog-title"
        aria-busy={busy}
        tabIndex={-1}
        onKeyDown={trapDialogFocus}
      >
        <header className="operationDialogHeader">
          <div>
            <strong id="operation-dialog-title">{initialStep ? "Edit cleaning step" : "Add cleaning step"}</strong>
            <span role="status" aria-live="polite">
              {busy ? "Previewing changes…" : "Every step is previewed before it changes the cleaning plan."}
            </span>
          </div>
          <button
            type="button"
            className="iconButton codicon codicon-close"
            aria-label="Close operation picker"
            disabled={busy}
            onClick={onClose}
          />
        </header>
        <fieldset className="operationDialogBody" disabled={busy}>
          <nav className="operationCatalog" aria-label="Operation catalog">
            <label className="operationSearch">
              <span className="codicon codicon-search" aria-hidden="true" />
              <input
                value={search}
                onChange={(event) => setSearch(event.target.value)}
                placeholder="Search operations"
                autoFocus
              />
            </label>
            {operationGroups.map((group) => {
              const operations = filteredCatalog.filter((operation) => operation.group === group);
              if (!operations.length) return null;
              return (
                <section key={group} className="operationGroup">
                  <h3>{group}</h3>
                  {operations.map((operation) => (
                    <button
                      type="button"
                      key={operation.kind}
                      className={`operationChoice${selectedKind === operation.kind ? " selected" : ""}`}
                      aria-pressed={selectedKind === operation.kind}
                      onClick={() => setSelectedKind(operation.kind)}
                    >
                      <span className={`codicon codicon-${operation.icon}`} aria-hidden="true" />
                      <span>
                        <strong>{operation.title}</strong>
                        <small>{operation.description}</small>
                      </span>
                    </button>
                  ))}
                </section>
              );
            })}
            {filteredCatalog.length === 0 && <p className="mutedText">No operations match “{search}”.</p>}
          </nav>
          <form className="operationForm" key={selectedKind ?? "none"} onSubmit={submit}>
            {selectedKind ? (
              <>
                <div className="operationFormTitle">
                  <span className={`codicon codicon-${operationByKind(selectedKind).icon}`} aria-hidden="true" />
                  <div>
                    <h2>{operationByKind(selectedKind).title}</h2>
                    <p>{operationByKind(selectedKind).description}</p>
                  </div>
                </div>
                {editPreflightError ? (
                  <p className="operationFormError" role="alert">
                    {editPreflightError}
                  </p>
                ) : (
                  <>
                    <OperationFields
                      kind={selectedKind}
                      metadata={metadata}
                      columns={availableColumns}
                      filterModel={filterModel}
                      initialStep={activeInitial}
                    />
                    {formError && (
                      <p className="operationFormError" role="alert">
                        {formError}
                      </p>
                    )}
                  </>
                )}
                <footer className="operationFormActions">
                  <button type="button" className="secondaryButton" onClick={onClose}>
                    Cancel
                  </button>
                  <button type="submit" disabled={editPreflightError !== undefined || selectedFilterQueryIsEmpty}>
                    Preview changes
                  </button>
                </footer>
              </>
            ) : (
              <div className="operationPrompt">
                <span className="codicon codicon-wand" aria-hidden="true" />
                <h2>Choose an operation</h2>
                <p>Search or browse the catalog. Your source dataframe remains unchanged.</p>
              </div>
            )}
          </form>
        </fieldset>
      </section>
    </div>
  );
}

interface OperationFieldsProps {
  kind: OperationKind;
  metadata: SessionMetadata;
  columns: ColumnSchema[];
  filterModel: FilterModel;
  initialStep?: TransformStep;
}

function OperationFields({ kind, metadata, columns, filterModel, initialStep }: OperationFieldsProps) {
  const params = initialStep?.params ?? {};
  const initialSortRules = Array.isArray(params.rules) ? (params.rules as Record<string, unknown>[]) : [];
  const initialAggregations = Array.isArray(params.aggregations)
    ? (params.aggregations as Record<string, unknown>[])
    : [];
  const nextSortRowId = useRef(Math.max(1, initialSortRules.length));
  const nextAggregationRowId = useRef(Math.max(1, initialAggregations.length));
  const [sortRowIds, setSortRowIds] = useState(() =>
    Array.from({ length: Math.max(1, initialSortRules.length) }, (_, index) => `sort-${index}`)
  );
  const [aggregationRowIds, setAggregationRowIds] = useState(() =>
    Array.from({ length: Math.max(1, initialAggregations.length) }, (_, index) => `aggregation-${index}`)
  );
  const [formulaOperandMode, setFormulaOperandMode] = useState(params.rightColumn ? "column" : "value");
  const [multiLabelPrefixMode, setMultiLabelPrefixMode] = useState(
    Object.prototype.hasOwnProperty.call(params, "prefix") ? "custom" : "default"
  );
  const param = (name: string, fallback = "") => String(params[name] ?? fallback);
  const initialColumnReference = (name: string, fallback = columns[0]?.id ?? "") =>
    columnReferenceId(params[name]) ?? fallback;
  const initialColumnReferences = (name: string) =>
    Array.isArray(params[name]) ? params[name].map(columnReferenceId).filter(isDefined) : [];

  if (kind === "sortRows") {
    const rulesById = new Map<string, Record<string, unknown>>(
      initialSortRules.map((rule, index) => [`sort-${index}`, rule])
    );
    return (
      <Fieldset legend="Sort rules">
        {sortRowIds.map((rowId, index) => {
          const rule = rulesById.get(rowId);
          return (
            <div className="compoundRow operationInputRow" key={rowId}>
              <ColumnReferenceSelect
                name="sortColumn"
                label={`Column ${index + 1}`}
                columns={columns}
                defaultValue={columnReferenceId(rule?.column) ?? columns[0]?.id}
              />
              <SelectField
                name="sortDirection"
                label="Direction"
                defaultValue={String(rule?.direction ?? "asc")}
                options={[
                  ["asc", "Ascending"],
                  ["desc", "Descending"]
                ]}
              />
              <SelectField
                name="sortNulls"
                label="Missing"
                defaultValue={String(rule?.nulls ?? "last")}
                options={[
                  ["last", "Last"],
                  ["first", "First"]
                ]}
              />
              <RowActions
                label={`sort rule ${index + 1}`}
                canRemove={sortRowIds.length > 1}
                canMoveUp={index > 0}
                canMoveDown={index < sortRowIds.length - 1}
                onRemove={() => setSortRowIds((current) => current.filter((candidate) => candidate !== rowId))}
                onMoveUp={() => setSortRowIds((current) => moveItem(current, index, index - 1))}
                onMoveDown={() => setSortRowIds((current) => moveItem(current, index, index + 1))}
              />
            </div>
          );
        })}
        <button
          type="button"
          className="secondaryButton"
          onClick={() => setSortRowIds((current) => [...current, `sort-${nextSortRowId.current++}`])}
        >
          Add sort column
        </button>
      </Fieldset>
    );
  }
  if (kind === "filterRows") {
    const savedFilterModel = initialStep?.kind === "filterRows" ? initialStep.params.filterModel : undefined;
    const displayedFilterModel = savedFilterModel ?? filterModel;
    const currentQueryIsEmpty = !hasActiveViewQuery(filterModel);
    const displayedFilterCount = displayedFilterModel.filters.filter(isActiveColumnFilter).length;
    const currentFilterCount = filterModel.filters.filter(isActiveColumnFilter).length;
    return (
      <Fieldset legend={savedFilterModel ? "Saved cleaning query" : "Current viewing query"}>
        <p className="panelNote">
          {savedFilterModel
            ? "This edit previews the stable filters and sorts already stored in the cleaning step. Current viewing changes remain independent."
            : "This explicit action copies the current viewing filters and sorts into the cleaning plan. Later viewing changes remain independent."}
        </p>
        <div className="querySummary">
          <strong>{displayedFilterCount} filters</strong>
          <strong>{displayedFilterModel.sort.length} sorts</strong>
        </div>
        {savedFilterModel && (
          <div className="formField" role="radiogroup" aria-label="Filter step source">
            <label className="checkboxField">
              <input name="filterSource" type="radio" value="saved" defaultChecked />
              <span>Keep the saved cleaning query</span>
            </label>
            <label className="checkboxField">
              <input name="filterSource" type="radio" value="current" disabled={currentQueryIsEmpty} />
              <span>
                Replace it with the current viewing query ({currentFilterCount} filters, {filterModel.sort.length}{" "}
                sorts)
              </span>
            </label>
            {currentQueryIsEmpty && <small>Add a viewing filter or sort before replacing the saved query.</small>}
          </div>
        )}
      </Fieldset>
    );
  }
  if (kind === "dropMissingRows") {
    return (
      <>
        <ColumnReferencesSelect
          name="columns"
          label="Columns (none means all)"
          columns={columns}
          defaultValue={initialColumnReferences("columns")}
          required={false}
        />
        <SelectField
          name="how"
          label="Drop when"
          defaultValue={param("how", "any")}
          options={[
            ["any", "Any selected value is missing"],
            ["all", "All selected values are missing"]
          ]}
        />
      </>
    );
  }
  if (kind === "fillMissingValues") {
    return <FillMissingFields backend={metadata.backend} columns={columns} initialStep={initialStep} />;
  }
  if (kind === "dropDuplicates") {
    return (
      <>
        <ColumnReferencesSelect
          name="columns"
          label="Compare columns (none means all)"
          columns={columns}
          defaultValue={initialColumnReferences("columns")}
          required={false}
        />
        <SelectField
          name="keep"
          label="Keep"
          defaultValue={param("keep", "first")}
          options={[
            ["first", "First row"],
            ["last", "Last row"],
            ["none", "No duplicates"]
          ]}
        />
      </>
    );
  }
  if (kind === "selectColumns" || kind === "dropColumns") {
    return (
      <ColumnReferencesSelect
        name="columns"
        label={kind === "selectColumns" ? "Columns to keep" : "Columns to drop"}
        columns={columns}
        defaultValue={initialColumnReferences("columns")}
        preserveSelectionOrder={kind === "selectColumns"}
      />
    );
  }
  if (kind === "oneHotEncode") {
    const categoricalColumns = compatibleColumns(columns, portableScalarColumnTypes);
    return (
      <>
        <ColumnReferencesSelect
          name="columns"
          label="Categorical columns"
          columns={categoricalColumns}
          defaultValue={initialColumnReferences("columns")}
        />
        <TextField name="prefixSeparator" label="Prefix separator" defaultValue={param("prefixSeparator", "_")} />
        <CheckboxField
          name="dropOriginal"
          label="Drop original columns"
          defaultChecked={params.dropOriginal !== false}
        />
      </>
    );
  }
  if (kind === "renameColumn" || kind === "cloneColumn") {
    return (
      <>
        <ColumnReferenceSelect
          name="column"
          label="Column"
          columns={columns}
          defaultValue={initialColumnReference("column")}
        />
        <TextField name="newName" label="New name" defaultValue={param("newName")} required />
      </>
    );
  }
  if (kind === "castColumn") {
    return (
      <>
        <ColumnReferenceSelect
          name="column"
          label="Column"
          columns={columns}
          defaultValue={initialColumnReference("column")}
        />
        <SelectField
          name="dtype"
          label="Target type"
          defaultValue={param("dtype", "string")}
          options={["string", "integer", "float", "boolean", "date", "datetime"].map((value) => [value, value])}
        />
      </>
    );
  }
  if (kind === "formula") {
    const numericColumns = compatibleColumns(columns, numericColumnTypes);
    return (
      <>
        <ColumnReferenceSelect
          name="leftColumn"
          label="Left column"
          columns={numericColumns}
          defaultValue={initialColumnReference("leftColumn", numericColumns[0]?.id)}
          emptyMessage="No numeric columns are available. Cast a column to a numeric type first."
        />
        <SelectField
          name="operator"
          label="Operator"
          defaultValue={param("operator", "add")}
          options={formulaOperators.map((value) => [value, value])}
        />
        <label className="formField">
          <span>Right operand</span>
          <select
            name="operandMode"
            value={formulaOperandMode}
            onChange={(event) => setFormulaOperandMode(event.target.value)}
          >
            <option value="value">Numeric value</option>
            <option value="column">Column</option>
          </select>
        </label>
        {formulaOperandMode === "value" ? (
          <TextField
            name="value"
            label="Numeric value"
            type="number"
            step="any"
            defaultValue={param("value", "0")}
            required
          />
        ) : (
          <ColumnReferenceSelect
            name="rightColumn"
            label="Right column"
            columns={numericColumns}
            defaultValue={initialColumnReference("rightColumn", numericColumns[0]?.id)}
            emptyMessage="No numeric columns are available. Cast a column to a numeric type first."
          />
        )}
        <TextField name="newColumn" label="New column" defaultValue={param("newColumn")} required />
      </>
    );
  }
  if (kind === "textLength") {
    const textColumns = compatibleColumns(columns, textColumnTypes);
    return (
      <>
        <ColumnReferenceSelect
          name="column"
          label="Text column"
          columns={textColumns}
          defaultValue={initialColumnReference("column", textColumns[0]?.id)}
          emptyMessage="No text columns are available. Cast a column to text first."
        />
        <TextField name="newColumn" label="New column" defaultValue={param("newColumn", "text_length")} required />
      </>
    );
  }
  if (kind === "multiLabelBinarize") {
    const textColumns = compatibleColumns(columns, textColumnTypes);
    return (
      <>
        <ColumnReferenceSelect
          name="column"
          label="Labels column"
          columns={textColumns}
          defaultValue={initialColumnReference("column", textColumns[0]?.id)}
          emptyMessage="No text columns are available. Cast a column to text first."
        />
        <TextField name="delimiter" label="Delimiter" defaultValue={param("delimiter", ",")} required />
        <label className="formField">
          <span>Output prefix mode</span>
          <select
            name="prefixMode"
            value={multiLabelPrefixMode}
            onChange={(event) => setMultiLabelPrefixMode(event.target.value)}
          >
            <option value="default">Default (column name + _)</option>
            <option value="custom">Custom (blank means none)</option>
          </select>
        </label>
        {multiLabelPrefixMode === "custom" && (
          <TextField name="prefix" label="Custom output prefix" defaultValue={param("prefix")} />
        )}
        <CheckboxField name="dropOriginal" label="Drop original column" defaultChecked={params.dropOriginal === true} />
      </>
    );
  }
  if (kind === "findReplace") {
    const textColumns = compatibleColumns(columns, textColumnTypes);
    return (
      <>
        <ColumnReferenceSelect
          name="column"
          label="Text column"
          columns={textColumns}
          defaultValue={initialColumnReference("column", textColumns[0]?.id)}
          emptyMessage="No text columns are available. Cast a column to text first."
        />
        <TextField name="find" label="Find (blank matches empty boundaries)" defaultValue={param("find")} />
        <TextField name="replacement" label="Replace with" defaultValue={param("replacement")} />
        <CheckboxField name="regex" label="Use regular expression" defaultChecked={params.regex === true} />
        <TextField name="newColumn" label="Output column (blank replaces in place)" defaultValue={param("newColumn")} />
      </>
    );
  }
  if (kind === "stripText") {
    const textColumns = compatibleColumns(columns, textColumnTypes);
    return (
      <>
        <ColumnReferenceSelect
          name="column"
          label="Text column"
          columns={textColumns}
          defaultValue={initialColumnReference("column", textColumns[0]?.id)}
          emptyMessage="No text columns are available. Cast a column to text first."
        />
        <TextField name="characters" label="Characters (blank means whitespace)" defaultValue={param("characters")} />
        <TextField name="newColumn" label="Output column (blank replaces in place)" defaultValue={param("newColumn")} />
      </>
    );
  }
  if (kind === "splitText") {
    const textColumns = compatibleColumns(columns, textColumnTypes);
    return (
      <>
        <ColumnReferenceSelect
          name="column"
          label="Text column"
          columns={textColumns}
          defaultValue={initialColumnReference("column", textColumns[0]?.id)}
          emptyMessage="No text columns are available. Cast a column to text first."
        />
        <TextField name="delimiter" label="Delimiter" defaultValue={param("delimiter", ",")} required />
        <TextField
          name="index"
          label="Part index"
          type="number"
          min={0}
          step={1}
          defaultValue={param("index", "0")}
          required
        />
        <TextField name="newColumn" label="New column" defaultValue={param("newColumn", "split_value")} required />
      </>
    );
  }
  if (["capitalizeText", "lowerText", "upperText"].includes(kind)) {
    const textColumns = compatibleColumns(columns, textColumnTypes);
    return (
      <>
        <ColumnReferenceSelect
          name="column"
          label="Text column"
          columns={textColumns}
          defaultValue={initialColumnReference("column", textColumns[0]?.id)}
          emptyMessage="No text columns are available. Cast a column to text first."
        />
        <TextField name="newColumn" label="Output column (blank replaces in place)" defaultValue={param("newColumn")} />
      </>
    );
  }
  if (["minMaxScale", "floorNumber", "ceilNumber"].includes(kind)) {
    const numericColumns = compatibleColumns(columns, numericColumnTypes);
    return (
      <>
        <ColumnReferenceSelect
          name="column"
          label="Numeric column"
          columns={numericColumns}
          defaultValue={initialColumnReference("column", numericColumns[0]?.id)}
          emptyMessage="No numeric columns are available. Cast a column to a numeric type first."
        />
        <TextField name="newColumn" label="Output column (blank replaces in place)" defaultValue={param("newColumn")} />
      </>
    );
  }
  if (kind === "roundNumber") {
    const numericColumns = compatibleColumns(columns, numericColumnTypes);
    return (
      <>
        <ColumnReferenceSelect
          name="column"
          label="Numeric column"
          columns={numericColumns}
          defaultValue={initialColumnReference("column", numericColumns[0]?.id)}
          emptyMessage="No numeric columns are available. Cast a column to a numeric type first."
        />
        <TextField
          name="decimals"
          label="Decimal places"
          type="number"
          step={1}
          defaultValue={param("decimals", "0")}
          required
        />
        <TextField name="newColumn" label="Output column (blank replaces in place)" defaultValue={param("newColumn")} />
      </>
    );
  }
  if (kind === "formatDatetime") {
    const datetimeColumns = compatibleColumns(columns, datetimeColumnTypes);
    return (
      <>
        <ColumnReferenceSelect
          name="column"
          label="Date or datetime column"
          columns={datetimeColumns}
          defaultValue={initialColumnReference("column", datetimeColumns[0]?.id)}
          emptyMessage="No date or datetime columns are available. Cast a column first."
        />
        <TextField
          name="format"
          label="strftime format"
          defaultValue={param("format", "%Y-%m-%d")}
          required
          maxUtf8Bytes={metadata.backend === "r" ? 8_192 : undefined}
          description={
            metadata.backend === "r" ? "Native R datetime formats can use up to 8,192 UTF-8 bytes." : undefined
          }
        />
        <TextField name="newColumn" label="Output column (blank replaces in place)" defaultValue={param("newColumn")} />
      </>
    );
  }
  if (kind === "groupBy") {
    const groupColumns = compatibleColumns(columns, portableScalarColumnTypes);
    const aggregationsById = new Map<string, Record<string, unknown>>(
      initialAggregations.map((aggregation, index) => [`aggregation-${index}`, aggregation])
    );
    return (
      <>
        <ColumnReferencesSelect
          name="keys"
          label="Group keys"
          columns={groupColumns}
          defaultValue={initialColumnReferences("keys")}
          preserveSelectionOrder
        />
        <Fieldset legend="Aggregations">
          {aggregationRowIds.map((rowId, index) => (
            <AggregationRow
              key={rowId}
              index={index}
              columns={columns}
              initialAggregation={aggregationsById.get(rowId)}
              canRemove={aggregationRowIds.length > 1}
              canMoveUp={index > 0}
              canMoveDown={index < aggregationRowIds.length - 1}
              onRemove={() => setAggregationRowIds((current) => current.filter((candidate) => candidate !== rowId))}
              onMoveUp={() => setAggregationRowIds((current) => moveItem(current, index, index - 1))}
              onMoveDown={() => setAggregationRowIds((current) => moveItem(current, index, index + 1))}
            />
          ))}
          <button
            type="button"
            className="secondaryButton"
            onClick={() =>
              setAggregationRowIds((current) => [...current, `aggregation-${nextAggregationRowId.current++}`])
            }
          >
            Add aggregation
          </button>
        </Fieldset>
      </>
    );
  }
  if (kind === "byExample") {
    const sourceColumns = compatibleColumns(columns, portableScalarColumnTypes);
    const examples = Array.isArray(params.examples)
      ? JSON.stringify(params.examples, null, 2)
      : JSON.stringify(
          [
            { inputs: ["DACH-DE-00482"], output: "DE" },
            { inputs: ["NORDICS-SE-01940"], output: "SE" }
          ],
          null,
          2
        );
    return (
      <>
        <ColumnReferencesSelect
          name="sourceColumns"
          label="Source columns"
          columns={sourceColumns}
          defaultValue={
            initialColumnReferences("sourceColumns").length
              ? initialColumnReferences("sourceColumns")
              : sourceColumns.slice(0, 1).map((column) => column.id)
          }
          preserveSelectionOrder
        />
        <TextField name="newColumn" label="New column" defaultValue={param("newColumn", "example_result")} required />
        <label className="formField codeField">
          <span>Examples (JSON)</span>
          <textarea name="examples" rows={12} required defaultValue={examples} spellCheck={false} />
          <small>
            Provide 2 to 64 items. Each <code>inputs</code> array must contain one value in the displayed source-column
            order, followed by an <code>output</code>. Preview confirms the deterministic program and reports ambiguity.
          </small>
        </label>
      </>
    );
  }
  if (kind === "customCode") {
    const isNativeR = metadata.backend === "r";
    const languageLabel = isNativeR ? "Engine-native R" : "Engine-native Python";
    return (
      <label className="formField codeField">
        <span>{languageLabel}</span>
        <textarea
          aria-label={languageLabel}
          name="code"
          rows={12}
          required
          defaultValue={param(
            "code",
            isNativeR ? "result <- df" : metadata.backend === "pandas" ? "result = df.copy()" : "result = df"
          )}
          spellCheck={false}
        />
        <small>
          {isNativeR ? "Assign an R data frame" : "Assign an engine-native dataframe or relation"} to{" "}
          <code>result</code>. Custom code runs only in a trusted workspace.
        </small>
      </label>
    );
  }
  return null;
}

function isDefined<T>(value: T | undefined): value is T {
  return value !== undefined;
}

function compatibleColumns(columns: ColumnSchema[], allowedTypes: ReadonlySet<ColumnType>): ColumnSchema[] {
  return columns.filter((column) => allowedTypes.has(column.type));
}

function aggregationColumnTypes(operation: string): ReadonlySet<ColumnType> {
  if (["sum", "mean", "median"].includes(operation)) return numericColumnTypes;
  if (["min", "max"].includes(operation)) return orderedAggregationColumnTypes;
  return portableScalarColumnTypes;
}

function AggregationRow({
  index,
  columns,
  initialAggregation,
  canRemove,
  canMoveUp,
  canMoveDown,
  onRemove,
  onMoveUp,
  onMoveDown
}: {
  index: number;
  columns: ColumnSchema[];
  initialAggregation?: Record<string, unknown>;
  canRemove: boolean;
  canMoveUp: boolean;
  canMoveDown: boolean;
  onRemove(): void;
  onMoveUp(): void;
  onMoveDown(): void;
}) {
  const initialOperation = String(initialAggregation?.operation ?? "sum");
  const [operation, setOperation] = useState(initialOperation);
  const availableColumns = compatibleColumns(columns, aggregationColumnTypes(operation));
  const initialColumnId = columnReferenceId(initialAggregation?.column);
  const [selectedColumnId, setSelectedColumnId] = useState(() =>
    initialColumnId && availableColumns.some((column) => column.id === initialColumnId)
      ? initialColumnId
      : (availableColumns[0]?.id ?? "")
  );

  const changeOperation = (nextOperation: string) => {
    const nextColumns = compatibleColumns(columns, aggregationColumnTypes(nextOperation));
    setOperation(nextOperation);
    setSelectedColumnId((current) =>
      nextColumns.some((column) => column.id === current) ? current : (nextColumns[0]?.id ?? "")
    );
  };

  return (
    <div className="compoundRow aggregationRow operationInputRow">
      <ColumnReferenceSelect
        name="aggregationColumn"
        label={`Value ${index + 1}`}
        columns={availableColumns}
        value={selectedColumnId}
        onChange={setSelectedColumnId}
        emptyMessage={`No columns support the ${operation} calculation.`}
      />
      <label className="formField">
        <span>Calculation</span>
        <select
          name="aggregationOperation"
          aria-label={`Calculation ${index + 1}`}
          value={operation}
          onChange={(event) => changeOperation(event.target.value)}
        >
          {aggregationOperations.map((value) => (
            <option key={value} value={value}>
              {value}
            </option>
          ))}
        </select>
      </label>
      <TextField
        name="aggregationAlias"
        label="Output name"
        defaultValue={String(initialAggregation?.alias ?? `value_${index + 1}`)}
        required
      />
      <RowActions
        label={`aggregation ${index + 1}`}
        canRemove={canRemove}
        canMoveUp={canMoveUp}
        canMoveDown={canMoveDown}
        onRemove={onRemove}
        onMoveUp={onMoveUp}
        onMoveDown={onMoveDown}
      />
    </div>
  );
}

function CheckboxField({ name, label, defaultChecked }: { name: string; label: string; defaultChecked: boolean }) {
  return (
    <label className="checkboxField">
      <input name={name} type="checkbox" defaultChecked={defaultChecked} />
      <span>{label}</span>
    </label>
  );
}
