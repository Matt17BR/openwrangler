export const REMOTE_R_JUPYTER_SELECTOR = "remote-r-jupyter";
export const CATEGORICAL_R_JUPYTER_SELECTOR = "categorical-operations";
export const VALUE_R_JUPYTER_SELECTOR = "value-operations";

const R_JUPYTER_SELECTORS = new Set([
  CATEGORICAL_R_JUPYTER_SELECTOR,
  VALUE_R_JUPYTER_SELECTOR,
  "interactive-terminal",
  "literate-documents",
  REMOTE_R_JUPYTER_SELECTOR
]);

export function resolvePackagedRJourneySelection({
  acceptanceMode,
  selector,
  requestedEditors,
  remoteJupyterEnabled,
  platform
}) {
  if (selector !== undefined && !R_JUPYTER_SELECTORS.has(selector)) {
    throw new Error(
      'OPEN_WRANGLER_PACKAGED_R_JOURNEY must be unset, "categorical-operations", "value-operations", "interactive-terminal", "literate-documents", or "remote-r-jupyter".'
    );
  }
  if (selector !== undefined && acceptanceMode !== "r-jupyter") {
    throw new Error('OPEN_WRANGLER_PACKAGED_R_JOURNEY requires OPEN_WRANGLER_PACKAGED_MODE="r-jupyter".');
  }
  if (acceptanceMode !== "r-jupyter") {
    return Object.freeze({
      local: false,
      remote: false,
      remoteOnly: false,
      requiresHostR: false,
      literateDocuments: false,
      nativeEditorTooling: false
    });
  }
  if (
    !Array.isArray(requestedEditors) ||
    requestedEditors.length === 0 ||
    requestedEditors.length > 2 ||
    new Set(requestedEditors).size !== requestedEditors.length ||
    requestedEditors.some((key) => key !== "vscode" && key !== "cursor")
  ) {
    throw new Error(
      'OPEN_WRANGLER_PACKAGED_MODE="r-jupyter" requires an explicit, duplicate-free VS Code/Cursor list in OPEN_WRANGLER_PACKAGED_EDITORS.'
    );
  }

  const remoteOnly = selector === REMOTE_R_JUPYTER_SELECTOR;
  if (remoteOnly) {
    if (!remoteJupyterEnabled) {
      throw new Error('OPEN_WRANGLER_PACKAGED_R_JOURNEY="remote-r-jupyter" requires real remote-Jupyter acceptance.');
    }
    if (platform !== "linux" || requestedEditors.length !== 1 || requestedEditors[0] !== "vscode") {
      throw new Error(
        'OPEN_WRANGLER_PACKAGED_R_JOURNEY="remote-r-jupyter" is Linux-only and requires exactly VS Code.'
      );
    }
    return Object.freeze({
      local: false,
      remote: true,
      remoteOnly: true,
      requiresHostR: false,
      literateDocuments: false,
      nativeEditorTooling: false
    });
  }
  if (selector !== undefined && remoteJupyterEnabled) {
    throw new Error("OPEN_WRANGLER_PACKAGED_R_JOURNEY cannot be combined with remote Jupyter acceptance.");
  }
  if (remoteJupyterEnabled && !requestedEditors.includes("vscode")) {
    throw new Error(
      "Remote R acceptance requires VS Code in OPEN_WRANGLER_PACKAGED_EDITORS; local R acceptance may also include Cursor."
    );
  }
  return Object.freeze({
    local: true,
    remote: remoteJupyterEnabled,
    remoteOnly: false,
    requiresHostR: true,
    literateDocuments: selector === "literate-documents",
    nativeEditorTooling: selector === "interactive-terminal" || selector === "literate-documents"
  });
}
