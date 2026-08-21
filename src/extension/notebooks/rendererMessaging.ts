import * as vscode from "vscode";
import {
  NOTEBOOK_OUTPUT_LIMITS,
  isNotebookLiveResultHandle,
  isPythonIdentifier,
  normalizeNotebookOutputPayload,
  type NotebookOutputPayload
} from "../../shared/notebookOutput";
import { SessionCoordinator } from "../sessionCoordinator";
import { OpenWranglerPanel } from "../webviewPanel";
import { KernelBridge, shouldRegisterNotebookFormatters } from "./kernelBridge";
import { type InlineNotebookCellResultBinding, NotebookCellResultTracker } from "./notebookCellResult";
import { isSoleOpenNotebookDocument } from "./notebookProvenance";

interface OpenInOpenWranglerMessage {
  kind: "openInOpenWrangler";
  payload: unknown;
}

const INLINE_UPGRADE_RENDERER_ID = "openWrangler.inlineHtmlUpgrade";
const INLINE_UPGRADE_PROTOCOL = 1;
const INLINE_UPGRADE_MAX_HTML_BYTES = 32 * 1024;
const INLINE_UPGRADE_MAX_OPERATIONS = 8;

interface InlineUpgradeCandidateMessage {
  readonly kind: "openWrangler.inlineCandidate";
  readonly protocol: 1;
  readonly token: string;
  readonly outputItemId: string;
  readonly byteLength: number;
  readonly sha256: string;
}

interface InlineUpgradeOperation {
  readonly editor: vscode.NotebookEditor;
  readonly candidate: InlineUpgradeCandidateMessage;
  readonly binding: InlineNotebookCellResultBinding;
  readonly cancellation: vscode.CancellationTokenSource;
  active: boolean;
}

export function registerNotebookRendererMessaging(
  context: vscode.ExtensionContext,
  coordinator: SessionCoordinator,
  tracker?: NotebookCellResultTracker
): void {
  const operations = new Map<string, InlineUpgradeOperation>();
  const rendererChannels = [vscode.notebooks.createRendererMessaging("openWrangler.renderer")];
  if (tracker) rendererChannels.push(vscode.notebooks.createRendererMessaging(INLINE_UPGRADE_RENDERER_ID));
  for (const messaging of rendererChannels) {
    context.subscriptions.push(
      messaging.onDidReceiveMessage(({ editor, message }) => {
        if (isOpenInOpenWranglerMessage(message)) {
          openLinkedNotebookResult(context, coordinator, editor, message);
          return;
        }
        if (tracker) receiveInlineUpgradeMessage(context, tracker, messaging, operations, editor, message);
      })
    );
  }
  if (tracker) {
    context.subscriptions.push({
      dispose: () => {
        for (const operation of [...operations.values()]) retireInlineUpgradeOperation(operations, operation);
      }
    });
  }
}

function openLinkedNotebookResult(
  context: vscode.ExtensionContext,
  coordinator: SessionCoordinator,
  editor: vscode.NotebookEditor,
  message: OpenInOpenWranglerMessage
): void {
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
    const label = isNotebookLiveResultHandle(variableName) ? payload.metadata.source.label : variableName;
    OpenWranglerPanel.create(
      context,
      coordinator.createBridge(new KernelBridge(context, notebook, shouldRegisterNotebookFormatters()), notebook),
      {
        kind: "notebookVariable",
        label,
        variableName,
        uri: notebook.uri.toString()
      }
    );
  } catch (error) {
    const detail = error instanceof Error ? ` ${error.message}` : "";
    const recovery = isNotebookLiveResultHandle(variableName)
      ? "run the cell again and try again."
      : `run the cell that defines ${variableName}, and try again.`;
    void vscode.window.showErrorMessage(
      `Open Wrangler could not access the live dataframe. Select or start the notebook's Python kernel, ${recovery}${detail}`
    );
  }
}

function receiveInlineUpgradeMessage(
  context: vscode.ExtensionContext,
  tracker: NotebookCellResultTracker,
  messaging: ReturnType<typeof vscode.notebooks.createRendererMessaging>,
  operations: Map<string, InlineUpgradeOperation>,
  editor: vscode.NotebookEditor,
  message: unknown
): void {
  const cancellation = parseInlineUpgradeCancellation(message);
  if (cancellation) {
    const operation = operations.get(cancellation.token);
    if (operation?.editor === editor && operation.candidate.outputItemId === cancellation.outputItemId) {
      retireInlineUpgradeOperation(operations, operation);
    }
    return;
  }

  const candidate = parseInlineUpgradeCandidate(message);
  if (
    !candidate ||
    operations.size >= INLINE_UPGRADE_MAX_OPERATIONS ||
    operations.has(candidate.token) ||
    !shouldRegisterNotebookFormatters() ||
    !originatingNotebook(editor)
  ) {
    return;
  }
  const binding = tracker.bindInlineUpgrade(editor, {
    byteLength: candidate.byteLength,
    sha256: candidate.sha256
  });
  if (!binding) return;
  const operation: InlineUpgradeOperation = {
    editor,
    candidate,
    binding,
    cancellation: new vscode.CancellationTokenSource(),
    active: true
  };
  operations.set(candidate.token, operation);
  void createInlineUpgradePayload(context, operation)
    .then(async (payload) => {
      if (!payload || !isInlineUpgradeOperationCurrent(operations, operation)) return;
      await messaging.postMessage(
        {
          kind: "openWrangler.inlineUpgrade",
          protocol: INLINE_UPGRADE_PROTOCOL,
          token: candidate.token,
          outputItemId: candidate.outputItemId,
          byteLength: candidate.byteLength,
          sha256: candidate.sha256,
          payload
        },
        editor
      );
    })
    .catch(() => undefined)
    .finally(() => retireInlineUpgradeOperation(operations, operation));
}

async function createInlineUpgradePayload(
  context: vscode.ExtensionContext,
  operation: InlineUpgradeOperation
): Promise<NotebookOutputPayload | undefined> {
  if (!isInlineUpgradeBindingCurrent(operation) || !(await operation.binding.hasCurrentKernel())) return undefined;
  if (!isInlineUpgradeBindingCurrent(operation)) return undefined;
  const bridge = new KernelBridge(context, operation.binding.notebook, true);
  let session: { readonly sessionId: string; readonly revision: number } | undefined;
  let payload: NotebookOutputPayload | undefined;
  let cleanupFailed = false;
  try {
    const captured = await bridge.captureExecutedCellResult(
      operation.binding.executionOrder,
      operation.binding.sourceFingerprint,
      operation.binding.kernelBinding
    );
    if (!isInlineUpgradeBindingCurrent(operation) || captured.backend === "pyspark") return undefined;
    const opened = await bridge.request(
      {
        kind: "openSession",
        source: {
          kind: "notebookVariable",
          label: captured.label,
          variableName: captured.variableName,
          uri: operation.binding.notebook.uri.toString()
        },
        backend: captured.backend,
        mode: "viewing",
        pageSize: 1,
        columnOffset: 0,
        columnLimit: NOTEBOOK_OUTPUT_LIMITS.columns
      },
      { cancellation: operation.cancellation.token }
    );
    if (opened.kind !== "sessionOpened") return undefined;
    session = { sessionId: opened.metadata.sessionId, revision: opened.metadata.revision };
    if (
      opened.metadata.backend !== captured.backend ||
      opened.metadata.shape.rows === null ||
      opened.metadata.schema.length > NOTEBOOK_OUTPUT_LIMITS.columns
    ) {
      return undefined;
    }
    if (!isInlineUpgradeBindingCurrent(operation)) return undefined;
    const columns = opened.metadata.schema.length;
    const pageLimit = Math.max(
      1,
      Math.min(
        NOTEBOOK_OUTPUT_LIMITS.rows,
        opened.metadata.shape.rows,
        Math.floor(NOTEBOOK_OUTPUT_LIMITS.cells / Math.max(1, columns))
      )
    );
    const page = await bridge.request(
      {
        kind: "getPage",
        sessionId: session.sessionId,
        revision: session.revision,
        viewRequestId: `inline-${operation.candidate.token}`,
        offset: 0,
        limit: pageLimit,
        columnOffset: 0,
        columnLimit: Math.max(1, columns),
        filterModel: { filters: [], sort: [] }
      },
      { cancellation: operation.cancellation.token, ephemeralPage: true }
    );
    if (
      page.kind !== "page" ||
      page.page.totalRows === null ||
      page.metadata.backend !== captured.backend ||
      page.metadata.sessionId !== session.sessionId ||
      page.revision !== page.metadata.revision ||
      !isInlineUpgradeBindingCurrent(operation)
    ) {
      return undefined;
    }
    session = { sessionId: page.metadata.sessionId, revision: page.metadata.revision };
    const snapshot = {
      mimeVersion: 2,
      metadata: savedInlineMetadata(page.metadata, captured.label, captured.variableName, operation.candidate.token),
      page: page.page,
      summaries: []
    };
    payload = normalizeNotebookOutputPayload(snapshot);
    if (!payload || !isInlineUpgradeBindingCurrent(operation)) return undefined;
  } finally {
    if (session) {
      try {
        const closed = await bridge.request(
          { kind: "closeSession", sessionId: session.sessionId, revision: session.revision },
          { startRuntimeIfNeeded: false, restartRuntimeOnTimeout: false }
        );
        cleanupFailed = closed.kind !== "sessionClosed";
      } catch {
        cleanupFailed = true;
      }
    }
    bridge.dispose();
  }
  return cleanupFailed || !isInlineUpgradeBindingCurrent(operation) ? undefined : payload;
}

function savedInlineMetadata(
  metadata: Extract<Awaited<ReturnType<KernelBridge["request"]>>, { kind: "page" }>["metadata"],
  label: string,
  variableName: string,
  token: string
) {
  return {
    protocolVersion: metadata.protocolVersion,
    sessionId: `inline-${token}`,
    revision: 0,
    backend: metadata.backend,
    mode: "viewing" as const,
    source: { kind: "notebookOutput" as const, label, variableName },
    capabilities: {
      editable: false,
      lazy: false,
      cancel: false,
      exportCsv: false,
      exportParquet: false,
      notebookInsert: false
    },
    shape: metadata.shape,
    filteredShape: { ...metadata.shape },
    schema: metadata.schema,
    ...(metadata.rowAxis ? { rowAxis: metadata.rowAxis } : {}),
    filterModel: { filters: [], sort: [] },
    steps: []
  };
}

function isInlineUpgradeOperationCurrent(
  operations: Map<string, InlineUpgradeOperation>,
  operation: InlineUpgradeOperation
): boolean {
  return operations.get(operation.candidate.token) === operation && isInlineUpgradeBindingCurrent(operation);
}

function isInlineUpgradeBindingCurrent(operation: InlineUpgradeOperation): boolean {
  return (
    operation.active &&
    !operation.cancellation.token.isCancellationRequested &&
    shouldRegisterNotebookFormatters() &&
    operation.binding.isCurrent()
  );
}

function retireInlineUpgradeOperation(
  operations: Map<string, InlineUpgradeOperation>,
  operation: InlineUpgradeOperation
): void {
  if (!operation.active) return;
  operation.active = false;
  if (operations.get(operation.candidate.token) === operation) operations.delete(operation.candidate.token);
  operation.cancellation.cancel();
  operation.cancellation.dispose();
  operation.binding.dispose();
}

function parseInlineUpgradeCandidate(message: unknown): InlineUpgradeCandidateMessage | undefined {
  if (typeof message !== "object" || message === null) return undefined;
  const candidate = message as Record<string, unknown>;
  if (
    candidate.kind !== "openWrangler.inlineCandidate" ||
    candidate.protocol !== INLINE_UPGRADE_PROTOCOL ||
    typeof candidate.token !== "string" ||
    candidate.token.length !== 32 ||
    !/^[a-f0-9]{32}$/u.test(candidate.token) ||
    typeof candidate.outputItemId !== "string" ||
    candidate.outputItemId.length === 0 ||
    candidate.outputItemId.length > 512 ||
    Array.from(candidate.outputItemId).length > 256 ||
    !Number.isSafeInteger(candidate.byteLength) ||
    (candidate.byteLength as number) < 1 ||
    (candidate.byteLength as number) > INLINE_UPGRADE_MAX_HTML_BYTES ||
    typeof candidate.sha256 !== "string" ||
    candidate.sha256.length !== 64 ||
    !/^[a-f0-9]{64}$/u.test(candidate.sha256) ||
    Object.keys(candidate).length !== 6
  ) {
    return undefined;
  }
  return candidate as unknown as InlineUpgradeCandidateMessage;
}

function parseInlineUpgradeCancellation(
  message: unknown
): { readonly token: string; readonly outputItemId: string } | undefined {
  if (typeof message !== "object" || message === null) return undefined;
  const candidate = message as Record<string, unknown>;
  if (
    candidate.kind !== "openWrangler.inlineCancel" ||
    candidate.protocol !== INLINE_UPGRADE_PROTOCOL ||
    typeof candidate.token !== "string" ||
    candidate.token.length !== 32 ||
    !/^[a-f0-9]{32}$/u.test(candidate.token) ||
    typeof candidate.outputItemId !== "string" ||
    candidate.outputItemId.length === 0 ||
    candidate.outputItemId.length > 512 ||
    Array.from(candidate.outputItemId).length > 256 ||
    Object.keys(candidate).length !== 4
  ) {
    return undefined;
  }
  return { token: candidate.token, outputItemId: candidate.outputItemId };
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
