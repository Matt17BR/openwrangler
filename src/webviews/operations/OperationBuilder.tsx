import { useEffect, useId, useMemo, useRef, useState } from "react";
import type { FormEvent, KeyboardEvent as ReactKeyboardEvent, ReactNode } from "react";
import type { FilterModel } from "../../shared/filterModel";
import { hasActiveViewQuery, isActiveColumnFilter } from "../../shared/filterModel";
import type {
  ByExampleProgram,
  ColumnReference,
  ColumnSchema,
  ColumnType,
  FillMissingReplacement,
  OperationKind,
  SessionMetadata,
  TransformFilterModel,
  TransformStep
} from "../../shared/protocol";
import { operationCatalog, operationGroups, operationByKind } from "../../shared/operations";
import { isTransformStep } from "../../shared/protocolValidation";

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
type FillValueKind = Exclude<FillMissingReplacement, { kind: "median" }>["kind"];
const fillValueColumnTypes: ReadonlySet<ColumnType> = new Set([
  "string",
  "integer",
  "float",
  "decimal",
  "boolean",
  "date",
  "datetime",
  "unknown"
]);
const fillValueKindOptions: readonly [FillValueKind, string][] = [
  ["string", "Text"],
  ["integer", "Integer"],
  ["float", "Number"],
  ["decimal", "Decimal"],
  ["boolean", "True / false"],
  ["date", "Date"],
  ["datetime", "Date and time"]
];
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

function isSafeByExampleScalar(value: unknown): value is string | number | boolean | null {
  if (value === null || typeof value === "string" || typeof value === "boolean") return true;
  return (
    typeof value === "number" && Number.isFinite(value) && (!Number.isInteger(value) || Number.isSafeInteger(value))
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

interface SavedReferenceCheck {
  label: string;
  reference: ColumnReference;
  expectedType?: ColumnSchema["type"];
}

interface SavedReferenceGroup {
  label: string;
  references: SavedReferenceCheck[];
  rejectRepeatedIds: boolean;
}

function savedReferenceGroups(step: TransformStep): SavedReferenceGroup[] {
  switch (step.kind) {
    case "sortRows":
      return [
        {
          label: "sort rules",
          references: step.params.rules.map((rule, index) => ({
            label: `sort rule ${index + 1}`,
            reference: rule.column
          })),
          rejectRepeatedIds: true
        }
      ];
    case "filterRows":
      return [
        {
          label: "filters",
          references: step.params.filterModel.filters.map((filter, index) => ({
            label: `filter ${index + 1}`,
            reference: filter.column,
            expectedType: filter.type
          })),
          rejectRepeatedIds: true
        },
        {
          label: "filter-step sorts",
          references: step.params.filterModel.sort.map((rule, index) => ({
            label: `filter-step sort ${index + 1}`,
            reference: rule.column
          })),
          rejectRepeatedIds: true
        }
      ];
    case "dropMissingRows":
    case "dropDuplicates":
      return [
        {
          label: "column list",
          references: (step.params.columns ?? []).map((reference, index) => ({
            label: `column ${index + 1}`,
            reference
          })),
          rejectRepeatedIds: true
        }
      ];
    case "selectColumns":
    case "dropColumns":
    case "oneHotEncode":
      return [
        {
          label: "column list",
          references: step.params.columns.map((reference, index) => ({
            label: `column ${index + 1}`,
            reference
          })),
          rejectRepeatedIds: true
        }
      ];
    case "formula":
      return [
        {
          label: "formula operands",
          references: [
            { label: "left formula column", reference: step.params.leftColumn },
            ...(step.params.rightColumn ? [{ label: "right formula column", reference: step.params.rightColumn }] : [])
          ],
          rejectRepeatedIds: false
        }
      ];
    case "renameColumn":
    case "cloneColumn":
    case "castColumn":
    case "textLength":
    case "multiLabelBinarize":
    case "fillMissingValues":
    case "findReplace":
    case "stripText":
    case "splitText":
    case "capitalizeText":
    case "lowerText":
    case "upperText":
    case "minMaxScale":
    case "roundNumber":
    case "floorNumber":
    case "ceilNumber":
    case "formatDatetime":
      return [
        {
          label: "input column",
          references: [{ label: "input column", reference: step.params.column }],
          rejectRepeatedIds: false
        }
      ];
    case "groupBy":
      return [
        {
          label: "group keys",
          references: step.params.keys.map((reference, index) => ({
            label: `group key ${index + 1}`,
            reference
          })),
          rejectRepeatedIds: true
        },
        {
          label: "aggregation values",
          references: step.params.aggregations.map((aggregation, index) => ({
            label: `aggregation value ${index + 1}`,
            reference: aggregation.column
          })),
          rejectRepeatedIds: false
        }
      ];
    case "byExample":
      return [
        {
          label: "by-example sources",
          references: step.params.sourceColumns.map((reference, index) => ({
            label: `by-example source ${index + 1}`,
            reference
          })),
          rejectRepeatedIds: true
        },
        {
          label: "by-example program operands",
          references: step.params.program
            ? byExampleProgramReferences(step.params.program).map((reference, index) => ({
                label: `by-example program operand ${index + 1}`,
                reference
              }))
            : [],
          rejectRepeatedIds: false
        }
      ];
    default:
      return [];
  }
}

function byExampleProgramReferences(program: ByExampleProgram): ColumnReference[] {
  if (program.kind === "column") return [program.column];
  if (program.kind === "literal") return [];
  if (program.kind === "concat") return program.parts.flatMap(byExampleProgramReferences);
  if (program.kind === "arithmetic") {
    return [...byExampleProgramReferences(program.left), ...byExampleProgramReferences(program.right)];
  }
  return byExampleProgramReferences(program.input);
}

function savedStepEditError(step: TransformStep, inputSchema: ColumnSchema[] | undefined): string | undefined {
  const recovery = "Cancel editing, then reload the session or undo and recreate this step.";
  if (!inputSchema) {
    return `This saved step cannot be edited safely because its recorded input schema is unavailable. ${recovery}`;
  }

  const columnsById = new Map(inputSchema.map((column) => [column.id, column]));
  if (columnsById.size !== inputSchema.length) {
    return `This saved step cannot be edited safely because its recorded input schema contains duplicate column IDs. ${recovery}`;
  }

  for (const group of savedReferenceGroups(step)) {
    const seenIds = new Set<string>();
    for (const check of group.references) {
      const column = columnsById.get(check.reference.id);
      if (!column) {
        return `The saved ${check.label} refers to column ID “${check.reference.id}”, which is absent from the recorded input schema. ${recovery}`;
      }
      if (column.name !== check.reference.name) {
        return `The saved ${check.label} expects column name “${check.reference.name}” for ID “${check.reference.id}”, but the recorded input schema names it “${column.name}”. ${recovery}`;
      }
      if (check.expectedType !== undefined && column.type !== check.expectedType) {
        return `The saved ${check.label} declares type “${check.expectedType}”, but its recorded input column has type “${column.type}”. ${recovery}`;
      }
      if (group.rejectRepeatedIds && seenIds.has(check.reference.id)) {
        return `The saved ${group.label} repeats column ID “${check.reference.id}”. ${recovery}`;
      }
      seenIds.add(check.reference.id);
    }
  }
  if (step.kind === "byExample") {
    if (!step.params.program) {
      return `This saved by-example step has no deterministic program. ${recovery}`;
    }
    const sourceIds = new Set(step.params.sourceColumns.map((reference) => reference.id));
    const outsideSource = byExampleProgramReferences(step.params.program).find(
      (reference) => !sourceIds.has(reference.id)
    );
    if (outsideSource) {
      return `The saved by-example program uses column ID “${outsideSource.id}” outside its selected sources. ${recovery}`;
    }
  }
  return undefined;
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
  const [selectedKind, setSelectedKind] = useState<OperationKind | undefined>(initialKind ?? initialStep?.kind);
  const [search, setSearch] = useState("");
  const [formError, setFormError] = useState<string>();
  const dialogRef = useRef<HTMLElement | null>(null);
  const filteredCatalog = useMemo(() => {
    const query = search.trim().toLowerCase();
    return query
      ? operationCatalog.filter(
          (operation) =>
            operation.title.toLowerCase().includes(query) || operation.description.toLowerCase().includes(query)
        )
      : operationCatalog;
  }, [search]);
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
    if (busy || !selectedKind || editPreflightError) return;
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
    return <FillMissingFields columns={columns} initialStep={initialStep} />;
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
          <TextField name="value" label="Numeric value" type="number" step="any" defaultValue={param("value", "0")} />
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
        <TextField name="format" label="strftime format" defaultValue={param("format", "%Y-%m-%d")} required />
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
    return (
      <label className="formField codeField">
        <span>Engine-native Python</span>
        <textarea
          name="code"
          rows={12}
          required
          defaultValue={param("code", metadata.backend === "pandas" ? "result = df.copy()" : "result = df")}
          spellCheck={false}
        />
        <small>
          Assign an engine-native dataframe or relation to <code>result</code>. Custom code runs only in a trusted
          workspace.
        </small>
      </label>
    );
  }
  return null;
}

function FillMissingFields({ columns, initialStep }: { columns: ColumnSchema[]; initialStep?: TransformStep }) {
  const initialParams = initialStep?.kind === "fillMissingValues" ? initialStep.params : undefined;
  const initialReplacement = initialParams?.replacement;
  const medianColumns = compatibleColumns(columns, numericColumnTypes);
  const valueColumns = compatibleColumns(columns, fillValueColumnTypes);
  const [mode, setMode] = useState<"median" | "value">(
    initialReplacement
      ? initialReplacement.kind === "median"
        ? "median"
        : "value"
      : medianColumns.length
        ? "median"
        : "value"
  );
  const availableColumns = mode === "median" ? medianColumns : valueColumns;
  const savedColumnId = columnReferenceId(initialParams?.column);
  const [selectedColumnId, setSelectedColumnId] = useState(() =>
    savedColumnId && availableColumns.some((column) => column.id === savedColumnId)
      ? savedColumnId
      : (availableColumns[0]?.id ?? "")
  );
  const selectedColumn = availableColumns.find((column) => column.id === selectedColumnId);
  const initialKind = initialReplacement?.kind !== "median" ? initialReplacement?.kind : undefined;
  const [unknownValueKind, setUnknownValueKind] = useState<FillValueKind>(initialKind ?? "string");

  const changeMode = (nextMode: "median" | "value") => {
    const nextColumns = nextMode === "median" ? medianColumns : valueColumns;
    setMode(nextMode);
    setSelectedColumnId((current) =>
      nextColumns.some((column) => column.id === current) ? current : (nextColumns[0]?.id ?? "")
    );
  };
  const changeColumn = (id: string) => {
    setSelectedColumnId(id);
    const column = availableColumns.find((candidate) => candidate.id === id);
    if (column?.type !== "unknown") setUnknownValueKind(fillValueKindForColumn(column?.type));
  };
  const valueKind =
    selectedColumn?.type === "unknown" ? unknownValueKind : fillValueKindForColumn(selectedColumn?.type);
  const savedValue = initialReplacement?.kind !== "median" ? String(initialReplacement?.value) : "";

  return (
    <>
      <label className="formField">
        <span>Fill with</span>
        <select name="fillMode" value={mode} onChange={(event) => changeMode(event.target.value as "median" | "value")}>
          <option value="value">A value</option>
          <option value="median">Column median</option>
        </select>
      </label>
      <ColumnReferenceSelect
        name="column"
        label={mode === "median" ? "Numeric column" : "Column"}
        columns={availableColumns}
        value={selectedColumnId}
        onChange={changeColumn}
        emptyMessage={
          mode === "median"
            ? "No numeric columns are available. Choose a typed value or convert a column first."
            : "No scalar columns support a typed replacement."
        }
      />
      {mode === "median" ? (
        <p className="panelNote">
          The median ignores null and NaN cells. The filled column uses floating-point values on every engine.
        </p>
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
          <FillReplacementInput kind={valueKind} defaultValue={savedValue} />
        </>
      )}
    </>
  );
}

function fillValueKindForColumn(type: ColumnType | undefined): FillValueKind {
  return type === "integer" ||
    type === "float" ||
    type === "decimal" ||
    type === "boolean" ||
    type === "date" ||
    type === "datetime"
    ? type
    : "string";
}

function FillReplacementInput({ kind, defaultValue }: { kind: FillValueKind; defaultValue: string }) {
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
        : `Replacement ${kind}`;
  return (
    <TextField
      key={kind}
      name="fillValue"
      label={label}
      defaultValue={defaultValue}
      required={kind !== "string"}
      inputMode={kind === "integer" ? "numeric" : kind === "float" || kind === "decimal" ? "decimal" : undefined}
      maxLength={kind === "string" ? 65_536 : kind === "integer" ? 40 : kind === "decimal" ? 128 : 64}
    />
  );
}

function buildParams(
  kind: OperationKind,
  form: FormData,
  filterModel: FilterModel,
  availableColumns: ColumnSchema[],
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
  if (kind === "sortRows") {
    const columns = columnReferences("sortColumn");
    if (columns.length === 0) throw new Error("Sort rows requires at least one sort rule.");
    const directions = form.getAll("sortDirection").map(String);
    const nulls = form.getAll("sortNulls").map(String);
    return { rules: columns.map((column, index) => ({ column, direction: directions[index], nulls: nulls[index] })) };
  }
  if (kind === "filterRows") {
    const useSaved = savedFilterModel !== undefined && value("filterSource") !== "current";
    return { filterModel: useSaved ? savedFilterModel : transformFilterModel(filterModel, availableColumns) };
  }
  if (kind === "dropMissingRows") return { columns: columnReferences("columns"), how: value("how") };
  if (kind === "fillMissingValues") {
    if (value("fillMode") === "median") {
      return { column: columnReference("column"), replacement: { kind: "median" } };
    }
    const replacementKind = value("fillValueKind");
    return {
      column: columnReference("column"),
      replacement: {
        kind: replacementKind,
        value: replacementKind === "boolean" ? value("fillValue") === "true" : value("fillValue")
      }
    };
  }
  if (kind === "dropDuplicates") {
    const params: Record<string, unknown> = { keep: value("keep") };
    const columns = columnReferences("columns");
    if (columns.length) params.columns = columns;
    return params;
  }
  if (kind === "selectColumns" || kind === "dropColumns")
    return {
      columns: requiredColumnReferences("columns", kind === "selectColumns" ? "Select columns" : "Drop columns")
    };
  if (kind === "oneHotEncode")
    return {
      columns: requiredColumnReferences("columns", "One-hot encoding"),
      prefixSeparator: value("prefixSeparator"),
      dropOriginal: form.has("dropOriginal")
    };
  if (kind === "renameColumn" || kind === "cloneColumn") {
    return { column: columnReference("column"), newName: value("newName") };
  }
  if (kind === "castColumn") return { column: columnReference("column"), dtype: value("dtype") };
  if (kind === "formula")
    return {
      leftColumn: columnReference("leftColumn"),
      operator: value("operator"),
      newColumn: value("newColumn"),
      ...(value("operandMode") === "column"
        ? { rightColumn: columnReference("rightColumn") }
        : { value: Number(value("value")) })
    };
  if (kind === "textLength") return { column: columnReference("column"), newColumn: value("newColumn") };
  if (kind === "multiLabelBinarize") {
    const params: Record<string, unknown> = {
      column: columnReference("column"),
      delimiter: value("delimiter"),
      dropOriginal: form.has("dropOriginal")
    };
    if (value("prefixMode") === "custom") params.prefix = value("prefix");
    return params;
  }
  if (kind === "findReplace") {
    const params: Record<string, unknown> = {
      column: columnReference("column"),
      find: value("find"),
      replacement: value("replacement"),
      regex: form.has("regex")
    };
    optional(params, "newColumn");
    return params;
  }
  if (kind === "stripText") {
    const params: Record<string, unknown> = { column: columnReference("column") };
    optional(params, "characters");
    optional(params, "newColumn");
    return params;
  }
  if (kind === "splitText")
    return {
      column: columnReference("column"),
      delimiter: value("delimiter"),
      index: Number(value("index")),
      newColumn: value("newColumn")
    };
  if (["capitalizeText", "lowerText", "upperText", "minMaxScale", "floorNumber", "ceilNumber"].includes(kind)) {
    const params: Record<string, unknown> = { column: columnReference("column") };
    optional(params, "newColumn");
    return params;
  }
  if (kind === "roundNumber") {
    const params: Record<string, unknown> = {
      column: columnReference("column"),
      decimals: Number(value("decimals"))
    };
    optional(params, "newColumn");
    return params;
  }
  if (kind === "formatDatetime") {
    const params: Record<string, unknown> = { column: columnReference("column"), format: value("format") };
    optional(params, "newColumn");
    return params;
  }
  if (kind === "groupBy") {
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
  if (kind === "byExample") {
    let examples: unknown;
    const examplesJson = value("examples");
    rejectUnsafeIntegerJsonTokens(examplesJson);
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
          `Example ${index + 1} values must be JSON scalars; integer values must stay within JavaScript's exact safe range.`
        );
      }
    }
    return {
      sourceColumns,
      newColumn: value("newColumn"),
      examples
    };
  }
  return { code: value("code") };
}

function columnReferenceId(value: unknown): string | undefined {
  return typeof value === "object" && value !== null && "id" in value && typeof value.id === "string"
    ? value.id
    : undefined;
}

function isDefined<T>(value: T | undefined): value is T {
  return value !== undefined;
}

function referenceForId(id: string, columns: ColumnSchema[]): ColumnReference {
  const column = columns.find((candidate) => candidate.id === id);
  if (!column) throw new Error("The selected column is no longer available.");
  return { id: column.id, name: column.name };
}

function transformFilterModel(filterModel: FilterModel, columns: ColumnSchema[]): TransformFilterModel {
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

function Fieldset({ legend, children }: { legend: string; children: ReactNode }) {
  return (
    <fieldset className="formFieldset">
      <legend>{legend}</legend>
      {children}
    </fieldset>
  );
}

function moveItem<T>(items: readonly T[], from: number, to: number): T[] {
  if (from < 0 || from >= items.length || to < 0 || to >= items.length || from === to) return [...items];
  const result = [...items];
  const [item] = result.splice(from, 1);
  result.splice(to, 0, item);
  return result;
}

function compatibleColumns(columns: ColumnSchema[], allowedTypes: ReadonlySet<ColumnType>): ColumnSchema[] {
  return columns.filter((column) => allowedTypes.has(column.type));
}

function aggregationColumnTypes(operation: string): ReadonlySet<ColumnType> {
  if (["sum", "mean", "median"].includes(operation)) return numericColumnTypes;
  if (["min", "max"].includes(operation)) return orderedAggregationColumnTypes;
  return portableScalarColumnTypes;
}

function RowActions({
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
        <select name="aggregationOperation" value={operation} onChange={(event) => changeOperation(event.target.value)}>
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

function ColumnReferenceSelect({
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

function ColumnReferencesSelect({
  name,
  label,
  columns,
  defaultValue,
  required = true,
  preserveSelectionOrder = false
}: {
  name: string;
  label: string;
  columns: ColumnSchema[];
  defaultValue: string[];
  required?: boolean;
  preserveSelectionOrder?: boolean;
}) {
  const selectId = useId();
  const helpId = `${selectId}-help`;
  const orderId = `${selectId}-order`;
  const validColumnIds = new Set(columns.map((column) => column.id));
  const optionLabels = useMemo(() => columnOptionLabels(columns), [columns]);
  const [selectedIds, setSelectedIds] = useState(defaultValue.filter((id) => validColumnIds.has(id)));
  const selectedLabels = selectedIds.map((id) => {
    return optionLabels.get(id) ?? id;
  });
  return (
    <fieldset
      className="columnSelectionField"
      aria-describedby={preserveSelectionOrder && selectedLabels.length > 0 ? `${helpId} ${orderId}` : helpId}
    >
      <legend>{label}</legend>
      {selectedIds.map((id) => (
        <input key={id} type="hidden" name={name} value={id} />
      ))}
      <div className="columnChecklist" id={selectId}>
        {columns.map((column) => (
          <label className="columnChecklistItem" key={column.id}>
            <input
              type="checkbox"
              value={column.id}
              checked={selectedIds.includes(column.id)}
              onChange={(event) => {
                const checked = event.currentTarget.checked;
                setSelectedIds((current) => {
                  if (!checked) return current.filter((id) => id !== column.id);
                  if (current.includes(column.id)) return current;
                  if (preserveSelectionOrder) return [...current, column.id];
                  const selected = new Set([...current, column.id]);
                  return columns.filter((candidate) => selected.has(candidate.id)).map((candidate) => candidate.id);
                });
              }}
            />
            <span>{optionLabels.get(column.id)}</span>
          </label>
        ))}
        {columns.length === 0 && <span className="mutedText">No compatible columns are available.</span>}
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

function SelectField({
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

function TextField({
  name,
  label,
  defaultValue,
  required = false,
  type = "text",
  min,
  step,
  inputMode,
  maxLength
}: {
  name: string;
  label: string;
  defaultValue: string;
  required?: boolean;
  type?: string;
  min?: number;
  step?: number | "any";
  inputMode?: "numeric" | "decimal";
  maxLength?: number;
}) {
  return (
    <label className="formField">
      <span>{label}</span>
      <input
        name={name}
        type={type}
        min={min}
        step={step}
        inputMode={inputMode}
        maxLength={maxLength}
        defaultValue={defaultValue}
        required={required}
      />
    </label>
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
