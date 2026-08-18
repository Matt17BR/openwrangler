import { useEffect, useMemo, useRef, useState } from "react";
import type { FormEvent, KeyboardEvent as ReactKeyboardEvent } from "react";
import type { FilterModel } from "../../shared/filterModel";
import { hasActiveViewQuery } from "../../shared/filterModel";
import type { ColumnSchema, OperationKind, SessionMetadata, TransformStep } from "../../shared/protocol";
import {
  operationGroups,
  operationByKind,
  supportedOperationCatalog,
  supportsOperation
} from "../../shared/operations";
import { isTransformStep } from "../../shared/protocolValidation";
import { OperationFields } from "./OperationFields";
import { buildParams } from "./operationParams";
import { savedStepEditError } from "./savedStepEditValidation";

interface OperationBuilderProps {
  metadata: SessionMetadata;
  filterModel: FilterModel;
  initialKind?: OperationKind;
  initialStep?: TransformStep;
  editInputSchema?: readonly ColumnSchema[];
  busy?: boolean;
  onClose(): void;
  onPreview(step: TransformStep, replaceStepId?: string): void;
}

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
  editInputSchema,
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
  const availableColumns = initialStep
    ? [...(editInputSchema ?? metadata.latestStepInputSchema ?? [])]
    : metadata.schema;
  const editPreflightError = initialStep
    ? savedStepEditError(initialStep, editInputSchema ?? metadata.latestStepInputSchema)
    : undefined;
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
