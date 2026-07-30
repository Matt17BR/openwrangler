import * as vscode from "vscode";
import { isPythonIdentifier, normalizeNotebookOutputPayload } from "../../shared/notebookOutput";
import { SessionCoordinator } from "../sessionCoordinator";
import { OpenWranglerPanel } from "../webviewPanel";
import { KernelBridge, shouldRegisterNotebookFormatters } from "./kernelBridge";
import { isSoleOpenNotebookDocument } from "./notebookProvenance";

interface OpenInOpenWranglerMessage {
  kind: "openInOpenWrangler";
  payload: unknown;
}

export function registerNotebookRendererMessaging(
  context: vscode.ExtensionContext,
  coordinator: SessionCoordinator
): void {
  const messaging = vscode.notebooks.createRendererMessaging("openWrangler.renderer");
  context.subscriptions.push(
    messaging.onDidReceiveMessage(({ editor, message }) => {
      if (!isOpenInOpenWranglerMessage(message)) {
        return;
      }
      const payload = normalizeNotebookOutputPayload(message.payload);
      if (!payload) {
        void vscode.window.showErrorMessage("This Open Wrangler notebook output is malformed or unsupported.");
        return;
      }

      const notebook = originatingNotebook(editor);
      if (!notebook) {
        void vscode.window.showErrorMessage(
          "The notebook behind this preview is no longer open. Reopen it, run the cell that defines the dataframe, and try again."
        );
        return;
      }

      const variableName = payload.metadata.source.variableName;
      if (!variableName || !isPythonIdentifier(variableName)) {
        void vscode.window.showErrorMessage(
          "This saved preview is not linked to a live dataframe. Run the cell again to create a fresh Open Wrangler preview, then try again."
        );
        return;
      }
      if (!isSoleOpenNotebookDocument(notebook)) {
        void vscode.window.showErrorMessage(
          "The notebook behind this preview is no longer uniquely open. Close duplicate or replacement notebook views, run the cell if needed, and try again."
        );
        return;
      }

      try {
        OpenWranglerPanel.create(
          context,
          coordinator.createBridge(new KernelBridge(context, notebook, shouldRegisterNotebookFormatters()), notebook),
          {
            kind: "notebookVariable",
            label: variableName,
            variableName,
            uri: notebook.uri.toString()
          }
        );
      } catch (error) {
        const detail = error instanceof Error ? ` ${error.message}` : "";
        void vscode.window.showErrorMessage(
          `Open Wrangler could not access the live dataframe. Select or start the notebook's Python kernel, run the cell that defines ${variableName}, and try again.${detail}`
        );
      }
    })
  );
}

function originatingNotebook(editor: vscode.NotebookEditor): vscode.NotebookDocument | undefined {
  const notebook = editor?.notebook;
  if (
    !notebook ||
    notebook.isClosed ||
    !vscode.window.visibleNotebookEditors.includes(editor) ||
    !vscode.workspace.notebookDocuments.includes(notebook)
  ) {
    return undefined;
  }
  return notebook;
}

function isOpenInOpenWranglerMessage(message: unknown): message is OpenInOpenWranglerMessage {
  if (typeof message !== "object" || message === null) {
    return false;
  }
  const candidate = message as { kind?: unknown; payload?: unknown };
  return candidate.kind === "openInOpenWrangler" && typeof candidate.payload === "object" && candidate.payload !== null;
}
