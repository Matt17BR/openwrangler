import type { DataDiff } from "../shared/protocol";

interface StepInspectionPanelProps {
  operationTitle?: string;
  pendingOffset?: number;
  pageSize: number;
  error?: string;
  diff?: DataDiff;
  onClear: () => void;
}

export function StepInspectionPanel({
  operationTitle,
  pendingOffset,
  pageSize,
  error,
  diff,
  onClear
}: StepInspectionPanelProps) {
  return (
    <section className="inspectionPanel" aria-label="Selected applied-step inspection">
      <header>
        <div>
          <strong>
            {pendingOffset === undefined ? "Inspecting" : "Loading"} {operationTitle ?? "applied step"}
          </strong>
          <span>
            This is that step&apos;s input → output boundary. The confirmed dataframe view and filters are unchanged.
          </span>
        </div>
        <button type="button" className="secondaryButton" onClick={() => onClear()}>
          Show confirmed data
        </button>
      </header>
      {pendingOffset !== undefined && (
        <div role="status" aria-live="polite">
          Loading inspection rows {pendingOffset + 1} to {pendingOffset + pageSize}…
        </div>
      )}
      {error && (
        <div className="errorBanner" role="alert">
          {error}
        </div>
      )}
      {diff && (
        <div className="diffStats" aria-label="Selected step data diff summary">
          <span>+{diff.addedRows} rows</span>
          <span>-{diff.removedRows} rows</span>
          <span>+{diff.addedColumns.length} columns</span>
          <span>-{diff.removedColumns.length} columns</span>
          <span>
            {diff.changedCells} changed cells
            {diff.truncated ? " in this block" : ""}
          </span>
        </div>
      )}
    </section>
  );
}
