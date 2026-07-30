interface NotebookOutputShape {
  readonly items: readonly {
    readonly mime: string;
  }[];
}

const NOTEBOOK_ERROR_MIME = "application/vnd.code.notebook.error";

export function releasedNotebookOutputClassification(outputs: readonly NotebookOutputShape[]): string {
  return outputs.some((output) => output.items.some((item) => item.mime === NOTEBOOK_ERROR_MIME))
    ? "notebook-error-output"
    : "no-notebook-error-output";
}

export function releasedNotebookExecutionFailureMessage(
  cellIndex: number,
  outputs: readonly NotebookOutputShape[]
): string {
  if (!Number.isSafeInteger(cellIndex) || cellIndex < 0) {
    throw new Error("A released-Jupyter notebook failure requires one valid cell index.");
  }
  return `Released-Jupyter cell ${cellIndex} failed (${releasedNotebookOutputClassification(outputs)}).`;
}
