import * as vscode from "vscode";
import type { SessionOpenedResponse } from "../../shared/protocol";
import { PythonBridge } from "../pythonBridge";
import { DataExplorerPanel } from "../webviewPanel";
import { KernelBridge } from "./kernelBridge";

interface OpenInDataExplorerMessage {
  kind: "openInDataExplorer";
  payload: {
    metadata: SessionOpenedResponse["metadata"];
    page: SessionOpenedResponse["page"];
    summaries: SessionOpenedResponse["summaries"];
  };
}

export function registerNotebookRendererMessaging(context: vscode.ExtensionContext, bridge: PythonBridge): void {
  const messaging = vscode.notebooks.createRendererMessaging("dataExplorer.renderer");
  context.subscriptions.push(
    messaging.onDidReceiveMessage(({ message }) => {
      if (!isOpenInDataExplorerMessage(message)) {
        return;
      }

      const notebook = vscode.window.activeNotebookEditor?.notebook.uri;
      const variableName = message.payload.metadata.source.variableName;
      if (notebook && variableName && isPythonIdentifier(variableName)) {
        const panel = DataExplorerPanel.create(
          context,
          new KernelBridge(context, notebook),
          {
            kind: "notebookVariable",
            label: variableName,
            variableName
          },
          message.payload.metadata.backend
        );
        void panel.open();
        return;
      }

      DataExplorerPanel.createFromPayload(context, bridge, {
        kind: "sessionOpened",
        ...message.payload
      });
    })
  );
}

function isOpenInDataExplorerMessage(message: unknown): message is OpenInDataExplorerMessage {
  if (typeof message !== "object" || message === null) {
    return false;
  }
  const candidate = message as { kind?: unknown; payload?: unknown };
  return candidate.kind === "openInDataExplorer" && typeof candidate.payload === "object" && candidate.payload !== null;
}

function isPythonIdentifier(value: string): boolean {
  return /^[A-Za-z_][A-Za-z0-9_]*$/.test(value);
}
