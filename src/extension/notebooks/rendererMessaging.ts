import * as vscode from "vscode";
import type { SessionOpenedResponse } from "../../shared/protocol";
import { PythonBridge } from "../pythonBridge";
import { DataExplorerPanel } from "../webviewPanel";

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
