import { createHash } from "node:crypto";
import * as vscode from "vscode";
import {
  isNotebookLiveResultHandle,
  isPythonIdentifier,
  normalizeNotebookOutputPayload,
  type NotebookOutputPayload
} from "../../shared/notebookOutput";
import { getSetting } from "../configuration";
import { SessionCoordinator } from "../sessionCoordinator";
import { OpenWranglerPanel } from "../webviewPanel";
import {
  KernelBridge,
  shouldRegisterNotebookFormatters,
  type ExecutedNotebookCellResultBinding,
  type NotebookPreviewProvider
} from "./kernelBridge";
import { type InlineNotebookCellResultBinding, NotebookCellResultTracker } from "./notebookCellResult";
import { isSoleOpenNotebookDocument } from "./notebookProvenance";
import { captureSessionSourceFiles } from "../sessionOrigin";
import type { SessionSourceProtection } from "../files/safeFileExport";

interface OpenInOpenWranglerMessage {
  kind: "openInOpenWrangler";
  payload: unknown;
}

const INLINE_UPGRADE_RENDERER_ID = "openWrangler.inlineHtmlUpgrade";
const DATA_WRANGLER_EXTENSION_ID = "ms-toolsai.datawrangler";
const INLINE_UPGRADE_PROTOCOL = 1;
const INLINE_UPGRADE_MAX_HTML_BYTES = 32 * 1024;
const INLINE_UPGRADE_MAX_COLUMNS = 256;
const INLINE_UPGRADE_MAX_OPERATIONS = 8;
const INLINE_UPGRADE_MAX_OPERATIONS_PER_EDITOR = INLINE_UPGRADE_MAX_OPERATIONS - 1;
const INLINE_UPGRADE_MAX_RETAINED = 128;
const INLINE_UPGRADE_MAX_RETIRED_RECEIPTS = 128;
const INLINE_UPGRADE_MAX_ACTIONS = INLINE_UPGRADE_MAX_OPERATIONS;
const INLINE_UPGRADE_MAX_TERMINAL_SENDS = INLINE_UPGRADE_MAX_OPERATIONS;
const INLINE_UPGRADE_PREPUBLICATION_DEADLINE_MS = 10_000;
const INLINE_UPGRADE_ACTION_DEADLINE_MS = 10_000;

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
  action?: InlineUpgradeAction;
  permitsSettlingReplacement: boolean;
  providerSelected: boolean;
  active: boolean;
  published: boolean;
}

interface InlineUpgradePublishedReceipt {
  readonly payloadSha256: string;
  readonly source: Readonly<{ label: string; variableName: string }>;
}

interface InlineUpgradeAction {
  readonly operation: InlineUpgradeOperation;
  deadline?: ReturnType<typeof setTimeout>;
  active: boolean;
}

interface InlineUpgradeTerminalSend {
  readonly key: string;
}

export interface NotebookPreviewProviderPrompt {
  requestProviderPrompt(notebook: vscode.NotebookDocument, ownerIsCurrent: () => Promise<boolean>): Promise<boolean>;
}

interface InlineUpgradeState {
  readonly operations: Map<string, InlineUpgradeOperation>;
  readonly workQueue: InlineUpgradeOperation[];
  readonly settlingWork: Set<InlineUpgradeOperation>;
  readonly retiredTokens: Set<string>;
  readonly actions: Set<InlineUpgradeAction>;
  readonly terminalSends: Map<string, InlineUpgradeTerminalSend>;
  readonly editorOwners: WeakMap<vscode.NotebookEditor, number>;
  nextOwnerId: number;
  disposed: boolean;
}

export function registerNotebookRendererMessaging(
  context: vscode.ExtensionContext,
  coordinator: SessionCoordinator,
  tracker?: NotebookCellResultTracker,
  providerPrompt?: NotebookPreviewProviderPrompt
): void {
  const state: InlineUpgradeState = {
    operations: new Map<string, InlineUpgradeOperation>(),
    workQueue: [],
    settlingWork: new Set<InlineUpgradeOperation>(),
    retiredTokens: new Set<string>(),
    actions: new Set<InlineUpgradeAction>(),
    terminalSends: new Map<string, InlineUpgradeTerminalSend>(),
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
          const inlineToken = inlineUpgradeActionToken(message);
          if (tracker && (inlineUpgrade || inlineToken !== undefined)) {
            if (inlineToken !== undefined) {
              openOwnedInlineUpgrade(context, coordinator, state, editor, inlineToken, message);
            }
            return;
          }
          openLinkedNotebookResult(context, coordinator, editor, message);
          return;
        }
        if (tracker) receiveInlineUpgradeMessage(context, tracker, providerPrompt, messaging, state, editor, message);
      })
    );
  }
  if (tracker) {
    const revalidate = (): void => {
      const provider = inlineUpgradeProviderState();
      for (const operation of [...state.operations.values()]) {
        const editor = operation.editor;
        if (
          !editor ||
          !originatingNotebook(editor) ||
          (operation.binding && !operation.binding.isCurrent()) ||
          provider === "foreign" ||
          (provider === "conflict" && !providerPrompt) ||
          (provider === "conflict" && operation.published && !operation.providerSelected)
        ) {
          terminateInlineUpgradeOperation(state, operation);
        }
      }
    };
    context.subscriptions.push(
      vscode.workspace.onDidChangeConfiguration((event) => {
        if (!event.affectsConfiguration("openWrangler.notebookPreviewProvider")) return;
        if (inlineUpgradeProviderState() !== "owned") {
          for (const operation of state.operations.values()) operation.providerSelected = false;
        }
        revalidate();
      })
    );
    context.subscriptions.push(vscode.extensions.onDidChange(revalidate));
    context.subscriptions.push(vscode.window.onDidChangeVisibleNotebookEditors(revalidate));
    context.subscriptions.push({
      dispose: () => {
        for (const operation of [...state.operations.values()]) terminateInlineUpgradeOperation(state, operation);
        state.disposed = true;
        state.workQueue.length = 0;
        state.settlingWork.clear();
        state.actions.clear();
        state.retiredTokens.clear();
        state.terminalSends.clear();
      }
    });
  }
}

function inlineUpgradeActionToken(message: OpenInOpenWranglerMessage): string | undefined {
  try {
    const payload = message.payload as { metadata?: { sessionId?: unknown } };
    const sessionId = payload.metadata?.sessionId;
    return typeof sessionId === "string" && /^inline-[a-f0-9]{32}$/u.test(sessionId)
      ? sessionId.slice("inline-".length)
      : undefined;
  } catch {
    return undefined;
  }
}

function openOwnedInlineUpgrade(
  context: vscode.ExtensionContext,
  coordinator: SessionCoordinator,
  state: InlineUpgradeState,
  editor: vscode.NotebookEditor,
  token: string,
  message: OpenInOpenWranglerMessage
): void {
  const operation = state.operations.get(token);
  if (!operation || operation.editor !== editor) return;
  const receipt = operation.publishedReceipt;
  if (!operation.active || !operation.published || !receipt) {
    terminateInlineUpgradeOperation(state, operation);
    return;
  }
  if (operation.action) return;
  if (state.actions.size >= INLINE_UPGRADE_MAX_ACTIONS) {
    terminateInlineUpgradeOperation(state, operation);
    return;
  }
  const action: InlineUpgradeAction = { operation, active: true };
  operation.action = action;
  state.actions.add(action);
  action.deadline = setTimeout(() => expireInlineUpgradeAction(state, action), INLINE_UPGRADE_ACTION_DEADLINE_MS);
  action.deadline.unref?.();

  let payloadMatches = false;
  try {
    const payload = normalizeNotebookOutputPayload(message.payload);
    payloadMatches = payload !== undefined && canonicalNotebookOutputSha256(payload) === receipt.payloadSha256;
  } catch {
    payloadMatches = false;
  }
  if (!payloadMatches) {
    settleInlineUpgradeAction(state, action);
    terminateInlineUpgradeOperation(state, operation);
    return;
  }
  void completeOwnedInlineUpgradeAction(context, coordinator, state, action, receipt.source);
}

async function completeOwnedInlineUpgradeAction(
  context: vscode.ExtensionContext,
  coordinator: SessionCoordinator,
  state: InlineUpgradeState,
  action: InlineUpgradeAction,
  source: InlineUpgradePublishedReceipt["source"]
): Promise<void> {
  const operation = action.operation;
  try {
    const sourceProtection = operation.editor
      ? captureSessionSourceFiles({
          kind: "notebookVariable",
          label: "notebook",
          uri: operation.editor.notebook.uri.toString()
        })
      : Promise.resolve({ available: false } as const);
    await sourceProtection;
    if (!(await hasCurrentInlineUpgradeOwner(state, operation)) || !isInlineUpgradeActionCurrent(state, action)) {
      terminateInlineUpgradeOperation(state, operation);
      return;
    }
    const binding = operation.binding;
    const editor = operation.editor;
    if (!binding || !editor) {
      terminateInlineUpgradeOperation(state, operation);
      return;
    }
    // Connection selection is user-controlled; preparation bounds its own kernel work.
    if (action.deadline) clearTimeout(action.deadline);
    action.deadline = undefined;
    await openLinkedNotebookSource(
      context,
      coordinator,
      editor,
      source,
      binding.kernelBinding,
      sourceProtection,
      () => isInlineUpgradeActionCurrent(state, action) && isInlineUpgradeBindingCurrent(operation)
    );
  } finally {
    settleInlineUpgradeAction(state, action);
  }
}

function inlineUpgradeProviderState(): "owned" | "conflict" | "foreign" {
  if (shouldRegisterNotebookFormatters()) return "owned";
  const preference = getSetting<NotebookPreviewProvider>("notebookPreviewProvider", "ask");
  return preference === "ask" && vscode.extensions.getExtension(DATA_WRANGLER_EXTENSION_ID) !== undefined
    ? "conflict"
    : "foreign";
}

function inlineUpgradeProviderIsOwned(operation: InlineUpgradeOperation): boolean {
  const provider = inlineUpgradeProviderState();
  return provider === "owned" || (provider === "conflict" && operation.providerSelected);
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

  void openLinkedNotebookSource(context, coordinator, editor, payload.metadata.source, requiredKernelBinding);
}

async function openLinkedNotebookSource(
  context: vscode.ExtensionContext,
  coordinator: SessionCoordinator,
  editor: vscode.NotebookEditor,
  source: Readonly<{ label: string; variableName?: string }>,
  requiredKernelBinding?: ExecutedNotebookCellResultBinding,
  sourceProtection?: Promise<SessionSourceProtection>,
  isCurrent: () => boolean = () => true
): Promise<void> {
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

  let delegate: KernelBridge | undefined;
  try {
    const label = isNotebookLiveResultHandle(variableName) ? source.label : variableName;
    const liveSource = { kind: "notebookVariable" as const, label, variableName, uri: notebook.uri.toString() };
    const retainedProtection = sourceProtection ?? captureSessionSourceFiles(liveSource);
    delegate = new KernelBridge(context, notebook, shouldRegisterNotebookFormatters(), {}, requiredKernelBinding);
    const prepared = await delegate.prepareLiveSource(liveSource);
    if (
      !prepared ||
      originatingNotebook(editor) !== notebook ||
      !isSoleOpenNotebookDocument(notebook) ||
      !isCurrent()
    ) {
      delegate.dispose();
      return;
    }
    const bridge = coordinator.createBridge(delegate, notebook, retainedProtection);
    if (prepared.backend === undefined) OpenWranglerPanel.create(context, bridge, prepared.source);
    else OpenWranglerPanel.create(context, bridge, prepared.source, prepared.backend);
  } catch (error) {
    delegate?.dispose();
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
  providerPrompt: NotebookPreviewProviderPrompt | undefined,
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
  if (!originatingNotebook(editor)) return;
  const provider = inlineUpgradeProviderState();
  if (provider === "foreign" || (provider === "conflict" && !providerPrompt)) {
    postInlineUpgradeTerminal(state, messaging, editor, candidate);
    return;
  }
  if (state.retiredTokens.has(candidate.token)) {
    postInlineUpgradeTerminal(state, messaging, editor, candidate);
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
    if (!exactReplay) postInlineUpgradeTerminal(state, messaging, editor, candidate);
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
    providerSelected: false,
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
  pumpInlineUpgradeWork(context, tracker, providerPrompt, state);
}

function pumpInlineUpgradeWork(
  context: vscode.ExtensionContext,
  tracker: NotebookCellResultTracker,
  providerPrompt: NotebookPreviewProviderPrompt | undefined,
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
    void runInlineUpgradeWork(context, tracker, providerPrompt, state, operation).finally(() => {
      state.settlingWork.delete(operation);
      if (!operation.published && operation.active) terminateInlineUpgradeOperation(state, operation);
      pumpInlineUpgradeWork(context, tracker, providerPrompt, state);
    });
  }
}

async function runInlineUpgradeWork(
  context: vscode.ExtensionContext,
  tracker: NotebookCellResultTracker,
  providerPrompt: NotebookPreviewProviderPrompt | undefined,
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
    if (
      binding.editor !== editor ||
      binding.notebook !== editor.notebook ||
      !isAutomaticInlineUpgradeBackend(binding) ||
      !binding.isCurrent()
    ) {
      terminateInlineUpgradeOperation(state, operation);
      return;
    }
    if (!(await hasCurrentInlineUpgradeOwner(state, operation))) return;
    const provider = inlineUpgradeProviderState();
    if (provider === "conflict") {
      if (!providerPrompt) return;
      if (!(await postInlineUpgradeRetain(operation)) || !(await hasCurrentInlineUpgradeOwner(state, operation))) {
        return;
      }
      if (operation.deadline) clearTimeout(operation.deadline);
      operation.deadline = undefined;
      const selected = await providerPrompt.requestProviderPrompt(binding.notebook, () =>
        hasCurrentInlineUpgradeOwner(state, operation)
      );
      if (!selected || !(await hasCurrentInlineUpgradeOwner(state, operation))) return;
      operation.providerSelected = true;
      operation.deadline = setTimeout(
        () => terminateInlineUpgradeOperation(state, operation),
        INLINE_UPGRADE_PREPUBLICATION_DEADLINE_MS
      );
      operation.deadline.unref?.();
    } else if (provider !== "owned") {
      return;
    }
    if (!inlineUpgradeProviderIsOwned(operation)) return;
    const payload = await createInlineUpgradePayload(context, operation);
    if (
      !payload ||
      !inlineUpgradeProviderIsOwned(operation) ||
      !(await hasCurrentInlineUpgradeOwner(state, operation))
    ) {
      return;
    }
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
    if (
      !posted ||
      !inlineUpgradeProviderIsOwned(operation) ||
      !(await hasCurrentInlineUpgradeOwner(state, operation))
    ) {
      return;
    }
    operation.publishedReceipt = publishedReceipt;
    operation.published = true;
    if (!(await hasCurrentInlineUpgradeOwner(state, operation))) {
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

async function postInlineUpgradeRetain(operation: InlineUpgradeOperation): Promise<boolean> {
  const messaging = operation.messaging;
  const editor = operation.editor;
  if (!messaging || !editor || !operation.active || operation.cancellation.token.isCancellationRequested) return false;
  try {
    return await messaging.postMessage(
      {
        kind: "openWrangler.inlineRetain",
        protocol: INLINE_UPGRADE_PROTOCOL,
        token: operation.candidate.token,
        outputItemId: operation.candidate.outputItemId,
        byteLength: operation.candidate.byteLength,
        sha256: operation.candidate.sha256
      },
      editor
    );
  } catch {
    return false;
  }
}

function isAutomaticInlineUpgradeBackend(binding: InlineNotebookCellResultBinding): boolean {
  const backend = binding.kernelBinding.backend;
  return backend === "pandas" || backend === "polars" || backend === "duckdb";
}

async function createInlineUpgradePayload(
  context: vscode.ExtensionContext,
  operation: InlineUpgradeOperation
): Promise<NotebookOutputPayload | undefined> {
  const binding = operation.binding;
  if (!binding || !(await hasCurrentInlineUpgradeKernel(operation))) return undefined;
  const bridge = new KernelBridge(context, binding.notebook, true, {}, binding.kernelBinding);
  let payload: NotebookOutputPayload | undefined;
  try {
    const captured = await bridge.captureExecutedCellResult(
      binding.executionOrder,
      binding.sourceFingerprint,
      binding.kernelBinding,
      { maxColumns: INLINE_UPGRADE_MAX_COLUMNS }
    );
    if (!(await hasCurrentInlineUpgradeKernel(operation)) || captured.backend === "pyspark") return undefined;
    if (!captured.payload || captured.payload.metadata.schema.length > INLINE_UPGRADE_MAX_COLUMNS) return undefined;
    const snapshot = {
      ...captured.payload,
      metadata: { ...captured.payload.metadata, sessionId: `inline-${operation.candidate.token}` },
      summaries: []
    };
    payload = normalizeNotebookOutputPayload(snapshot);
    if (!payload || !isInlineUpgradeBindingCurrent(operation)) return undefined;
  } finally {
    bridge.dispose();
  }
  return !(await hasCurrentInlineUpgradeKernel(operation)) ? undefined : payload;
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
    operation.active && !operation.cancellation.token.isCancellationRequested && operation.binding?.isCurrent() === true
  );
}

async function hasCurrentInlineUpgradeOwner(
  state: InlineUpgradeState,
  operation: InlineUpgradeOperation
): Promise<boolean> {
  const binding = operation.binding;
  const editor = operation.editor;
  if (
    !binding ||
    !editor ||
    binding.editor !== editor ||
    binding.notebook !== editor.notebook ||
    originatingNotebook(editor) !== binding.notebook ||
    !isInlineUpgradeOperationCurrent(state.operations, operation)
  ) {
    return false;
  }
  if (!(await hasCurrentInlineUpgradeKernel(operation))) return false;
  return (
    binding.editor === operation.editor &&
    binding.notebook === operation.editor?.notebook &&
    originatingNotebook(editor) === binding.notebook &&
    isInlineUpgradeOperationCurrent(state.operations, operation)
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

function isInlineUpgradeActionCurrent(state: InlineUpgradeState, action: InlineUpgradeAction): boolean {
  const operation = action.operation;
  return (
    action.active &&
    operation.action === action &&
    state.actions.has(action) &&
    isInlineUpgradeOperationCurrent(state.operations, operation)
  );
}

function cancelInlineUpgradeAction(action: InlineUpgradeAction): void {
  action.active = false;
  if (action.deadline) clearTimeout(action.deadline);
  action.deadline = undefined;
}

function settleInlineUpgradeAction(state: InlineUpgradeState, action: InlineUpgradeAction): void {
  cancelInlineUpgradeAction(action);
  state.actions.delete(action);
  if (action.operation.action === action) action.operation.action = undefined;
}

function expireInlineUpgradeAction(state: InlineUpgradeState, action: InlineUpgradeAction): void {
  if (!action.active) return;
  cancelInlineUpgradeAction(action);
  terminateInlineUpgradeOperation(state, action.operation);
}

function settleInlineUpgradeTerminalSend(state: InlineUpgradeState, send: InlineUpgradeTerminalSend): void {
  if (state.terminalSends.get(send.key) === send) state.terminalSends.delete(send.key);
}

function terminateInlineUpgradeOperation(state: InlineUpgradeState, operation: InlineUpgradeOperation): void {
  if (!operation.active) return;
  const editor = operation.editor;
  const messaging = operation.messaging;
  operation.active = false;
  if (operation.action) cancelInlineUpgradeAction(operation.action);
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
  if (messaging && editor) postInlineUpgradeTerminal(state, messaging, editor, operation.candidate);
}

function postInlineUpgradeTerminal(
  state: InlineUpgradeState,
  messaging: ReturnType<typeof vscode.notebooks.createRendererMessaging>,
  editor: vscode.NotebookEditor,
  candidate: InlineUpgradeCandidateMessage
): void {
  if (state.disposed) return;
  const key = JSON.stringify([candidate.token, candidate.outputItemId, candidate.byteLength, candidate.sha256]);
  if (state.terminalSends.has(key) || state.terminalSends.size >= INLINE_UPGRADE_MAX_TERMINAL_SENDS) return;
  const send: InlineUpgradeTerminalSend = { key };
  state.terminalSends.set(key, send);
  let posted: Thenable<boolean>;
  try {
    posted = messaging.postMessage(
      {
        kind: "openWrangler.inlineRevoke",
        protocol: INLINE_UPGRADE_PROTOCOL,
        token: candidate.token,
        outputItemId: candidate.outputItemId,
        byteLength: candidate.byteLength,
        sha256: candidate.sha256
      },
      editor
    );
  } catch {
    settleInlineUpgradeTerminalSend(state, send);
    return;
  }
  void Promise.resolve(posted).then(
    () => settleInlineUpgradeTerminalSend(state, send),
    () => settleInlineUpgradeTerminalSend(state, send)
  );
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
