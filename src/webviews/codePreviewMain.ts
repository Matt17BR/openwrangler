import { defaultKeymap, history, historyKeymap } from "@codemirror/commands";
import { python } from "@codemirror/lang-python";
import { HighlightStyle, syntaxHighlighting } from "@codemirror/language";
import {
  EditorState,
  Transaction,
  type ChangeSet,
  type EditorSelection,
  type Extension,
  type Text
} from "@codemirror/state";
import { drawSelection, EditorView, highlightActiveLine, keymap, lineNumbers, type ViewUpdate } from "@codemirror/view";
import { tags } from "@lezer/highlight";
import {
  CODE_PREVIEW_EDIT_DEBOUNCE_MS,
  CODE_PREVIEW_MAX_EDIT_CHANGES,
  CODE_PREVIEW_MAX_UTF8_BYTES,
  isCanonicalCodePreviewText
} from "../shared/codePreviewLimits";
import { isCodePreviewHostMessage, type CodePreviewChange } from "../shared/codePreviewMessages";
import { codeDialectLanguageLabel, type CodeDialect, type RuntimeIdentity } from "../shared/runtimeIdentity";

interface VsCodeApi {
  postMessage(message: unknown): void;
}

declare function acquireVsCodeApi(): VsCodeApi;

const vscode = acquireVsCodeApi();
const host = document.querySelector<HTMLElement>("#root");
if (!host) throw new Error("Code Preview root was not found.");
publishRuntimeIdentity(host, null);

let applyingHostUpdate = false;
let editTimer: ReturnType<typeof setTimeout> | undefined;
let pageDisposed = false;
let bufferId: string | undefined;
let bufferVersion = 0;
let bufferInvalid = false;
let localEdit = false;
let pendingChanges: ChangeSet | undefined;
let currentCodeDialect: CodeDialect | null = null;
let currentEditable = false;
let currentLanguageLabel: "Python" | "R" | undefined;
let historyUtf8UpperBound = 0;
let historyResetPending = false;
const CODE_PREVIEW_HISTORY_UTF8_BUDGET = CODE_PREVIEW_MAX_UTF8_BYTES * 6;
const pythonHighlightStyle = HighlightStyle.define([
  { tag: [tags.keyword, tags.modifier], color: "var(--vscode-symbolIcon-keywordForeground, #c586c0)" },
  { tag: [tags.string, tags.special(tags.string)], color: "var(--vscode-symbolIcon-stringForeground, #ce9178)" },
  { tag: [tags.number, tags.bool, tags.null], color: "var(--vscode-symbolIcon-numberForeground, #b5cea8)" },
  { tag: [tags.comment, tags.docComment], color: "var(--vscode-descriptionForeground, #6a9955)", fontStyle: "italic" },
  { tag: tags.function(tags.variableName), color: "var(--vscode-symbolIcon-functionForeground, #dcdcaa)" },
  { tag: [tags.typeName, tags.className], color: "var(--vscode-symbolIcon-classForeground, #4ec9b0)" },
  { tag: [tags.propertyName, tags.variableName], color: "var(--vscode-editor-foreground, #d4d4d4)" },
  { tag: [tags.operator, tags.punctuation], color: "var(--vscode-editor-foreground, #d4d4d4)" }
]);
const codePreviewTheme = EditorView.theme({
  "&": {
    height: "100vh",
    color: "var(--vscode-editor-foreground, var(--vscode-foreground, #d4d4d4))",
    backgroundColor: "var(--vscode-editor-background, #1e1e1e)"
  },
  ".cm-content": {
    caretColor: "var(--vscode-editorCursor-foreground)",
    fontFamily: "var(--vscode-editor-font-family, monospace)",
    fontSize: "var(--vscode-editor-font-size, 12px)"
  },
  ".cm-gutters": {
    color: "var(--vscode-editorLineNumber-foreground, var(--vscode-descriptionForeground, #858585))",
    backgroundColor: "var(--vscode-editorGutter-background, var(--vscode-editor-background))",
    borderRight: "1px solid var(--vscode-panel-border)"
  },
  ".cm-activeLineGutter": {
    color:
      "var(--vscode-editorLineNumber-activeForeground, var(--vscode-editor-foreground, var(--vscode-foreground, #d4d4d4)))"
  },
  ".cm-activeLine, .cm-activeLineGutter": {
    backgroundColor: "var(--vscode-editor-lineHighlightBackground)"
  },
  ".cm-focused .cm-selectionBackground, ::selection": {
    backgroundColor: "var(--vscode-editor-selectionBackground) !important"
  },
  ".cm-scroller": {
    fontFamily: "var(--vscode-editor-font-family, monospace)",
    lineHeight: "1.45"
  }
});
const editor = new EditorView({
  parent: host,
  state: createEditorState("# Open a dataframe to preview generated code.", null, false, undefined)
});

const handleHostMessage = (event: MessageEvent<unknown>): void => {
  if (pageDisposed || event.origin !== window.location.origin) return;
  const message = event.data;
  if (!isCodePreviewHostMessage(message)) return;
  if (message.kind === "codeSnapshotRequest") {
    publishCurrentCode(message);
    return;
  }

  cancelPendingEdit();
  const codeDialect = message.runtimeIdentity?.codeDialect ?? null;
  const languageLabel = codeDialectLanguageLabel(codeDialect);
  applyingHostUpdate = true;
  try {
    editor.setState(createEditorState(message.code, codeDialect, message.editable, languageLabel));
    clearHistoryAccounting();
    bufferId = message.bufferId;
    bufferVersion = message.bufferVersion;
    bufferInvalid = message.bufferInvalid;
    localEdit = false;
    pendingChanges = undefined;
    currentCodeDialect = codeDialect;
    currentEditable = message.editable;
    currentLanguageLabel = languageLabel;
    publishRuntimeIdentity(host, message.runtimeIdentity);
  } finally {
    applyingHostUpdate = false;
  }
};

window.addEventListener("message", handleHostMessage);
vscode.postMessage({ kind: "ready" });
window.addEventListener(
  "pagehide",
  () => {
    try {
      publishCurrentCode();
    } finally {
      pageDisposed = true;
      cancelPendingEdit();
      clearHistoryAccounting();
      window.removeEventListener("message", handleHostMessage);
      editor.destroy();
    }
  },
  { once: true }
);

function createEditorState(
  code: string | Text,
  codeDialect: CodeDialect | null,
  editable: boolean,
  languageLabel: "Python" | "R" | undefined,
  selection?: EditorSelection
): EditorState {
  return EditorState.create({
    doc: code,
    ...(selection ? { selection } : {}),
    extensions: [
      lineNumbers(),
      history(),
      drawSelection(),
      highlightActiveLine(),
      syntaxHighlighting(pythonHighlightStyle),
      keymap.of([...defaultKeymap, ...historyKeymap]),
      EditorState.tabSize.of(4),
      EditorView.lineWrapping,
      codePreviewLanguage(codeDialect),
      codePreviewEditability(editable, languageLabel),
      EditorState.transactionExtender.of((transaction) =>
        historyResetPending && transaction.docChanged ? { annotations: Transaction.addToHistory.of(false) } : null
      ),
      EditorView.updateListener.of((update) => {
        if (update.docChanged && !applyingHostUpdate) {
          localEdit = true;
          pendingChanges = pendingChanges ? pendingChanges.compose(update.changes) : update.changes;
          chargeRetainedHistory(update);
          scheduleCodeChanged();
        }
      }),
      codePreviewTheme
    ]
  });
}

function scheduleCodeChanged(): void {
  cancelPendingEdit();
  editTimer = setTimeout(() => {
    editTimer = undefined;
    publishCurrentCode();
  }, CODE_PREVIEW_EDIT_DEBOUNCE_MS);
}

function cancelPendingEdit(): void {
  if (editTimer !== undefined) clearTimeout(editTimer);
  editTimer = undefined;
}

function publishCurrentCode(request?: {
  readonly requestId: string;
  readonly bufferId: string;
  readonly bufferVersion: number;
}): void {
  cancelPendingEdit();
  const currentBufferId = bufferId;
  if (!currentBufferId) return;
  if (request && (request.bufferId !== currentBufferId || request.bufferVersion > bufferVersion)) {
    vscode.postMessage({
      kind: "codeSnapshotInvalid",
      requestId: request.requestId,
      bufferId: currentBufferId,
      baseVersion: bufferVersion
    });
    return;
  }
  if ((!localEdit && bufferInvalid) || editor.state.doc.length > CODE_PREVIEW_MAX_UTF8_BYTES) {
    publishInvalidCode(request, currentBufferId);
    return;
  }
  const code = editor.state.doc.toString();
  if (!isCanonicalCodePreviewText(code)) {
    publishInvalidCode(request, currentBufferId);
    return;
  }
  if (localEdit) publishPendingCodeChanges(currentBufferId, code);
  if (!request) return;
  vscode.postMessage({
    kind: "codeSnapshot",
    requestId: request.requestId,
    bufferId: currentBufferId,
    baseVersion: request.bufferVersion,
    bufferVersion,
    code
  });
}

function publishPendingCodeChanges(currentBufferId: string, code: string): void {
  const baseVersion = bufferVersion;
  const changes = pendingChanges ? encodeCodePreviewChanges(pendingChanges, editor.state.doc, code) : [];
  const nextVersion = baseVersion + (changes.length === 0 ? 0 : 1);
  bufferInvalid = false;
  localEdit = false;
  pendingChanges = undefined;
  bufferVersion = nextVersion;
  vscode.postMessage({ kind: "codeChanged", bufferId: currentBufferId, baseVersion, bufferVersion, changes });
}

function publishInvalidCode(
  request: { readonly requestId: string; readonly bufferId: string; readonly bufferVersion: number } | undefined,
  currentBufferId: string
): void {
  bufferInvalid = true;
  vscode.postMessage(
    request
      ? {
          kind: "codeSnapshotInvalid",
          requestId: request.requestId,
          bufferId: currentBufferId,
          baseVersion: request.bufferVersion
        }
      : { kind: "codeChangedInvalid", bufferId: currentBufferId, baseVersion: bufferVersion }
  );
}

function encodeCodePreviewChanges(changes: ChangeSet, doc: Text, currentCode: string): readonly CodePreviewChange[] {
  if (changes.empty) return [];
  let changeCount = 0;
  let firstFromA = 0;
  let firstFromB = 0;
  let lastToA = 0;
  let lastToB = 0;
  changes.iterChangedRanges((fromA, toA, fromB, toB) => {
    if (changeCount === 0) {
      firstFromA = fromA;
      firstFromB = fromB;
    }
    changeCount += 1;
    lastToA = toA;
    lastToB = toB;
  });

  if (changeCount <= CODE_PREVIEW_MAX_EDIT_CHANGES) {
    const encoded: CodePreviewChange[] = [];
    let validInsertions = true;
    changes.iterChanges((from, to, _fromNew, _toNew, insert) => {
      const text = insert.toString();
      if (!isCanonicalCodePreviewText(text)) validInsertions = false;
      encoded.push({ from, to, insert: text });
    });
    if (validInsertions) return encoded;
  }

  const boundedInsert = doc.sliceString(firstFromB, lastToB);
  if (isCanonicalCodePreviewText(boundedInsert)) {
    return [{ from: firstFromA, to: lastToA, insert: boundedInsert }];
  }
  return [{ from: 0, to: changes.length, insert: currentCode }];
}

function chargeRetainedHistory(update: ViewUpdate): void {
  if (historyResetPending) return;
  for (const transaction of update.transactions) {
    if (transaction.annotation(Transaction.addToHistory) === false) continue;
    transaction.changes.iterChangedRanges((fromA, toA, fromB, toB) => {
      historyUtf8UpperBound += (toA - fromA + toB - fromB) * 3;
    });
    if (historyUtf8UpperBound > CODE_PREVIEW_HISTORY_UTF8_BUDGET) {
      historyResetPending = true;
      queueMicrotask(resetEditorHistory);
      return;
    }
  }
}

function resetEditorHistory(): void {
  if (!historyResetPending || pageDisposed) return;
  const doc = editor.state.doc;
  const selection = editor.state.selection;
  applyingHostUpdate = true;
  try {
    editor.setState(createEditorState(doc, currentCodeDialect, currentEditable, currentLanguageLabel, selection));
    clearHistoryAccounting();
  } finally {
    applyingHostUpdate = false;
  }
}

function clearHistoryAccounting(): void {
  historyUtf8UpperBound = 0;
  historyResetPending = false;
}

function codePreviewLanguage(codeDialect: CodeDialect | null): Extension {
  switch (codeDialect) {
    case "python.pandas":
    case "python.polars":
    case "python.duckdb":
      return python();
    case "r.base":
    case null:
      return [];
  }
}

function codePreviewEditability(editable: boolean, languageLabel: "Python" | "R" | undefined): Extension {
  const subject = languageLabel ? `generated ${languageLabel} code preview` : "Open Wrangler code preview";
  return [
    EditorState.readOnly.of(!editable),
    EditorView.editable.of(editable),
    EditorView.contentAttributes.of({
      "aria-label": `${editable ? "Editable" : "Read-only"} ${subject}`,
      spellcheck: "false"
    })
  ];
}

function publishRuntimeIdentity(root: HTMLElement, identity: RuntimeIdentity | null): void {
  root.dataset.runtimeLanguage = identity?.runtimeLanguage ?? "";
  root.dataset.dataframeFlavor = identity?.dataframeFlavor ?? "";
  root.dataset.codeDialect = identity?.codeDialect ?? "";
}
