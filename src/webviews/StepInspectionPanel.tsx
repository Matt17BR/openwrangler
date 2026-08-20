import { useState } from "react";
import type { DataDiff } from "../shared/protocol";

interface StepInspectionPanelProps {
  operationTitle?: string;
  pendingOffset?: number;
  pageSize: number;
  error?: string;
  diff?: DataDiff;
  canEdit?: boolean;
  canDelete?: boolean;
  onEdit?: () => void;
  onDelete?: () => void;
  onClear: () => void;
}

export function StepInspectionPanel({
  operationTitle,
  pendingOffset,
  pageSize,
  error,
  diff,
  canEdit = false,
  canDelete = false,
  onEdit = () => undefined,
  onDelete = () => undefined,
  onClear
}: StepInspectionPanelProps) {
  const [confirmingDelete, setConfirmingDelete] = useState(false);
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
        <div className="inspectionActions">
          {canEdit && !confirmingDelete && (
            <button type="button" className="secondaryButton" onClick={onEdit}>
              Edit step
            </button>
          )}
          {canDelete && !confirmingDelete && (
            <button type="button" className="secondaryButton" onClick={() => setConfirmingDelete(true)}>
              Delete step
            </button>
          )}
          {canDelete && confirmingDelete && (
            <div role="group" aria-label="Confirm step deletion">
              <span>Delete this step and replay every later step?</span>
              <button type="button" className="secondaryButton" onClick={() => setConfirmingDelete(false)}>
                Cancel
              </button>
              <button type="button" onClick={onDelete}>
                Delete
              </button>
            </div>
          )}
          <button type="button" className="secondaryButton" onClick={() => onClear()}>
            Show confirmed data
          </button>
        </div>
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
