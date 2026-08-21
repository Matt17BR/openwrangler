import * as vscode from "vscode";
import {
  NOTEBOOK_OUTPUT_LIMITS,
  isNotebookLiveResultHandle,
  isPythonIdentifier,
  normalizeNotebookOutputPayload,
  type NotebookOutputPayload
} from "../../shared/notebookOutput";
import { SessionCoordinator } from "../sessionCoordinator";
import { responseMismatch } from "../sessionResponseValidation";
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
const INLINE_UPGRADE_MAX_RETAINED = 128;

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
  readonly messaging: ReturnType<typeof vscode.notebooks.createRendererMessaging>;
  readonly cancellation: vscode.CancellationTokenSource;
  binding?: InlineNotebookCellResultBinding;
  bindingInvalidation?: vscode.Disposable;
  active: boolean;
  published: boolean;
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
    const revalidate = (): void => {
      for (const operation of [...operations.values()]) {
        if (
          !shouldRegisterNotebookFormatters() ||
          !originatingNotebook(operation.editor) ||
          (operation.binding && !operation.binding.isCurrent())
        ) {
          revokeInlineUpgradeOperation(operations, operation);
        }
      }
    };
    context.subscriptions.push(
      vscode.workspace.onDidChangeConfiguration((event) => {
        if (event.affectsConfiguration("openWrangler.notebookPreviewProvider")) revalidate();
      })
    );
    context.subscriptions.push(vscode.extensions.onDidChange(revalidate));
    context.subscriptions.push(vscode.window.onDidChangeVisibleNotebookEditors(revalidate));
    context.subscriptions.push({
      dispose: () => {
        for (const operation of [...operations.values()]) revokeInlineUpgradeOperation(operations, operation);
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
    operations.size >= INLINE_UPGRADE_MAX_RETAINED ||
    [...operations.values()].filter((operation) => !operation.published).length >= INLINE_UPGRADE_MAX_OPERATIONS ||
    operations.has(candidate.token) ||
    [...operations.values()].some(
      (operation) => operation.editor === editor && operation.candidate.outputItemId === candidate.outputItemId
    ) ||
    !shouldRegisterNotebookFormatters() ||
    !originatingNotebook(editor)
  ) {
    return;
  }
  const operation: InlineUpgradeOperation = {
    editor,
    candidate,
    messaging,
    cancellation: new vscode.CancellationTokenSource(),
    active: true,
    published: false
  };
  operations.set(candidate.token, operation);
  void (async () => {
    const binding = await tracker.bindInlineUpgrade(
      editor,
      { byteLength: candidate.byteLength, sha256: candidate.sha256 },
      operation.cancellation.token
    );
    if (!binding || !isInlineUpgradeOperationOwned(operations, operation)) {
      binding?.dispose();
      return;
    }
    operation.binding = binding;
    operation.bindingInvalidation = binding.onDidInvalidate(() => revokeInlineUpgradeOperation(operations, operation));
    if (!binding.isCurrent()) return;
    const payload = await createInlineUpgradePayload(context, operation);
    if (!payload || !isInlineUpgradeOperationCurrent(operations, operation)) return;
    const posted = await messaging.postMessage(
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
    if (!posted) return;
    if (!isInlineUpgradeOperationCurrent(operations, operation)) {
      postInlineUpgradeRevocation(operation);
      return;
    }
    operation.published = true;
  })()
    .catch(() => undefined)
    .finally(() => {
      if (!operation.published) retireInlineUpgradeOperation(operations, operation);
    });
}

async function createInlineUpgradePayload(
  context: vscode.ExtensionContext,
  operation: InlineUpgradeOperation
): Promise<NotebookOutputPayload | undefined> {
  const binding = operation.binding;
  if (!binding || !isInlineUpgradeBindingCurrent(operation) || !(await binding.hasCurrentKernel())) return undefined;
  if (!isInlineUpgradeBindingCurrent(operation)) return undefined;
  const bridge = new KernelBridge(context, binding.notebook, true);
  let session: { readonly sessionId: string; readonly revision: number } | undefined;
  let payload: NotebookOutputPayload | undefined;
  let cleanupFailed = false;
  try {
    const captured = await bridge.captureExecutedCellResult(
      binding.executionOrder,
      binding.sourceFingerprint,
      binding.kernelBinding
    );
    if (!isInlineUpgradeBindingCurrent(operation) || captured.backend === "pyspark") return undefined;
    const opened = await bridge.request(
      {
        kind: "openSession",
        source: {
          kind: "notebookVariable",
          label: captured.label,
          variableName: captured.variableName,
          uri: binding.notebook.uri.toString()
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
    const pageRequest = {
      kind: "getPage" as const,
      sessionId: session.sessionId,
      revision: session.revision,
      viewRequestId: `inline-${operation.candidate.token}`,
      offset: 0,
      limit: pageLimit,
      columnOffset: 0,
      columnLimit: Math.max(1, columns),
      filterModel: { filters: [], sort: [] }
    };
    const page = await bridge.request(pageRequest, { cancellation: operation.cancellation.token, ephemeralPage: true });
    if (
      page.kind !== "page" ||
      responseMismatch(pageRequest, page, session.sessionId, opened.metadata.schema) !== undefined ||
      page.page.totalRows === null ||
      page.metadata.backend !== captured.backend ||
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
        cleanupFailed = closed.kind !== "sessionClosed" || closed.sessionId !== session.sessionId;
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

function isInlineUpgradeOperationOwned(
  operations: Map<string, InlineUpgradeOperation>,
  operation: InlineUpgradeOperation
): boolean {
  return (
    operation.active &&
    !operation.cancellation.token.isCancellationRequested &&
    operations.get(operation.candidate.token) === operation
  );
}

function isInlineUpgradeBindingCurrent(operation: InlineUpgradeOperation): boolean {
  return (
    operation.active &&
    !operation.cancellation.token.isCancellationRequested &&
    shouldRegisterNotebookFormatters() &&
    operation.binding?.isCurrent() === true
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
  operation.bindingInvalidation?.dispose();
  operation.binding?.dispose();
}

function revokeInlineUpgradeOperation(
  operations: Map<string, InlineUpgradeOperation>,
  operation: InlineUpgradeOperation
): void {
  if (!operation.active) return;
  if (operation.published) postInlineUpgradeRevocation(operation);
  retireInlineUpgradeOperation(operations, operation);
}

function postInlineUpgradeRevocation(operation: InlineUpgradeOperation): void {
  void operation.messaging
    .postMessage(
      {
        kind: "openWrangler.inlineRevoke",
        protocol: INLINE_UPGRADE_PROTOCOL,
        token: operation.candidate.token,
        outputItemId: operation.candidate.outputItemId,
        byteLength: operation.candidate.byteLength,
        sha256: operation.candidate.sha256
      },
      operation.editor
    )
    .then(undefined, () => undefined);
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
