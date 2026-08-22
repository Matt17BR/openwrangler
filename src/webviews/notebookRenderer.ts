import {
  isNotebookLiveResultHandle,
  isPythonIdentifier,
  normalizeNotebookOutputPayload,
  type NotebookOutputPayload
} from "../shared/notebookOutput";

interface RendererOutputItem {
  json(): unknown;
}

interface HtmlRendererOutputItem {
  readonly id: string;
  readonly mime: string;
  data(): Uint8Array;
}

interface RendererContext {
  setState?(state: unknown): void;
  getState?(): unknown;
  postMessage?(message: unknown): void;
}

interface HtmlRendererContext extends RendererContext {
  getRenderer(id: "vscode.builtin-renderer"): Promise<{
    experimental_registerHtmlRenderingHook(hook: {
      postRender(outputItem: HtmlRendererOutputItem, element: HTMLElement, signal: AbortSignal): Promise<void>;
    }): unknown;
  }>;
  onDidReceiveMessage(listener: (message: unknown) => void): void;
}

interface RendererApi {
  renderOutputItem(outputItem: RendererOutputItem, element: HTMLElement): void;
}

const DEFAULT_INLINE_PAGE_SIZE = 20;
const INLINE_PAGE_SIZES = [10, 20, 50, 100] as const;
const INLINE_LABEL_CHARACTERS = 256;
const INLINE_COLUMN_CHARACTERS = 128;
const INLINE_CELL_CHARACTERS = 512;
const INLINE_UPGRADE_PROTOCOL = 1;
const INLINE_UPGRADE_MAX_HTML_BYTES = 32 * 1024;
const INLINE_UPGRADE_MAX_CANDIDATES = 128;
const INLINE_UPGRADE_OUTPUT_ID_CHARACTERS = 256;
const INLINE_UPGRADE_TERMINAL_DEADLINE_MS = 10_000;
let htmlUpgradeRegistration: Promise<void> | undefined;

interface InlineUpgradeCandidate {
  readonly outputItemId: string;
  readonly token: string;
  readonly element: HTMLElement;
  readonly signal: AbortSignal;
  readonly ordinaryNodes: readonly ChildNode[];
  byteLength?: number;
  sha256?: string;
  abortListener?: () => void;
  deadline?: ReturnType<typeof setTimeout>;
  enhancement?: HTMLElement;
  ownershipObserver?: MutationObserver;
}

export function activate(context: RendererContext): RendererApi {
  if (isHtmlRendererContext(context)) {
    // Both contributions deliberately share this bundle, and VS Code supplies
    // the same context capabilities to each. Register the dependent hook once
    // while always returning the ordinary MIME renderer API.
    htmlUpgradeRegistration ??= activateHtmlUpgrade(context).catch(() => undefined);
  }
  return {
    renderOutputItem(outputItem, element) {
      const payload = normalizeNotebookOutputPayload(outputItem.json());
      element.innerHTML = "";
      if (!payload) {
        const error = document.createElement("p");
        error.setAttribute("role", "alert");
        error.textContent = "This Open Wrangler output is malformed or uses an unsupported MIME version.";
        element.appendChild(error);
        return;
      }
      element.appendChild(renderPayload(payload, context));
    }
  };
}

async function activateHtmlUpgrade(context: HtmlRendererContext): Promise<void> {
  const builtin = await context.getRenderer("vscode.builtin-renderer");
  const candidates = new Map<string, InlineUpgradeCandidate>();
  const completed = new Set<string>();

  context.onDidReceiveMessage((message) => {
    const accepted = parseInlineUpgradeResponse(message);
    if (!accepted) return;
    const candidate = candidates.get(accepted.outputItemId);
    if (
      !candidate ||
      candidate.signal.aborted ||
      candidate.token !== accepted.token ||
      candidate.byteLength !== accepted.byteLength ||
      candidate.sha256 !== accepted.sha256
    ) {
      return;
    }
    if (accepted.kind === "openWrangler.inlineRevoke") {
      retireHtmlUpgradeCandidate(context, candidates, completed, candidate, false);
      return;
    }
    if (accepted.kind === "openWrangler.inlinePending") {
      if (completed.has(accepted.outputItemId)) return;
      if (candidate.signal.aborted || !hasExactChildren(candidate.element, candidate.ordinaryNodes)) {
        retireHtmlUpgradeCandidate(context, candidates, completed, candidate, true);
        return;
      }
      releaseHtmlUpgradeCandidateDeadline(candidate);
      candidate.abortListener ??= () => {
        if (candidates.get(candidate.outputItemId) !== candidate) return;
        retireHtmlUpgradeCandidate(context, candidates, completed, candidate, true);
      };
      candidate.signal.addEventListener("abort", candidate.abortListener, { once: true });
      candidate.ownershipObserver ??= new MutationObserver(() => {
        if (candidates.get(candidate.outputItemId) !== candidate) return;
        if (!candidate.element.isConnected || !hasExactChildren(candidate.element, candidate.ordinaryNodes)) {
          retireHtmlUpgradeCandidate(context, candidates, completed, candidate, true);
        }
      });
      candidate.ownershipObserver.observe(candidate.element, { childList: true });
      candidate.ownershipObserver.observe(candidate.element.ownerDocument, { childList: true, subtree: true });
      if (candidate.signal.aborted || !hasExactChildren(candidate.element, candidate.ordinaryNodes)) {
        retireHtmlUpgradeCandidate(context, candidates, completed, candidate, true);
      }
      return;
    }
    if (completed.has(accepted.outputItemId)) return;
    const payload = normalizeNotebookOutputPayload(accepted.payload);
    if (!payload) {
      if (candidate.ownershipObserver) retireHtmlUpgradeCandidate(context, candidates, completed, candidate, true);
      return;
    }
    try {
      const enhancement = document.createElement("section");
      enhancement.dataset.openWranglerInlineUpgrade = "true";
      enhancement.appendChild(renderPayload(payload, context));
      if (!hasExactChildren(candidate.element, candidate.ordinaryNodes)) {
        retireHtmlUpgradeCandidate(context, candidates, completed, candidate, true);
        return;
      }
      releaseHtmlUpgradeCandidateObserverOwnership(candidate);
      candidate.element.replaceChildren(enhancement);
      candidate.enhancement = enhancement;
      completed.add(candidate.outputItemId);
      releaseHtmlUpgradeCandidateDeadline(candidate);
      releaseHtmlUpgradeCandidateAbortOwnership(candidate);
      candidate.abortListener = () => {
        if (candidates.get(candidate.outputItemId) !== candidate) return;
        retireHtmlUpgradeCandidate(context, candidates, completed, candidate, true);
      };
      candidate.signal.addEventListener("abort", candidate.abortListener, { once: true });
    } catch {
      retireHtmlUpgradeCandidate(context, candidates, completed, candidate, true);
    }
  });

  builtin.experimental_registerHtmlRenderingHook({
    async postRender(outputItem, element, signal) {
      if (
        signal.aborted ||
        outputItem.mime !== "text/html" ||
        !isBoundedOutputItemId(outputItem.id) ||
        candidates.has(outputItem.id)
      ) {
        return;
      }
      if (candidates.size >= INLINE_UPGRADE_MAX_CANDIDATES) {
        const oldestSettled = [...candidates.values()].find((candidate) => candidate.sha256 !== undefined);
        if (!oldestSettled) return;
        retireHtmlUpgradeCandidate(context, candidates, completed, oldestSettled, true);
      }
      const candidate: InlineUpgradeCandidate = {
        outputItemId: outputItem.id,
        token: randomToken(),
        element,
        signal,
        ordinaryNodes: [...element.childNodes]
      };
      candidates.set(outputItem.id, candidate);
      candidate.deadline = setTimeout(
        () => retireHtmlUpgradeCandidate(context, candidates, completed, candidate, true),
        INLINE_UPGRADE_TERMINAL_DEADLINE_MS
      );
      candidate.abortListener = () => {
        if (candidates.get(outputItem.id) !== candidate) return;
        retireHtmlUpgradeCandidate(context, candidates, completed, candidate, true);
      };
      signal.addEventListener("abort", candidate.abortListener, { once: true });
      try {
        const bytes = outputItem.data();
        if (bytes.byteLength === 0 || bytes.byteLength > INLINE_UPGRADE_MAX_HTML_BYTES) {
          retireHtmlUpgradeCandidate(context, candidates, completed, candidate, true);
          return;
        }
        candidate.byteLength = bytes.byteLength;
        const digest = await sha256(bytes);
        if (
          signal.aborted ||
          candidates.get(outputItem.id) !== candidate ||
          !hasExactChildren(element, candidate.ordinaryNodes)
        ) {
          retireHtmlUpgradeCandidate(context, candidates, completed, candidate, true);
          return;
        }
        candidate.sha256 = digest;
        releaseHtmlUpgradeCandidateAbortOwnership(candidate);
      } catch {
        retireHtmlUpgradeCandidate(context, candidates, completed, candidate, true);
        return;
      }
      context.postMessage?.({
        kind: "openWrangler.inlineCandidate",
        protocol: INLINE_UPGRADE_PROTOCOL,
        token: candidate.token,
        outputItemId: candidate.outputItemId,
        byteLength: candidate.byteLength,
        sha256: candidate.sha256
      });
    }
  });
}

function retireHtmlUpgradeCandidate(
  context: HtmlRendererContext,
  candidates: Map<string, InlineUpgradeCandidate>,
  completed: Set<string>,
  candidate: InlineUpgradeCandidate,
  notifyHost: boolean
): void {
  if (candidates.get(candidate.outputItemId) !== candidate) return;
  candidates.delete(candidate.outputItemId);
  completed.delete(candidate.outputItemId);
  releaseHtmlUpgradeCandidateAsyncOwnership(candidate);
  restoreOrdinaryHtml(candidate);
  if (notifyHost) {
    context.postMessage?.({
      kind: "openWrangler.inlineCancel",
      protocol: INLINE_UPGRADE_PROTOCOL,
      token: candidate.token,
      outputItemId: candidate.outputItemId
    });
  }
}

function releaseHtmlUpgradeCandidateAsyncOwnership(candidate: InlineUpgradeCandidate): void {
  releaseHtmlUpgradeCandidateDeadline(candidate);
  releaseHtmlUpgradeCandidateAbortOwnership(candidate);
  releaseHtmlUpgradeCandidateObserverOwnership(candidate);
}

function releaseHtmlUpgradeCandidateDeadline(candidate: InlineUpgradeCandidate): void {
  if (candidate.deadline) clearTimeout(candidate.deadline);
  candidate.deadline = undefined;
}

function releaseHtmlUpgradeCandidateAbortOwnership(candidate: InlineUpgradeCandidate): void {
  if (candidate.abortListener) candidate.signal.removeEventListener("abort", candidate.abortListener);
  candidate.abortListener = undefined;
}

function releaseHtmlUpgradeCandidateObserverOwnership(candidate: InlineUpgradeCandidate): void {
  candidate.ownershipObserver?.disconnect();
  candidate.ownershipObserver = undefined;
}

function isHtmlRendererContext(context: RendererContext): context is HtmlRendererContext {
  const candidate = context as Partial<HtmlRendererContext>;
  return typeof candidate.getRenderer === "function" && typeof candidate.onDidReceiveMessage === "function";
}

function parseInlineUpgradeResponse(message: unknown):
  | {
      readonly kind: "openWrangler.inlineUpgrade";
      readonly token: string;
      readonly outputItemId: string;
      readonly byteLength: number;
      readonly sha256: string;
      readonly payload: unknown;
    }
  | {
      readonly kind: "openWrangler.inlinePending";
      readonly token: string;
      readonly outputItemId: string;
      readonly byteLength: number;
      readonly sha256: string;
    }
  | {
      readonly kind: "openWrangler.inlineRevoke";
      readonly token: string;
      readonly outputItemId: string;
      readonly byteLength: number;
      readonly sha256: string;
    }
  | undefined {
  if (typeof message !== "object" || message === null) return undefined;
  const candidate = message as Record<string, unknown>;
  if (
    (candidate.kind !== "openWrangler.inlineUpgrade" &&
      candidate.kind !== "openWrangler.inlinePending" &&
      candidate.kind !== "openWrangler.inlineRevoke") ||
    candidate.protocol !== INLINE_UPGRADE_PROTOCOL ||
    typeof candidate.token !== "string" ||
    candidate.token.length !== 32 ||
    !/^[a-f0-9]{32}$/u.test(candidate.token) ||
    !isBoundedOutputItemId(candidate.outputItemId) ||
    !Number.isSafeInteger(candidate.byteLength) ||
    (candidate.byteLength as number) < 1 ||
    (candidate.byteLength as number) > INLINE_UPGRADE_MAX_HTML_BYTES ||
    typeof candidate.sha256 !== "string" ||
    candidate.sha256.length !== 64 ||
    !/^[a-f0-9]{64}$/u.test(candidate.sha256) ||
    (candidate.kind === "openWrangler.inlineUpgrade"
      ? !Object.hasOwn(candidate, "payload") || Object.keys(candidate).length !== 7
      : Object.hasOwn(candidate, "payload") || Object.keys(candidate).length !== 6)
  ) {
    return undefined;
  }
  return candidate as unknown as
    | {
        kind: "openWrangler.inlineUpgrade";
        token: string;
        outputItemId: string;
        byteLength: number;
        sha256: string;
        payload: unknown;
      }
    | {
        kind: "openWrangler.inlinePending";
        token: string;
        outputItemId: string;
        byteLength: number;
        sha256: string;
      }
    | {
        kind: "openWrangler.inlineRevoke";
        token: string;
        outputItemId: string;
        byteLength: number;
        sha256: string;
      };
}

function hasExactChildren(element: HTMLElement, expected: readonly ChildNode[]): boolean {
  const current = element.childNodes;
  return current.length === expected.length && expected.every((node, index) => current[index] === node);
}

function restoreOrdinaryHtml(candidate: InlineUpgradeCandidate): void {
  const enhancement = candidate.enhancement;
  if (!enhancement) return;
  if (hasExactChildren(candidate.element, [enhancement])) {
    candidate.element.replaceChildren(...candidate.ordinaryNodes);
  }
  delete candidate.enhancement;
}

function isBoundedOutputItemId(value: unknown): value is string {
  return (
    typeof value === "string" &&
    value.length > 0 &&
    value.length <= INLINE_UPGRADE_OUTPUT_ID_CHARACTERS * 2 &&
    Array.from(value).length <= INLINE_UPGRADE_OUTPUT_ID_CHARACTERS
  );
}

function randomToken(): string {
  const bytes = new Uint8Array(16);
  crypto.getRandomValues(bytes);
  return hex(bytes);
}

async function sha256(bytes: Uint8Array): Promise<string> {
  const owned = new Uint8Array(bytes.byteLength);
  owned.set(bytes);
  return hex(new Uint8Array(await crypto.subtle.digest("SHA-256", owned.buffer)));
}

function hex(bytes: Uint8Array): string {
  return Array.from(bytes, (value) => value.toString(16).padStart(2, "0")).join("");
}

function renderPayload(payload: NotebookOutputPayload, context: RendererContext): HTMLElement {
  const root = document.createElement("section");
  root.className = "openwrangler-notebook";

  const header = document.createElement("header");
  header.style.alignItems = "center";
  header.style.display = "flex";
  header.style.gap = "12px";
  header.style.justifyContent = "space-between";

  const title = document.createElement("span");
  const sourceLabel = boundedText(payload.metadata.source.label, INLINE_LABEL_CHARACTERS);
  title.textContent = `Open Wrangler preview: ${sourceLabel.text} (${payload.metadata.backend}) - ${payload.metadata.shape.rows ?? "unknown"} x ${payload.metadata.shape.columns}`;
  applyTruncationDescription(title, sourceLabel, "Source label");
  header.appendChild(title);

  const actions = document.createElement("div");
  actions.style.display = "flex";
  actions.style.gap = "8px";
  const variableName = payload.metadata.source.variableName;
  const liveVariableName =
    variableName !== undefined && isPythonIdentifier(variableName)
      ? boundedText(variableName, INLINE_COLUMN_CHARACTERS).text
      : undefined;
  if (liveVariableName && context.postMessage) {
    const actionDescription = isNotebookLiveResultHandle(liveVariableName)
      ? "Open the complete current notebook result"
      : `Open the complete current value of ${liveVariableName}`;
    actions.appendChild(
      actionButton("Open in Open Wrangler", actionDescription, () => {
        context.postMessage?.({ kind: "openInOpenWrangler", payload });
      })
    );
  }
  header.appendChild(actions);

  root.appendChild(header);

  const preview = document.createElement("div");
  preview.style.display = "grid";
  preview.style.gap = "6px";
  root.appendChild(preview);

  const controls = document.createElement("div");
  controls.style.alignItems = "center";
  controls.style.display = "flex";
  controls.style.flexWrap = "wrap";
  controls.style.gap = "6px";
  preview.appendChild(controls);

  const pageSizeLabel = document.createElement("label");
  pageSizeLabel.style.alignItems = "center";
  pageSizeLabel.style.display = "flex";
  pageSizeLabel.style.gap = "4px";
  pageSizeLabel.textContent = "Rows";
  controls.appendChild(pageSizeLabel);

  const pageSizeSelect = document.createElement("select");
  pageSizeSelect.setAttribute("aria-label", "Rows per notebook preview page");
  pageSizeSelect.style.background = "var(--vscode-dropdown-background)";
  pageSizeSelect.style.border = "1px solid var(--vscode-dropdown-border, var(--vscode-panel-border))";
  pageSizeSelect.style.color = "var(--vscode-dropdown-foreground)";
  pageSizeSelect.style.padding = "2px 4px";
  for (const pageSize of INLINE_PAGE_SIZES) {
    const option = document.createElement("option");
    option.value = String(pageSize);
    option.textContent = String(pageSize);
    option.selected = pageSize === DEFAULT_INLINE_PAGE_SIZE;
    pageSizeSelect.appendChild(option);
  }
  pageSizeLabel.appendChild(pageSizeSelect);

  const previousButton = secondaryActionButton("Previous", "Show the previous rows");
  const nextButton = secondaryActionButton("Next", "Show the next rows");
  controls.appendChild(previousButton);
  controls.appendChild(nextButton);

  const pageStatus = document.createElement("span");
  pageStatus.dataset.testid = "inline-preview-page";
  pageStatus.setAttribute("role", "status");
  pageStatus.setAttribute("aria-live", "polite");
  pageStatus.style.color = "var(--vscode-descriptionForeground)";
  controls.appendChild(pageStatus);

  const scroller = document.createElement("div");
  scroller.style.overflow = "auto";
  scroller.style.maxHeight = "320px";
  preview.appendChild(scroller);

  const table = document.createElement("table");
  table.setAttribute("aria-label", `Open Wrangler inline preview of ${sourceLabel.text}`);
  table.style.borderCollapse = "collapse";
  table.style.width = "max-content";
  table.style.minWidth = "100%";
  scroller.appendChild(table);

  const head = document.createElement("thead");
  const headRow = document.createElement("tr");
  payload.metadata.schema.forEach((column) => {
    const cell = document.createElement("th");
    const columnName = boundedText(column.name, INLINE_COLUMN_CHARACTERS);
    const rawType = boundedText(column.rawType, INLINE_COLUMN_CHARACTERS);
    cell.textContent = columnName.text;
    cell.title = rawType.truncated
      ? `Raw type preview (${rawType.length.toLocaleString()} characters): ${rawType.text}`
      : rawType.text;
    applyTruncationDescription(cell, columnName, "Column name");
    cell.style.textAlign = "left";
    cell.style.borderBottom = "1px solid var(--vscode-panel-border)";
    cell.style.padding = "4px 8px";
    headRow.appendChild(cell);
  });
  head.appendChild(headRow);
  table.appendChild(head);

  const body = document.createElement("tbody");
  table.appendChild(body);

  let pageSize = DEFAULT_INLINE_PAGE_SIZE;
  let pageStart = 0;
  const renderPage = () => {
    const capturedRows = payload.page.rows;
    const lastPageStart = Math.max(0, Math.floor(Math.max(0, capturedRows.length - 1) / pageSize) * pageSize);
    pageStart = Math.min(pageStart, lastPageStart);
    const previewRows = capturedRows.slice(pageStart, pageStart + pageSize);
    body.replaceChildren();
    previewRows.forEach((row) => {
      const tableRow = document.createElement("tr");
      row.values.forEach((value) => {
        const cell = document.createElement("td");
        const display = boundedText(value.display, INLINE_CELL_CHARACTERS);
        cell.textContent = display.text;
        cell.title = display.truncated
          ? `Value preview (${display.length.toLocaleString()} characters): ${display.text}`
          : display.text;
        applyTruncationDescription(cell, display, "Cell value");
        cell.style.borderBottom = "1px solid var(--vscode-panel-border)";
        cell.style.padding = "4px 8px";
        tableRow.appendChild(cell);
      });
      body.appendChild(tableRow);
    });
    const pageEnd = pageStart + previewRows.length;
    const captureSuffix =
      payload.page.rows.length < payload.page.totalRows
        ? ` captured · ${payload.page.totalRows.toLocaleString()} total`
        : "";
    pageStatus.textContent =
      previewRows.length === 0
        ? `0 rows${captureSuffix}`
        : `${(pageStart + 1).toLocaleString()}-${pageEnd.toLocaleString()} of ${payload.page.rows.length.toLocaleString()}${captureSuffix}`;
    previousButton.disabled = pageStart === 0;
    nextButton.disabled = pageEnd >= capturedRows.length;
  };

  pageSizeSelect.addEventListener("change", () => {
    const selected = Number(pageSizeSelect.value);
    if (!INLINE_PAGE_SIZES.includes(selected as (typeof INLINE_PAGE_SIZES)[number])) return;
    pageSize = selected;
    pageStart = Math.floor(pageStart / pageSize) * pageSize;
    renderPage();
  });
  previousButton.addEventListener("click", () => {
    pageStart = Math.max(0, pageStart - pageSize);
    renderPage();
  });
  nextButton.addEventListener("click", () => {
    pageStart += pageSize;
    renderPage();
  });
  renderPage();

  return root;
}

function actionButton(label: string, title: string, action: () => void): HTMLButtonElement {
  const button = document.createElement("button");
  button.type = "button";
  button.textContent = label;
  button.title = title;
  button.style.background = "var(--vscode-button-background)";
  button.style.border = "0";
  button.style.borderRadius = "3px";
  button.style.color = "var(--vscode-button-foreground)";
  button.style.cursor = "pointer";
  button.style.padding = "4px 8px";
  button.addEventListener("click", action);
  return button;
}

function secondaryActionButton(label: string, title: string): HTMLButtonElement {
  const button = document.createElement("button");
  button.type = "button";
  button.textContent = label;
  button.title = title;
  button.style.background = "var(--vscode-button-secondaryBackground, transparent)";
  button.style.border = "1px solid var(--vscode-button-border, var(--vscode-panel-border))";
  button.style.borderRadius = "3px";
  button.style.color = "var(--vscode-button-secondaryForeground, var(--vscode-foreground))";
  button.style.cursor = "pointer";
  button.style.padding = "2px 6px";
  return button;
}

function boundedText(value: string, maximum: number): { text: string; truncated: boolean; length: number } {
  const characters = Array.from(value);
  if (characters.length <= maximum) return { text: value, truncated: false, length: characters.length };
  return { text: `${characters.slice(0, maximum).join("")}…`, truncated: true, length: characters.length };
}

function applyTruncationDescription(
  element: HTMLElement,
  value: { text: string; truncated: boolean; length: number },
  label: string
): void {
  if (!value.truncated) return;
  element.dataset.truncatedValue = "true";
  element.setAttribute(
    "aria-label",
    `${label} preview, truncated from ${value.length.toLocaleString()} characters: ${value.text}`
  );
}
