import { defaultKeymap, history, historyKeymap } from "@codemirror/commands";
import { python } from "@codemirror/lang-python";
import { HighlightStyle, syntaxHighlighting } from "@codemirror/language";
import { Compartment, EditorState, type Extension, type Text } from "@codemirror/state";
import { drawSelection, EditorView, highlightActiveLine, keymap, lineNumbers } from "@codemirror/view";
import { tags } from "@lezer/highlight";
import { CodePreviewEditCoalescer, isCodePreviewHostMessage } from "../shared/codePreviewMessages";
import {
  CODE_PREVIEW_INVALID_PLACEHOLDER,
  CODE_PREVIEW_UNAVAILABLE_PLACEHOLDER,
  collectCodePreviewText
} from "../shared/codePreviewLimits";
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
let scheduleCodePreviewEdit = (): void => undefined;
const editability = new Compartment();
const generatedCodeLanguage = new Compartment();
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
const editor = new EditorView({
  parent: host,
  state: EditorState.create({
    doc: "# Open a dataframe to preview generated code.",
    extensions: [
      lineNumbers(),
      history(),
      drawSelection(),
      highlightActiveLine(),
      syntaxHighlighting(pythonHighlightStyle),
      keymap.of([...defaultKeymap, ...historyKeymap]),
      EditorState.tabSize.of(4),
      EditorView.lineWrapping,
      generatedCodeLanguage.of(codePreviewLanguage(null)),
      editability.of(codePreviewEditability(false, undefined)),
      EditorView.updateListener.of((update) => {
        if (update.docChanged && !applyingHostUpdate) {
          scheduleCodePreviewEdit();
        }
      }),
      EditorView.theme({
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
      })
    ]
  })
});
const editCoalescer = new CodePreviewEditCoalescer(
  () => collectCodePreviewText(codePreviewDocumentChunks(editor.state.doc)),
  (message) => vscode.postMessage(message),
  {
    schedule: (callback, delayMs) => window.setTimeout(callback, delayMs),
    cancel: (handle) => window.clearTimeout(handle as number)
  }
);
scheduleCodePreviewEdit = () => editCoalescer.schedule();

window.addEventListener("message", (event: MessageEvent<unknown>) => {
  if (event.origin !== window.location.origin) return;
  const message = event.data;
  if (!isCodePreviewHostMessage(message)) return;
  if (message.kind === "codePreviewSnapshotRequest") {
    editCoalescer.respondToSnapshotRequest(message.generation, message.requestId);
    return;
  }
  if (!editCoalescer.acceptHostState(message.generation, message.acknowledgedSequence)) return;
  const code =
    message.kind === "codePreview"
      ? message.code
      : message.kind === "codePreviewInvalid"
        ? CODE_PREVIEW_INVALID_PLACEHOLDER
        : CODE_PREVIEW_UNAVAILABLE_PLACEHOLDER;
  const current = collectCodePreviewText(codePreviewDocumentChunks(editor.state.doc));
  const changes =
    current.valid && current.code === code ? undefined : { from: 0, to: editor.state.doc.length, insert: code };
  applyingHostUpdate = true;
  const codeDialect = message.runtimeIdentity?.codeDialect ?? null;
  const languageLabel = codeDialectLanguageLabel(codeDialect);
  try {
    editor.dispatch({
      ...(changes ? { changes } : {}),
      effects: [
        generatedCodeLanguage.reconfigure(codePreviewLanguage(codeDialect)),
        editability.reconfigure(codePreviewEditability(message.editable, languageLabel))
      ]
    });
    publishRuntimeIdentity(host, message.runtimeIdentity);
  } finally {
    applyingHostUpdate = false;
  }
});

vscode.postMessage({ kind: "ready" });
window.addEventListener("pagehide", () => editCoalescer.dispose(), { once: true });

function* codePreviewDocumentChunks(document: Text): Iterable<string> {
  const iterator = document.iter();
  while (!iterator.next().done) yield iterator.value;
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
