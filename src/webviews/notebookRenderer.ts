import type { GridPage, SessionMetadata } from "../shared/protocol";

interface RendererOutputItem {
  json(): unknown;
}

interface RendererContext {
  setState?(state: unknown): void;
  getState?(): unknown;
}

interface RendererApi {
  renderOutputItem(outputItem: RendererOutputItem, element: HTMLElement): void;
}

interface NotebookPayload {
  metadata: SessionMetadata;
  page: GridPage;
}

export function activate(_context: RendererContext): RendererApi {
  return {
    renderOutputItem(outputItem, element) {
      const payload = outputItem.json() as NotebookPayload;
      element.innerHTML = "";
      element.appendChild(renderPayload(payload));
    }
  };
}

function renderPayload(payload: NotebookPayload): HTMLElement {
  const root = document.createElement("section");
  root.className = "data-explorer-notebook";

  const header = document.createElement("header");
  header.textContent = `Data Explorer preview: ${payload.metadata.source.label} (${payload.metadata.backend}) - ${payload.metadata.shape.rows} x ${payload.metadata.shape.columns}`;
  root.appendChild(header);

  const scroller = document.createElement("div");
  scroller.style.overflow = "auto";
  scroller.style.maxHeight = "320px";
  root.appendChild(scroller);

  const table = document.createElement("table");
  table.style.borderCollapse = "collapse";
  table.style.width = "max-content";
  table.style.minWidth = "100%";
  scroller.appendChild(table);

  const head = document.createElement("thead");
  const headRow = document.createElement("tr");
  payload.metadata.schema.forEach((column) => {
    const cell = document.createElement("th");
    cell.textContent = column.name;
    cell.title = column.rawType;
    cell.style.textAlign = "left";
    cell.style.borderBottom = "1px solid var(--vscode-panel-border)";
    cell.style.padding = "4px 8px";
    headRow.appendChild(cell);
  });
  head.appendChild(headRow);
  table.appendChild(head);

  const body = document.createElement("tbody");
  payload.page.rows.forEach((row) => {
    const tableRow = document.createElement("tr");
    row.values.forEach((value) => {
      const cell = document.createElement("td");
      cell.textContent = value.display;
      cell.title = value.display;
      cell.style.borderBottom = "1px solid var(--vscode-panel-border)";
      cell.style.padding = "4px 8px";
      tableRow.appendChild(cell);
    });
    body.appendChild(tableRow);
  });
  table.appendChild(body);

  return root;
}
