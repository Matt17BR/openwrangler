import {
  isPythonIdentifier,
  normalizeNotebookOutputPayload,
  type NotebookOutputPayload
} from "../shared/notebookOutput";

interface RendererOutputItem {
  json(): unknown;
}

interface RendererContext {
  setState?(state: unknown): void;
  getState?(): unknown;
  postMessage?(message: unknown): void;
}

interface RendererApi {
  renderOutputItem(outputItem: RendererOutputItem, element: HTMLElement): void;
}

const DEFAULT_INLINE_PAGE_SIZE = 20;
const INLINE_PAGE_SIZES = [10, 20, 50, 100] as const;
const INLINE_LABEL_CHARACTERS = 256;
const INLINE_COLUMN_CHARACTERS = 128;
const INLINE_CELL_CHARACTERS = 512;

export function activate(context: RendererContext): RendererApi {
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
  title.textContent = `Open Wrangler preview: ${sourceLabel.text} (${payload.metadata.backend}) - ${payload.metadata.shape.rows} x ${payload.metadata.shape.columns}`;
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
    actions.appendChild(
      actionButton("Open in Open Wrangler", `Open the complete current value of ${liveVariableName}`, () => {
        context.postMessage?.({ kind: "openInOpenWrangler", payload });
      })
    );
  } else if (!liveVariableName) {
    const liveHint = document.createElement("span");
    liveHint.setAttribute("role", "note");
    liveHint.style.color = "var(--vscode-descriptionForeground)";
    liveHint.textContent = "Run this cell again to open the current dataframe in Open Wrangler.";
    actions.appendChild(liveHint);
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
