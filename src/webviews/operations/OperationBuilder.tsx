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
  TransformSortRule,
  TransformStep
} from "../../shared/protocol";
import {
  operationGroups,
  operationByKind,
  supportedOperationCatalog,
  supportsOperation
} from "../../shared/operations";
import { isTransformStep } from "../../shared/protocolValidation";
import { columnTypePresentation } from "../columnTypes";

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
type FillMode =
  | "median"
  | "mean"
  | "mostFrequent"
  | "groupedMedian"
  | "groupedMean"
  | "groupedMostFrequent"
  | "linearInterpolation"
  | "directionalForward"
  | "directionalBackward"
  | "fallbackColumns"
  | "value";
type FillValueKind = Exclude<
  FillMissingReplacement,
  | { kind: "median" }
  | { kind: "mean" }
  | { kind: "mostFrequent" }
  | { kind: "linearInterpolation" }
  | { kind: "directional" }
  | { kind: "groupedStatistic" }
  | { kind: "fallbackColumns" }
>["kind"];
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
const mostFrequentColumnTypes: ReadonlySet<ColumnType> = new Set(["string", "boolean"]);
const interpolationCoordinateColumnTypes: ReadonlySet<ColumnType> = new Set([
  "integer",
  "float",
  "decimal",
  "date",
  "datetime"
]);
const maxFillFallbackColumns = 64;
const maxFillDirectionalGap = 1_000_000;
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
    case "fillMissingValues":
      return [
        {
          label: "fill columns",
          references: [
            { label: "fill target", reference: step.params.column },
            ...(step.params.replacement.kind === "fallbackColumns"
              ? step.params.replacement.columns.map((reference, index) => ({
                  label: `fallback column ${index + 1}`,
                  reference
                }))
              : step.params.replacement.kind === "groupedStatistic"
                ? step.params.replacement.keys.map((reference, index) => ({
                    label: `group key ${index + 1}`,
                    reference
                  }))
                : step.params.replacement.kind === "directional"
                  ? step.params.replacement.orderBy.map((rule, index) => ({
                      label: `calculation order ${index + 1}`,
                      reference: rule.column
                    }))
                  : step.params.replacement.kind === "linearInterpolation"
                    ? [{ label: "interpolation coordinate", reference: step.params.replacement.coordinate }]
                    : [])
          ],
          rejectRepeatedIds: true
        }
      ];
    case "renameColumn":
    case "cloneColumn":
    case "castColumn":
    case "textLength":
    case "multiLabelBinarize":
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
  if (step.kind === "fillMissingValues" && step.params.replacement.kind === "fallbackColumns") {
    const target = columnsById.get(step.params.column.id);
    if (!target) return `The saved fill target is absent from the recorded input schema. ${recovery}`;
    const incompatible = step.params.replacement.columns.find(
      (reference) => columnsById.get(reference.id)?.type !== target.type
    );
    if (incompatible) {
      return `The saved fallback column “${incompatible.name}” is not compatible with the recorded ${target.type} target. ${recovery}`;
    }
  }
  if (step.kind === "fillMissingValues" && step.params.replacement.kind === "directional") {
    const incompatible = step.params.replacement.orderBy.find((rule) => {
      const column = columnsById.get(rule.column.id);
      return !column || !orderedAggregationColumnTypes.has(column.type);
    });
    if (incompatible) {
      return `The saved calculation-order column “${incompatible.column.name}” cannot be ordered safely. ${recovery}`;
    }
  }
  if (step.kind === "fillMissingValues" && step.params.replacement.kind === "linearInterpolation") {
    const target = columnsById.get(step.params.column.id);
    const coordinate = columnsById.get(step.params.replacement.coordinate.id);
    if (target?.type !== "float") {
      return `The saved interpolation target is not a floating-point column. ${recovery}`;
    }
    if (!coordinate || !isInterpolationCoordinateColumn(coordinate)) {
      return `The saved interpolation coordinate cannot be used safely. ${recovery}`;
    }
  }
  if (step.kind === "fillMissingValues" && step.params.replacement.kind === "groupedStatistic") {
    const incompatible = step.params.replacement.keys.find((reference) => {
      const column = columnsById.get(reference.id);
      return !column || !orderedAggregationColumnTypes.has(column.type);
    });
    if (incompatible) {
      return `The saved group key “${incompatible.name}” cannot be used for grouped filling. ${recovery}`;
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

function FillMissingFields({
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
  const savedColumnId = columnReferenceId(initialParams?.column);
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
  const initialFallbackIds = (() => {
    const availableIds = new Set(initialFallbackColumns.map((column) => column.id));
    const seen = new Set<string>();
    const restored = savedFallbackColumnIds.filter((id) => {
      if (!availableIds.has(id) || seen.has(id)) return false;
      seen.add(id);
      return true;
    });
    if (restored.length > 0) return restored.slice(0, maxFillFallbackColumns);
    return initialFallbackColumns[0] ? [initialFallbackColumns[0].id] : [];
  })();
  const nextFallbackRowId = useRef(Math.max(1, initialFallbackIds.length));
  const [fallbackRows, setFallbackRows] = useState<FillFallbackRow[]>(() =>
    initialFallbackIds.map((columnId, index) => ({ key: `fill-fallback-${index}`, columnId }))
  );
  const savedGroupedKeyIds =
    initialReplacement?.kind === "groupedStatistic" ? initialReplacement.keys.map((column) => column.id) : [];
  const initialGroupedKeyColumns = groupedKeyColumnsForTarget(selectedColumn, columns);
  const initialGroupedKeyIds = (() => {
    const availableIds = new Set(initialGroupedKeyColumns.map((column) => column.id));
    const seen = new Set<string>();
    const restored = savedGroupedKeyIds.filter((id) => {
      if (!availableIds.has(id) || seen.has(id)) return false;
      seen.add(id);
      return true;
    });
    if (restored.length > 0) return restored;
    return initialGroupedKeyColumns[0] ? [initialGroupedKeyColumns[0].id] : [];
  })();
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
  const savedMode: FillMode | undefined = initialReplacement
    ? initialReplacement.kind === "median" ||
      initialReplacement.kind === "mean" ||
      initialReplacement.kind === "mostFrequent" ||
      initialReplacement.kind === "fallbackColumns"
      ? initialReplacement.kind
      : initialReplacement.kind === "groupedStatistic"
        ? initialReplacement.statistic === "median"
          ? "groupedMedian"
          : initialReplacement.statistic === "mean"
            ? "groupedMean"
            : "groupedMostFrequent"
        : initialReplacement.kind === "linearInterpolation"
          ? "linearInterpolation"
          : initialReplacement.kind === "directional"
            ? initialReplacement.direction === "forward"
              ? "directionalForward"
              : "directionalBackward"
            : "value"
    : undefined;
  const fallbackColumns = fallbackColumnsForTarget(selectedColumn, columns);
  const [mode, setMode] = useState<FillMode>(() =>
    savedMode && fillModesForColumn(selectedColumn, columns).includes(savedMode)
      ? savedMode
      : defaultFillModeForColumn(selectedColumn, columns)
  );
  const initialKind =
    initialReplacement?.kind !== "median" &&
    initialReplacement?.kind !== "mean" &&
    initialReplacement?.kind !== "mostFrequent" &&
    initialReplacement?.kind !== "groupedStatistic" &&
    initialReplacement?.kind !== "linearInterpolation" &&
    initialReplacement?.kind !== "directional" &&
    initialReplacement?.kind !== "fallbackColumns"
      ? initialReplacement?.kind
      : undefined;
  const [unknownValueKind, setUnknownValueKind] = useState<FillValueKind>(initialKind ?? "string");

  const changeColumn = (id: string) => {
    setSelectedColumnId(id);
    const column = availableColumns.find((candidate) => candidate.id === id);
    const nextFallbackColumns = fallbackColumnsForTarget(column, columns);
    const nextFallbackIds = new Set(nextFallbackColumns.map((candidate) => candidate.id));
    setFallbackRows((current) => {
      const seen = new Set<string>();
      const retained = current.filter((row) => {
        if (!nextFallbackIds.has(row.columnId) || seen.has(row.columnId)) return false;
        seen.add(row.columnId);
        return true;
      });
      if (retained.length > 0) return retained.slice(0, maxFillFallbackColumns);
      const first = nextFallbackColumns[0];
      return first ? [{ key: `fill-fallback-${nextFallbackRowId.current++}`, columnId: first.id }] : [];
    });
    const nextGroupedKeyColumns = groupedKeyColumnsForTarget(column, columns);
    const nextGroupedKeyIds = new Set(nextGroupedKeyColumns.map((candidate) => candidate.id));
    setGroupedKeyIds((current) => {
      const seen = new Set<string>();
      const retained = current.filter((keyId) => {
        if (!nextGroupedKeyIds.has(keyId) || seen.has(keyId)) return false;
        seen.add(keyId);
        return true;
      });
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
    const nextOrderIds = new Set(nextOrderColumns.map((candidate) => candidate.id));
    setOrderRows((current) => {
      const seen = new Set<string>();
      const retained = current.filter((row) => {
        if (!nextOrderIds.has(row.columnId) || seen.has(row.columnId)) return false;
        seen.add(row.columnId);
        return true;
      });
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
  const savedValue =
    initialReplacement?.kind !== "median" &&
    initialReplacement?.kind !== "mean" &&
    initialReplacement?.kind !== "mostFrequent" &&
    initialReplacement?.kind !== "groupedStatistic" &&
    initialReplacement?.kind !== "linearInterpolation" &&
    initialReplacement?.kind !== "directional" &&
    initialReplacement?.kind !== "fallbackColumns"
      ? String(initialReplacement?.value)
      : "";
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
              <option value="fallbackColumns">Other columns (first available)</option>
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
          <FillReplacementInput backend={backend} kind={valueKind} defaultValue={savedValue} />
          {selectedColumn?.type === "string" && (
            <p className="panelNote">
              For categorical columns, a specific value may convert the column to text. Most common value keeps the
              category type.
            </p>
          )}
        </>
      )}
    </>
  );
}

function fillModesForColumn(column: ColumnSchema | undefined, columns: readonly ColumnSchema[]): FillMode[] {
  const fallback = fallbackColumnsForTarget(column, columns).length > 0 ? (["fallbackColumns"] as const) : [];
  const grouped = groupedKeyColumnsForTarget(column, columns).length > 0;
  const interpolation =
    interpolationCoordinateColumnsForTarget(column, columns).length > 0 ? (["linearInterpolation"] as const) : [];
  const directional =
    directionalOrderColumnsForTarget(column, columns).length > 0
      ? (["directionalForward", "directionalBackward"] as const)
      : [];
  if (column?.type === "float")
    return [
      "median",
      "mean",
      ...interpolation,
      ...(grouped ? (["groupedMedian", "groupedMean"] as const) : []),
      ...directional,
      ...fallback,
      "value"
    ];
  if (column && numericColumnTypes.has(column.type))
    return ["median", ...(grouped ? (["groupedMedian"] as const) : []), ...directional, ...fallback, "value"];
  if (column && mostFrequentColumnTypes.has(column.type))
    return [
      "mostFrequent",
      ...(grouped ? (["groupedMostFrequent"] as const) : []),
      ...directional,
      ...fallback,
      "value"
    ];
  if (column && (column.type === "date" || column.type === "datetime")) return [...directional, ...fallback, "value"];
  if (column && portableScalarColumnTypes.has(column.type)) return [...directional];
  return ["value"];
}

function isInterpolationCoordinateColumn(column: ColumnSchema): boolean {
  if (!interpolationCoordinateColumnTypes.has(column.type)) return false;
  const rawType = column.rawType.toLowerCase();
  return rawType !== "integer64" && !rawType.includes("int128") && !rawType.includes("hugeint");
}

function interpolationCoordinateColumnsForTarget(
  target: ColumnSchema | undefined,
  columns: readonly ColumnSchema[]
): ColumnSchema[] {
  if (target?.type !== "float") return [];
  return columns.filter((column) => column.id !== target.id && isInterpolationCoordinateColumn(column));
}

function defaultFillModeForColumn(column: ColumnSchema | undefined, columns: readonly ColumnSchema[]): FillMode {
  return fillModesForColumn(column, columns)[0];
}

function fallbackColumnsForTarget(target: ColumnSchema | undefined, columns: readonly ColumnSchema[]): ColumnSchema[] {
  if (!target || target.type === "unknown") return [];
  return columns.filter((column) => column.id !== target.id && column.type === target.type);
}

function directionalOrderColumnsForTarget(
  target: ColumnSchema | undefined,
  columns: readonly ColumnSchema[]
): ColumnSchema[] {
  if (!target || !portableScalarColumnTypes.has(target.type)) return [];
  return columns.filter((column) => column.id !== target.id && orderedAggregationColumnTypes.has(column.type));
}

function groupedKeyColumnsForTarget(
  target: ColumnSchema | undefined,
  columns: readonly ColumnSchema[]
): ColumnSchema[] {
  if (!target) return [];
  return columns.filter((column) => column.id !== target.id && orderedAggregationColumnTypes.has(column.type));
}

function fillTargetColumns(columns: readonly ColumnSchema[]): ColumnSchema[] {
  return columns.filter(
    (column) =>
      fillValueColumnTypes.has(column.type) ||
      (portableScalarColumnTypes.has(column.type) && directionalOrderColumnsForTarget(column, columns).length > 0)
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

function normalizeFillNumericValue(kind: FillValueKind, value: string): string {
  const trimmed = value.trim();
  if (kind === "integer") {
    if (!/^[+-]?[0-9]+$/u.test(trimmed)) return trimmed;
    try {
      return BigInt(trimmed).toString();
    } catch {
      return trimmed;
    }
  }
  if (kind !== "float" && kind !== "decimal") return value;
  const match = trimmed.match(/^([+-]?)(?:(\d+)(\.\d*)?|(\.\d+))([eE][+-]?\d+)?$/u);
  if (!match) return trimmed;
  const [, sign, wholeText = "", fractionAfterWhole, fractionOnly, exponent = ""] = match;
  const whole = (wholeText || "0").replace(/^0+(?=\d)/u, "");
  const fraction = fractionOnly !== undefined ? fractionOnly.slice(1) : fractionAfterWhole?.slice(1);
  const coefficient = fraction === undefined ? whole : `${whole}.${fraction || "0"}`;
  return `${sign === "-" ? "-" : ""}${coefficient}${exponent}`;
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
  if (kind === "dropMissingRows") {
    const columns = columnReferences("columns");
    return { ...(columns.length > 0 ? { columns } : {}), how: value("how") };
  }
  if (kind === "fillMissingValues") {
    const fillMode = value("fillMode");
    if (fillMode === "median" || fillMode === "mean" || fillMode === "mostFrequent") {
      return { column: columnReference("column"), replacement: { kind: fillMode } };
    }
    if (fillMode === "linearInterpolation") {
      const column = columnReference("column");
      const coordinate = columnReference("fillInterpolationCoordinate");
      if (coordinate.id === column.id) {
        throw new Error("The fill target and interpolation coordinate must be different columns.");
      }
      const maxGap = value("fillInterpolationMaxGap").trim();
      if (maxGap !== "" && (!/^[1-9][0-9]*$/u.test(maxGap) || Number(maxGap) > maxFillDirectionalGap)) {
        throw new Error(
          `Maximum missing cells in a run must be a whole number from 1 to ${maxFillDirectionalGap.toLocaleString()}.`
        );
      }
      return {
        column,
        replacement: {
          kind: "linearInterpolation",
          coordinate,
          ...(maxGap === "" ? {} : { maxGap: Number(maxGap) })
        }
      };
    }
    if (fillMode === "directionalForward" || fillMode === "directionalBackward") {
      const column = columnReference("column");
      const orderColumns = requiredColumnReferences("fillOrderColumn", "Directional fill order");
      if (orderColumns.some((orderColumn) => orderColumn.id === column.id)) {
        throw new Error("A fill target cannot also be one of its calculation-order columns.");
      }
      const directions = form.getAll("fillOrderDirection").map(String);
      const nulls = form.getAll("fillOrderNulls").map(String);
      const maxGap = value("fillMaxGap").trim();
      if (maxGap !== "" && (!/^[1-9][0-9]*$/u.test(maxGap) || Number(maxGap) > maxFillDirectionalGap)) {
        throw new Error(
          `Maximum gap length must be a whole number from 1 to ${maxFillDirectionalGap.toLocaleString()}.`
        );
      }
      return {
        column,
        replacement: {
          kind: "directional",
          direction: fillMode === "directionalForward" ? "forward" : "backward",
          orderBy: orderColumns.map((orderColumn, index) => ({
            column: orderColumn,
            direction: directions[index],
            nulls: nulls[index]
          })),
          ...(maxGap === "" ? {} : { maxGap: Number(maxGap) })
        }
      };
    }
    if (fillMode === "groupedMedian" || fillMode === "groupedMean" || fillMode === "groupedMostFrequent") {
      const column = columnReference("column");
      const keys = requiredColumnReferences("fillGroupKeys", "Grouped fill");
      if (keys.some((key) => key.id === column.id)) {
        throw new Error("A fill target cannot also be one of its group keys.");
      }
      return {
        column,
        replacement: {
          kind: "groupedStatistic",
          statistic: fillMode === "groupedMedian" ? "median" : fillMode === "groupedMean" ? "mean" : "mostFrequent",
          keys
        }
      };
    }
    if (fillMode === "fallbackColumns") {
      const column = columnReference("column");
      const fallbacks = requiredColumnReferences("fallbackColumns", "Fallback-column fill");
      if (fallbacks.some((fallback) => fallback.id === column.id)) {
        throw new Error("A fill target cannot also be one of its fallback columns.");
      }
      return {
        column,
        replacement: {
          kind: fillMode,
          columns: fallbacks
        }
      };
    }
    const replacementKind = value("fillValueKind");
    const rawValue = value("fillValue");
    return {
      column: columnReference("column"),
      replacement: {
        kind: replacementKind,
        value:
          replacementKind === "boolean"
            ? rawValue === "true"
            : normalizeFillNumericValue(replacementKind as FillValueKind, rawValue)
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
  const selectedLabels = selectedIds.map((id) => {
    return optionLabels.get(id) ?? id;
  });
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

function CheckboxField({ name, label, defaultChecked }: { name: string; label: string; defaultChecked: boolean }) {
  return (
    <label className="checkboxField">
      <input name={name} type="checkbox" defaultChecked={defaultChecked} />
      <span>{label}</span>
    </label>
  );
}
