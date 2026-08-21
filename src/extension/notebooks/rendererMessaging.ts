import { createHash } from "node:crypto";
import * as vscode from "vscode";
import {
  NOTEBOOK_OUTPUT_DEFAULT_CAPTURE_ROWS,
  NOTEBOOK_OUTPUT_LIMITS,
  isNotebookLiveResultHandle,
  isPythonIdentifier,
  normalizeNotebookOutputPayload,
  type NotebookOutputPayload
} from "../../shared/notebookOutput";
import { SessionCoordinator } from "../sessionCoordinator";
import { responseMismatch, sessionOpenedResponseMismatch } from "../sessionResponseValidation";
import { OpenWranglerPanel } from "../webviewPanel";
import { KernelBridge, shouldRegisterNotebookFormatters, type ExecutedNotebookCellResultBinding } from "./kernelBridge";
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
const INLINE_UPGRADE_MAX_OPERATIONS_PER_EDITOR = INLINE_UPGRADE_MAX_OPERATIONS - 1;
const INLINE_UPGRADE_MAX_RETAINED = 128;
const INLINE_UPGRADE_MAX_RETIRED_RECEIPTS = 128;
const INLINE_UPGRADE_PREPUBLICATION_DEADLINE_MS = 10_000;

interface InlineUpgradeCandidateMessage {
  readonly kind: "openWrangler.inlineCandidate";
  readonly protocol: 1;
  readonly token: string;
  readonly outputItemId: string;
  readonly byteLength: number;
  readonly sha256: string;
}

interface InlineUpgradeOperation {
  readonly ownerId: number;
  readonly candidate: InlineUpgradeCandidateMessage;
  readonly cancellation: vscode.CancellationTokenSource;
  editor?: vscode.NotebookEditor;
  messaging?: ReturnType<typeof vscode.notebooks.createRendererMessaging>;
  binding?: InlineNotebookCellResultBinding;
  bindingInvalidation?: vscode.Disposable;
  deadline?: ReturnType<typeof setTimeout>;
  publishedReceipt?: InlineUpgradePublishedReceipt;
  permitsSettlingReplacement: boolean;
  active: boolean;
  published: boolean;
}

interface InlineUpgradePublishedReceipt {
  readonly payloadSha256: string;
  readonly source: Readonly<{ label: string; variableName: string }>;
}

interface InlineUpgradeState {
  readonly operations: Map<string, InlineUpgradeOperation>;
  readonly workQueue: InlineUpgradeOperation[];
  readonly settlingWork: Set<InlineUpgradeOperation>;
  readonly retiredTokens: Set<string>;
  readonly editorOwners: WeakMap<vscode.NotebookEditor, number>;
  nextOwnerId: number;
  disposed: boolean;
}

export function registerNotebookRendererMessaging(
  context: vscode.ExtensionContext,
  coordinator: SessionCoordinator,
  tracker?: NotebookCellResultTracker
): void {
  const state: InlineUpgradeState = {
    operations: new Map<string, InlineUpgradeOperation>(),
    workQueue: [],
    settlingWork: new Set<InlineUpgradeOperation>(),
    retiredTokens: new Set<string>(),
    editorOwners: new WeakMap<vscode.NotebookEditor, number>(),
    nextOwnerId: 1,
    disposed: false
  };
  const rendererChannels = [
    { messaging: vscode.notebooks.createRendererMessaging("openWrangler.renderer"), inlineUpgrade: false }
  ];
  if (tracker) {
    rendererChannels.push({
      messaging: vscode.notebooks.createRendererMessaging(INLINE_UPGRADE_RENDERER_ID),
      inlineUpgrade: true
    });
  }
  for (const { messaging, inlineUpgrade } of rendererChannels) {
    context.subscriptions.push(
      messaging.onDidReceiveMessage(({ editor, message }) => {
        if (state.disposed) return;
        if (isOpenInOpenWranglerMessage(message)) {
          if (tracker && (inlineUpgrade || isInlineUpgradeAction(message))) {
            void openOwnedInlineUpgrade(context, coordinator, state, editor, message);
            return;
          }
          openLinkedNotebookResult(context, coordinator, editor, message);
          return;
        }
        if (tracker) receiveInlineUpgradeMessage(context, tracker, messaging, state, editor, message);
      })
    );
  }
  if (tracker) {
    const revalidate = (): void => {
      for (const operation of [...state.operations.values()]) {
        const editor = operation.editor;
        if (
          !shouldRegisterNotebookFormatters() ||
          !editor ||
          !originatingNotebook(editor) ||
          (operation.binding && !operation.binding.isCurrent())
        ) {
          terminateInlineUpgradeOperation(state, operation);
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
        state.disposed = true;
        for (const operation of [...state.operations.values()]) terminateInlineUpgradeOperation(state, operation);
        state.workQueue.length = 0;
        state.settlingWork.clear();
        state.retiredTokens.clear();
      }
    });
  }
}

function isInlineUpgradeAction(message: OpenInOpenWranglerMessage): boolean {
  const payload = normalizeNotebookOutputPayload(message.payload);
  return (
    payload?.metadata.source.kind === "notebookOutput" && /^inline-[a-f0-9]{32}$/u.test(payload.metadata.sessionId)
  );
}

async function openOwnedInlineUpgrade(
  context: vscode.ExtensionContext,
  coordinator: SessionCoordinator,
  state: InlineUpgradeState,
  editor: vscode.NotebookEditor,
  message: OpenInOpenWranglerMessage
): Promise<void> {
  const payload = normalizeNotebookOutputPayload(message.payload);
  if (!payload) return;
  const token = payload.metadata.sessionId.slice("inline-".length);
  const operation = state.operations.get(token);
  if (!operation || operation.editor !== editor) return;
  const receipt = operation.publishedReceipt;
  if (
    !operation.active ||
    !operation.published ||
    !receipt ||
    canonicalNotebookOutputSha256(payload) !== receipt.payloadSha256 ||
    !(await hasCurrentInlineUpgradeKernel(operation)) ||
    !isInlineUpgradeOperationCurrent(state.operations, operation)
  ) {
    terminateInlineUpgradeOperation(state, operation);
    return;
  }
  const binding = operation.binding;
  const operationEditor = operation.editor;
  if (!binding || !operationEditor) {
    terminateInlineUpgradeOperation(state, operation);
    return;
  }
  openLinkedNotebookSource(context, coordinator, operationEditor, receipt.source, binding.kernelBinding);
}

function openLinkedNotebookResult(
  context: vscode.ExtensionContext,
  coordinator: SessionCoordinator,
  editor: vscode.NotebookEditor,
  message: OpenInOpenWranglerMessage,
  requiredKernelBinding?: ExecutedNotebookCellResultBinding
): void {
  const payload = normalizeNotebookOutputPayload(message.payload);
  if (!payload) {
    void vscode.window.showErrorMessage("This Open Wrangler notebook output is malformed or unsupported.");
    return;
  }

  openLinkedNotebookSource(context, coordinator, editor, payload.metadata.source, requiredKernelBinding);
}

function openLinkedNotebookSource(
  context: vscode.ExtensionContext,
  coordinator: SessionCoordinator,
  editor: vscode.NotebookEditor,
  source: Readonly<{ label: string; variableName?: string }>,
  requiredKernelBinding?: ExecutedNotebookCellResultBinding
): void {
  const notebook = originatingNotebook(editor);
  if (!notebook) {
    void vscode.window.showErrorMessage(
      "The notebook behind this preview is no longer open. Reopen it, run the cell that defines the dataframe, and try again."
    );
    return;
  }

  const variableName = source.variableName;
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
    const label = isNotebookLiveResultHandle(variableName) ? source.label : variableName;
    OpenWranglerPanel.create(
      context,
      coordinator.createBridge(
        new KernelBridge(context, notebook, shouldRegisterNotebookFormatters(), {}, requiredKernelBinding),
        notebook
      ),
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
  state: InlineUpgradeState,
  editor: vscode.NotebookEditor,
  message: unknown
): void {
  if (state.disposed) return;
  const cancellation = parseInlineUpgradeCancellation(message);
  if (cancellation) {
    const operation = state.operations.get(cancellation.token);
    if (operation?.editor === editor && operation.candidate.outputItemId === cancellation.outputItemId) {
      terminateInlineUpgradeOperation(state, operation);
    }
    return;
  }

  const candidate = parseInlineUpgradeCandidate(message);
  if (!candidate) return;
  const senderOwned = shouldRegisterNotebookFormatters() && originatingNotebook(editor);
  if (!senderOwned) return;
  if (state.retiredTokens.has(candidate.token)) {
    postInlineUpgradeTerminal(messaging, editor, candidate);
    return;
  }
  const collision =
    state.operations.get(candidate.token) ??
    [...state.operations.values()].find(
      (operation) => operation.editor === editor && operation.candidate.outputItemId === candidate.outputItemId
    );
  if (collision) {
    const exactReplay =
      collision.messaging === messaging &&
      collision.editor === editor &&
      sameInlineUpgradeCandidate(collision.candidate, candidate);
    collision.permitsSettlingReplacement = true;
    terminateInlineUpgradeOperation(state, collision);
    rememberRetiredInlineUpgradeToken(state, candidate.token);
    if (!exactReplay) postInlineUpgradeTerminal(messaging, editor, candidate);
    return;
  }
  if (state.operations.size >= INLINE_UPGRADE_MAX_RETAINED) {
    const oldest = state.operations.values().next().value as InlineUpgradeOperation | undefined;
    if (oldest) terminateInlineUpgradeOperation(state, oldest);
  }
  const operation: InlineUpgradeOperation = {
    ownerId: inlineUpgradeOwnerId(state, editor),
    editor,
    candidate,
    messaging,
    cancellation: new vscode.CancellationTokenSource(),
    permitsSettlingReplacement: false,
    active: true,
    published: false
  };
  state.operations.set(candidate.token, operation);
  operation.deadline = setTimeout(
    () => terminateInlineUpgradeOperation(state, operation),
    INLINE_UPGRADE_PREPUBLICATION_DEADLINE_MS
  );
  operation.deadline.unref?.();
  state.workQueue.push(operation);
  pumpInlineUpgradeWork(context, tracker, state);
}

function pumpInlineUpgradeWork(
  context: vscode.ExtensionContext,
  tracker: NotebookCellResultTracker,
  state: InlineUpgradeState
): void {
  if (state.disposed) return;
  while (state.settlingWork.size < INLINE_UPGRADE_MAX_OPERATIONS) {
    const queueIndex = state.workQueue.findIndex(
      (queued) =>
        [...state.settlingWork].filter((settling) => settling.ownerId === queued.ownerId).length <
        INLINE_UPGRADE_MAX_OPERATIONS_PER_EDITOR
    );
    if (queueIndex < 0) return;
    const [operation] = state.workQueue.splice(queueIndex, 1);
    if (!operation) return;
    if (!isInlineUpgradeOperationOwned(state.operations, operation)) continue;
    if (
      [...state.settlingWork].some(
        (settling) =>
          !settling.permitsSettlingReplacement &&
          settling.ownerId === operation.ownerId &&
          settling.candidate.outputItemId === operation.candidate.outputItemId
      )
    ) {
      terminateInlineUpgradeOperation(state, operation);
      continue;
    }
    state.settlingWork.add(operation);
    void runInlineUpgradeWork(context, tracker, state, operation).finally(() => {
      state.settlingWork.delete(operation);
      if (!operation.published && operation.active) terminateInlineUpgradeOperation(state, operation);
      pumpInlineUpgradeWork(context, tracker, state);
    });
  }
}

async function runInlineUpgradeWork(
  context: vscode.ExtensionContext,
  tracker: NotebookCellResultTracker,
  state: InlineUpgradeState,
  operation: InlineUpgradeOperation
): Promise<void> {
  try {
    const editor = operation.editor;
    if (!editor) return;
    const binding = await tracker.bindInlineUpgrade(
      editor,
      { byteLength: operation.candidate.byteLength, sha256: operation.candidate.sha256 },
      operation.cancellation.token
    );
    if (!binding || !isInlineUpgradeOperationOwned(state.operations, operation)) {
      binding?.dispose();
      if (!binding) terminateInlineUpgradeOperation(state, operation);
      return;
    }
    operation.binding = binding;
    operation.bindingInvalidation = binding.onDidInvalidate(() => terminateInlineUpgradeOperation(state, operation));
    if (!binding.isCurrent()) {
      terminateInlineUpgradeOperation(state, operation);
      return;
    }
    if (!(await hasCurrentInlineUpgradeKernel(operation))) return;
    const payload = await createInlineUpgradePayload(context, operation);
    if (!payload || !isInlineUpgradeOperationCurrent(state.operations, operation)) return;
    const publishedReceipt = createInlineUpgradePublishedReceipt(payload);
    if (!publishedReceipt) return;
    const messaging = operation.messaging;
    const publishedEditor = operation.editor;
    if (!messaging || !publishedEditor) return;
    const posted = await messaging.postMessage(
      {
        kind: "openWrangler.inlineUpgrade",
        protocol: INLINE_UPGRADE_PROTOCOL,
        token: operation.candidate.token,
        outputItemId: operation.candidate.outputItemId,
        byteLength: operation.candidate.byteLength,
        sha256: operation.candidate.sha256,
        payload
      },
      publishedEditor
    );
    if (!posted || !isInlineUpgradeOperationCurrent(state.operations, operation)) return;
    operation.publishedReceipt = publishedReceipt;
    operation.published = true;
    if (!(await hasCurrentInlineUpgradeKernel(operation))) {
      terminateInlineUpgradeOperation(state, operation);
      return;
    }
    if (operation.deadline) clearTimeout(operation.deadline);
    operation.deadline = undefined;
  } catch {
    // The terminal path below restores ordinary HTML without exposing details.
  } finally {
    if (operation.active && !operation.published) {
      terminateInlineUpgradeOperation(state, operation);
    }
  }
}

async function createInlineUpgradePayload(
  context: vscode.ExtensionContext,
  operation: InlineUpgradeOperation
): Promise<NotebookOutputPayload | undefined> {
  const binding = operation.binding;
  if (!binding || !(await hasCurrentInlineUpgradeKernel(operation))) return undefined;
  const bridge = new KernelBridge(context, binding.notebook, true, {}, binding.kernelBinding);
  let session: { readonly sessionId: string; readonly revision: number } | undefined;
  let payload: NotebookOutputPayload | undefined;
  let cleanupFailed = false;
  try {
    const captured = await bridge.captureExecutedCellResult(
      binding.executionOrder,
      binding.sourceFingerprint,
      binding.kernelBinding
    );
    if (!(await hasCurrentInlineUpgradeKernel(operation)) || captured.backend === "pyspark") return undefined;
    const requestedSessionId = `inline-session-${operation.candidate.token}`;
    const openRequest = {
      kind: "openSession" as const,
      source: {
        kind: "notebookVariable" as const,
        label: captured.label,
        variableName: captured.variableName,
        uri: binding.notebook.uri.toString()
      },
      backend: captured.backend,
      mode: "viewing" as const,
      pageSize: 1,
      columnOffset: 0,
      columnLimit: NOTEBOOK_OUTPUT_LIMITS.columns,
      requestedSessionId
    };
    session = { sessionId: requestedSessionId, revision: 0 };
    const opened = await bridge.request(openRequest, { cancellation: operation.cancellation.token });
    if (!(await hasCurrentInlineUpgradeKernel(operation))) return undefined;
    if (opened.kind !== "sessionOpened") return undefined;
    session = { sessionId: requestedSessionId, revision: opened.metadata.revision };
    if (
      sessionOpenedResponseMismatch(openRequest, opened, true) !== undefined ||
      opened.metadata.shape.rows === null ||
      opened.metadata.schema.length > NOTEBOOK_OUTPUT_LIMITS.columns
    ) {
      return undefined;
    }
    const columns = opened.metadata.schema.length;
    const pageLimit = Math.max(
      1,
      Math.min(
        NOTEBOOK_OUTPUT_DEFAULT_CAPTURE_ROWS,
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
    if (!(await hasCurrentInlineUpgradeKernel(operation))) return undefined;
    const pageMismatch = responseMismatch(pageRequest, page, session.sessionId, opened.metadata.schema);
    if (
      page.kind !== "page" ||
      pageMismatch !== undefined ||
      page.page.totalRows === null ||
      page.metadata.backend !== captured.backend
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
  return cleanupFailed || !(await hasCurrentInlineUpgradeKernel(operation)) ? undefined : payload;
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

async function hasCurrentInlineUpgradeKernel(operation: InlineUpgradeOperation): Promise<boolean> {
  const binding = operation.binding;
  if (!binding || !isInlineUpgradeBindingCurrent(operation)) return false;
  let current = false;
  try {
    current = await binding.hasCurrentKernel();
  } catch {
    return false;
  }
  return current && isInlineUpgradeBindingCurrent(operation);
}

function createInlineUpgradePublishedReceipt(
  payload: NotebookOutputPayload
): InlineUpgradePublishedReceipt | undefined {
  const source = payload.metadata.source;
  if (source.kind !== "notebookOutput" || !source.variableName) return undefined;
  return Object.freeze({
    payloadSha256: canonicalNotebookOutputSha256(payload),
    source: Object.freeze({ label: source.label, variableName: source.variableName })
  });
}

function canonicalNotebookOutputSha256(payload: NotebookOutputPayload): string {
  const digest = createHash("sha256");
  appendCanonicalJson(digest, payload);
  return digest.digest("hex");
}

function appendCanonicalJson(digest: ReturnType<typeof createHash>, value: unknown): void {
  if (value === null || typeof value === "string" || typeof value === "number" || typeof value === "boolean") {
    const encoded = JSON.stringify(value);
    if (encoded === undefined) throw new Error("Open Wrangler could not encode a canonical inline payload receipt.");
    digest.update(encoded, "utf8");
    return;
  }
  if (Array.isArray(value)) {
    digest.update("[");
    for (let index = 0; index < value.length; index += 1) {
      if (index > 0) digest.update(",");
      appendCanonicalJson(digest, value[index]);
    }
    digest.update("]");
    return;
  }
  if (typeof value !== "object") {
    throw new Error("Open Wrangler received a non-JSON inline payload after canonical validation.");
  }
  digest.update("{");
  const entries = Object.entries(value).sort(([left], [right]) => (left < right ? -1 : left > right ? 1 : 0));
  for (let index = 0; index < entries.length; index += 1) {
    if (index > 0) digest.update(",");
    const [key, nested] = entries[index]!;
    digest.update(JSON.stringify(key), "utf8");
    digest.update(":");
    appendCanonicalJson(digest, nested);
  }
  digest.update("}");
}

function sameInlineUpgradeCandidate(
  left: InlineUpgradeCandidateMessage,
  right: InlineUpgradeCandidateMessage
): boolean {
  return (
    left.token === right.token &&
    left.outputItemId === right.outputItemId &&
    left.byteLength === right.byteLength &&
    left.sha256 === right.sha256
  );
}

function inlineUpgradeOwnerId(state: InlineUpgradeState, editor: vscode.NotebookEditor): number {
  const existing = state.editorOwners.get(editor);
  if (existing !== undefined) return existing;
  const ownerId = state.nextOwnerId;
  state.nextOwnerId += 1;
  state.editorOwners.set(editor, ownerId);
  return ownerId;
}

function rememberRetiredInlineUpgradeToken(state: InlineUpgradeState, token: string): void {
  if (state.disposed || state.retiredTokens.has(token)) return;
  state.retiredTokens.add(token);
  if (state.retiredTokens.size <= INLINE_UPGRADE_MAX_RETIRED_RECEIPTS) return;
  const oldest = state.retiredTokens.values().next().value as string | undefined;
  if (oldest) state.retiredTokens.delete(oldest);
}

function terminateInlineUpgradeOperation(state: InlineUpgradeState, operation: InlineUpgradeOperation): void {
  if (!operation.active) return;
  const editor = operation.editor;
  const messaging = operation.messaging;
  operation.active = false;
  if (state.operations.get(operation.candidate.token) === operation) state.operations.delete(operation.candidate.token);
  rememberRetiredInlineUpgradeToken(state, operation.candidate.token);
  const queuedIndex = state.workQueue.indexOf(operation);
  if (queuedIndex >= 0) state.workQueue.splice(queuedIndex, 1);
  if (operation.deadline) clearTimeout(operation.deadline);
  operation.deadline = undefined;
  operation.cancellation.cancel();
  operation.cancellation.dispose();
  operation.bindingInvalidation?.dispose();
  operation.binding?.dispose();
  operation.bindingInvalidation = undefined;
  operation.binding = undefined;
  operation.publishedReceipt = undefined;
  operation.editor = undefined;
  operation.messaging = undefined;
  if (messaging && editor) postInlineUpgradeTerminal(messaging, editor, operation.candidate);
}

function postInlineUpgradeTerminal(
  messaging: ReturnType<typeof vscode.notebooks.createRendererMessaging>,
  editor: vscode.NotebookEditor,
  candidate: InlineUpgradeCandidateMessage
): void {
  void messaging
    .postMessage(
      {
        kind: "openWrangler.inlineRevoke",
        protocol: INLINE_UPGRADE_PROTOCOL,
        token: candidate.token,
        outputItemId: candidate.outputItemId,
        byteLength: candidate.byteLength,
        sha256: candidate.sha256
      },
      editor
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
