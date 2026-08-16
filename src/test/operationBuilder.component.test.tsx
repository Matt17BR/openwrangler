import "@testing-library/jest-dom/vitest";
import { fireEvent, render, screen, within } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { SessionMetadata, TransformStep } from "../shared/protocol";
import { operationCatalog } from "../shared/operations";
import { OperationBuilder } from "../webviews/operations/OperationBuilder";

const metadata: SessionMetadata = {
  protocolVersion: 2,
  sessionId: "session",
  revision: 0,
  backend: "polars",
  mode: "editing",
  source: { kind: "file", label: "sample.csv", path: "sample.csv" },
  capabilities: {
    editable: true,
    lazy: true,
    cancel: true,
    exportCsv: true,
    exportParquet: true,
    notebookInsert: false
  },
  shape: { rows: 2, columns: 2 },
  filteredShape: { rows: 2, columns: 2 },
  filterModel: { filters: [], sort: [] },
  steps: [],
  schema: [
    { id: "c:0", name: "city", position: 0, rawType: "String", type: "string", nullable: false },
    { id: "c:1", name: "sales", position: 1, rawType: "Float64", type: "float", nullable: true }
  ]
};

describe("OperationBuilder", () => {
  afterEach(() => vi.restoreAllMocks());

  it("exposes the complete deterministic operation catalog", () => {
    render(
      <OperationBuilder
        metadata={metadata}
        filterModel={{ filters: [], sort: [] }}
        onClose={() => undefined}
        onPreview={() => undefined}
      />
    );

    expect(operationCatalog).toHaveLength(28);
    for (const operation of operationCatalog) {
      expect(screen.getByText(operation.title, { selector: "strong" })).toBeInTheDocument();
    }
  });

  it("shows only operations advertised by the active dataframe", () => {
    render(
      <OperationBuilder
        metadata={{
          ...metadata,
          capabilities: { ...metadata.capabilities, supportedOperations: ["renameColumn"] }
        }}
        filterModel={{ filters: [], sort: [] }}
        initialKind="customCode"
        onClose={() => undefined}
        onPreview={() => undefined}
      />
    );

    expect(screen.getByText("Rename column", { selector: "strong" })).toBeInTheDocument();
    expect(screen.queryByText("Custom code", { selector: "strong" })).toBeNull();
    expect(screen.queryByText("Sort rows", { selector: "strong" })).toBeNull();
    expect(screen.getByRole("heading", { name: "Choose an operation" })).toBeInTheDocument();
  });

  it("uses native R syntax and labeling for R custom code", () => {
    const onPreview = vi.fn();
    const customCode = "result <- df[df$row_id > 1L, , drop = FALSE]";
    render(
      <OperationBuilder
        metadata={{
          ...metadata,
          backend: "r",
          rDataframeFlavor: "r.data.frame",
          capabilities: { ...metadata.capabilities, supportedOperations: ["customCode"] }
        }}
        filterModel={{ filters: [], sort: [] }}
        initialKind="customCode"
        onClose={() => undefined}
        onPreview={onPreview}
      />
    );

    const code = screen.getByRole("textbox", { name: /Engine-native R/u });
    expect(code).toHaveValue("result <- df");
    expect(screen.getByText(/Assign an R data frame/u)).toBeInTheDocument();
    fireEvent.change(code, { target: { value: customCode } });
    fireEvent.click(screen.getByRole("button", { name: "Preview changes" }));
    expect(onPreview).toHaveBeenCalledOnce();
  });

  it.each([
    ["pandas", "result = df.copy()"],
    ["polars", "result = df"],
    ["duckdb", "result = df"]
  ] as const)("preserves the engine-native Python label and %s default", (backend, defaultCode) => {
    const onPreview = vi.fn();
    render(
      <OperationBuilder
        metadata={{
          ...metadata,
          backend,
          capabilities: { ...metadata.capabilities, supportedOperations: ["customCode"] }
        }}
        filterModel={{ filters: [], sort: [] }}
        initialKind="customCode"
        onClose={() => undefined}
        onPreview={onPreview}
      />
    );

    const code = screen.getByRole("textbox", { name: /Engine-native Python/u });
    expect(code).toHaveValue(defaultCode);
    expect(screen.getByText(/Assign an engine-native dataframe or relation/u)).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Preview changes" }));
    expect(onPreview).toHaveBeenCalledOnce();
  });

  it("submits edited rename fields for preview", () => {
    const onPreview = vi.fn();
    render(
      <OperationBuilder
        metadata={metadata}
        filterModel={{ filters: [], sort: [] }}
        initialKind="renameColumn"
        onClose={() => undefined}
        onPreview={onPreview}
      />
    );

    fireEvent.change(screen.getByLabelText("Column"), { target: { value: "c:1" } });
    fireEvent.change(screen.getByLabelText("New name"), { target: { value: "revenue" } });
    fireEvent.click(screen.getByRole("button", { name: "Preview changes" }));

    expect(onPreview).toHaveBeenCalledOnce();
  });

  it("exposes preview progress and disables every dialog control while busy", () => {
    const onClose = vi.fn();
    const onPreview = vi.fn();
    render(
      <OperationBuilder
        metadata={metadata}
        filterModel={{ filters: [], sort: [] }}
        initialKind="renameColumn"
        busy={true}
        onClose={onClose}
        onPreview={onPreview}
      />
    );

    expect(screen.getByRole("dialog", { name: "Add cleaning step" })).toHaveAttribute("aria-busy", "true");
    expect(screen.getByRole("status")).toHaveTextContent("Previewing changes…");
    expect(screen.getByRole("button", { name: "Close operation picker" })).toBeDisabled();
    expect(screen.getByPlaceholderText("Search operations")).toBeDisabled();
    expect(screen.getByText("Rename column", { selector: "strong" }).closest("button")).toBeDisabled();
    expect(screen.getByLabelText("New name")).toBeDisabled();
    expect(screen.getByRole("button", { name: "Cancel" })).toBeDisabled();
    expect(screen.getByRole("button", { name: "Preview changes" })).toBeDisabled();

    fireEvent.click(screen.getByRole("button", { name: "Close operation picker" }));
    fireEvent.submit(screen.getByRole("button", { name: "Preview changes" }).closest("form") as HTMLFormElement);
    expect(onClose).not.toHaveBeenCalled();
    expect(onPreview).not.toHaveBeenCalled();
  });

  it("does not reclaim host focus when a pending preview disables the active control", () => {
    const props = {
      metadata,
      filterModel: { filters: [], sort: [] },
      initialKind: "renameColumn" as const,
      busy: false,
      onClose: () => undefined,
      onPreview: () => undefined
    };
    const { rerender } = render(<OperationBuilder {...props} />);
    const name = screen.getByLabelText("New name");
    name.focus();
    expect(name).toHaveFocus();
    const focus = vi.spyOn(HTMLElement.prototype, "focus");
    focus.mockClear();
    const hasFocus = vi.spyOn(document, "hasFocus").mockReturnValue(false);

    rerender(<OperationBuilder {...props} busy={true} />);

    expect(focus).not.toHaveBeenCalled();
    focus.mockRestore();
    hasFocus.mockRestore();
  });

  it("contains keyboard focus within the modal operation picker", () => {
    render(
      <OperationBuilder
        metadata={metadata}
        filterModel={{ filters: [], sort: [] }}
        initialKind="renameColumn"
        onClose={() => undefined}
        onPreview={() => undefined}
      />
    );

    const close = screen.getByRole("button", { name: "Close operation picker" });
    const preview = screen.getByRole("button", { name: "Preview changes" });
    close.focus();
    fireEvent.keyDown(close, { key: "Tab", shiftKey: true });
    expect(preview).toHaveFocus();
    fireEvent.keyDown(preview, { key: "Tab" });
    expect(close).toHaveFocus();
  });

  it("copies viewing filters only through an explicit filter step", () => {
    const onPreview = vi.fn();
    const filterModel = {
      logic: "and" as const,
      filters: [
        {
          column: "city",
          type: "string" as const,
          predicates: [{ kind: "predicate" as const, operator: "equals" as const, value: "Milan" }]
        }
      ],
      sort: [{ column: "sales", direction: "desc" as const, nulls: "first" as const }]
    };
    render(
      <OperationBuilder
        metadata={metadata}
        filterModel={filterModel}
        initialKind="filterRows"
        onClose={() => undefined}
        onPreview={onPreview}
      />
    );

    fireEvent.click(screen.getByRole("button", { name: "Preview changes" }));
    expect(onPreview).toHaveBeenCalledOnce();
  });

  it("keeps Filter rows unavailable for a structurally present but effective-empty viewing query", () => {
    const onPreview = vi.fn();
    render(
      <OperationBuilder
        metadata={metadata}
        filterModel={{
          logic: "or",
          filters: [
            {
              column: "city",
              type: "string",
              logic: "or",
              valueFilter: {
                kind: "values",
                selectedValues: [],
                includeNulls: false,
                includeNaN: false,
                search: "stale search text"
              },
              predicates: []
            }
          ],
          sort: []
        }}
        initialKind="filterRows"
        onClose={() => undefined}
        onPreview={onPreview}
      />
    );

    expect(screen.getByText("0 filters")).toBeInTheDocument();
    expect(screen.getByText("0 sorts")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Preview changes" })).toBeDisabled();
    fireEvent.click(screen.getByRole("button", { name: "Preview changes" }));
    expect(onPreview).not.toHaveBeenCalled();
  });

  it("edits a saved stable filter step independently from an empty current view", () => {
    const onPreview = vi.fn();
    const duplicateColumns = [
      { ...metadata.schema[0], id: "c:0", name: "value", position: 0 },
      { ...metadata.schema[1], id: "c:1", name: "value", position: 1 }
    ];
    const initialStep = {
      id: "filter-first-sort-second",
      kind: "filterRows" as const,
      params: {
        filterModel: {
          logic: "and" as const,
          filters: [
            {
              column: { id: "c:0", name: "value" },
              type: "string" as const,
              predicates: [{ kind: "predicate" as const, operator: "equals" as const, value: "Milan" }]
            }
          ],
          sort: [{ column: { id: "c:1", name: "value" }, direction: "desc" as const, nulls: "first" as const }]
        }
      }
    };
    render(
      <OperationBuilder
        metadata={{
          ...metadata,
          schema: duplicateColumns,
          latestStepInputSchema: duplicateColumns,
          steps: [initialStep]
        }}
        filterModel={{ filters: [], sort: [] }}
        initialStep={initialStep}
        onClose={() => undefined}
        onPreview={onPreview}
      />
    );

    expect(screen.getByRole("group", { name: "Saved cleaning query" })).toBeInTheDocument();
    expect(screen.getByText("1 filters")).toBeInTheDocument();
    expect(screen.getByText("1 sorts")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Preview changes" })).toBeEnabled();

    fireEvent.click(screen.getByRole("button", { name: "Preview changes" }));
    expect(onPreview).toHaveBeenCalledOnce();
  });

  it("replaces a saved filter step with the current viewing query only when explicitly selected", () => {
    const onPreview = vi.fn();
    const initialStep = {
      id: "saved-filter",
      kind: "filterRows" as const,
      params: {
        filterModel: {
          filters: [
            {
              column: { id: "c:0", name: "city" },
              type: "string" as const,
              predicates: [{ kind: "predicate" as const, operator: "equals" as const, value: "Milan" }]
            }
          ],
          sort: []
        }
      }
    };
    render(
      <OperationBuilder
        metadata={{ ...metadata, latestStepInputSchema: metadata.schema, steps: [initialStep] }}
        filterModel={{
          filters: [],
          sort: [{ column: "sales", direction: "desc", nulls: "last" }]
        }}
        initialStep={initialStep}
        onClose={() => undefined}
        onPreview={onPreview}
      />
    );

    fireEvent.click(screen.getByRole("radio", { name: /Replace it with the current viewing query/u }));
    fireEvent.click(screen.getByRole("button", { name: "Preview changes" }));

    expect(onPreview).toHaveBeenCalledOnce();
  });

  it("surfaces parameter validation failures without previewing", () => {
    const onPreview = vi.fn();
    render(
      <OperationBuilder
        metadata={metadata}
        filterModel={{
          filters: [
            {
              column: "missing",
              type: "string",
              predicates: [{ kind: "predicate", operator: "equals", value: "selected" }]
            }
          ],
          sort: []
        }}
        initialKind="filterRows"
        onClose={() => undefined}
        onPreview={onPreview}
      />
    );

    fireEvent.click(screen.getByRole("button", { name: "Preview changes" }));
    expect(screen.getByRole("alert")).toHaveTextContent("Viewing query column");
    expect(onPreview).not.toHaveBeenCalled();
  });

  it("uses stable duplicate-safe references when adding and editing row sorts", () => {
    const onPreview = vi.fn();
    const duplicateColumns = [
      { ...metadata.schema[0], id: "c:0", name: "value", position: 0 },
      { ...metadata.schema[1], id: "c:1", name: "value", position: 1 }
    ];
    render(
      <OperationBuilder
        metadata={{
          ...metadata,
          schema: duplicateColumns,
          latestStepInputSchema: duplicateColumns,
          steps: [
            {
              id: "sort-second",
              kind: "sortRows",
              params: { rules: [{ column: { id: "c:1", name: "value" }, direction: "desc", nulls: "first" }] }
            }
          ]
        }}
        filterModel={{ filters: [], sort: [] }}
        initialStep={{
          id: "sort-second",
          kind: "sortRows",
          params: { rules: [{ column: { id: "c:1", name: "value" }, direction: "desc", nulls: "first" }] }
        }}
        onClose={() => undefined}
        onPreview={onPreview}
      />
    );

    expect(screen.getByRole("option", { name: "value, column 1" })).toHaveValue("c:0");
    expect((screen.getByRole("option", { name: "value, column 2" }) as HTMLOptionElement).selected).toBe(true);
    fireEvent.click(screen.getByRole("button", { name: "Preview changes" }));
    expect(onPreview).toHaveBeenCalledOnce();
  });

  it("reorders and removes individual sort rows without losing the retained values", () => {
    const onPreview = vi.fn();
    render(
      <OperationBuilder
        metadata={metadata}
        filterModel={{ filters: [], sort: [] }}
        initialKind="sortRows"
        onClose={() => undefined}
        onPreview={onPreview}
      />
    );

    expect(screen.getByRole("button", { name: "Remove sort rule 1" })).toBeDisabled();
    fireEvent.click(screen.getByRole("button", { name: "Add sort column" }));
    fireEvent.change(screen.getByLabelText("Column 2"), { target: { value: "c:1" } });
    fireEvent.change(screen.getAllByLabelText("Direction")[1], { target: { value: "desc" } });
    fireEvent.click(screen.getByRole("button", { name: "Move sort rule 2 up" }));
    expect(screen.getByLabelText("Column 1")).toHaveValue("c:1");
    expect(screen.getByLabelText("Column 2")).toHaveValue("c:0");
    fireEvent.click(screen.getByRole("button", { name: "Preview changes" }));
    expect(onPreview).toHaveBeenCalledTimes(1);

    fireEvent.click(screen.getByRole("button", { name: "Remove sort rule 2" }));
    expect(screen.queryByLabelText("Column 2")).not.toBeInTheDocument();
    expect(screen.getByLabelText("Column 1")).toHaveValue("c:1");
    fireEvent.click(screen.getByRole("button", { name: "Preview changes" }));
    expect(onPreview).toHaveBeenCalledTimes(2);
  });

  it("uses stable duplicate-safe references for drop-duplicates columns", () => {
    const onPreview = vi.fn();
    const duplicateColumns = [
      { ...metadata.schema[0], id: "c:0", name: "value", position: 0 },
      { ...metadata.schema[1], id: "c:1", name: "value", position: 1 }
    ];
    render(
      <OperationBuilder
        metadata={{ ...metadata, schema: duplicateColumns }}
        filterModel={{ filters: [], sort: [] }}
        initialKind="dropDuplicates"
        onClose={() => undefined}
        onPreview={onPreview}
      />
    );

    fireEvent.click(screen.getByRole("checkbox", { name: "value, column 2" }));
    expect(screen.getByRole("checkbox", { name: "value, column 2" })).toBeChecked();
    fireEvent.click(screen.getByRole("button", { name: "Preview changes" }));
    expect(onPreview).toHaveBeenCalledOnce();
  });

  it("edits structural steps against their original input schema", () => {
    render(
      <OperationBuilder
        metadata={{
          ...metadata,
          schema: [metadata.schema[1]],
          latestStepInputSchema: metadata.schema,
          steps: [{ id: "drop-city", kind: "dropColumns", params: { columns: [{ id: "c:0", name: "city" }] } }]
        }}
        filterModel={{ filters: [], sort: [] }}
        initialStep={{
          id: "drop-city",
          kind: "dropColumns",
          params: { columns: [{ id: "c:0", name: "city" }] }
        }}
        onClose={() => undefined}
        onPreview={() => undefined}
      />
    );

    expect(screen.getByRole("checkbox", { name: "city" })).toBeChecked();
  });

  it("fails closed when a saved step has no recorded input schema while leaving cancel usable", () => {
    const onClose = vi.fn();
    const onPreview = vi.fn();
    const initialStep: TransformStep = {
      id: "rename-city",
      kind: "renameColumn",
      params: { column: { id: "c:0", name: "city" }, newName: "location" }
    };
    render(
      <OperationBuilder
        metadata={{ ...metadata, steps: [initialStep] }}
        filterModel={{ filters: [], sort: [] }}
        initialStep={initialStep}
        onClose={onClose}
        onPreview={onPreview}
      />
    );

    expect(screen.getByRole("alert")).toHaveTextContent("recorded input schema is unavailable");
    expect(screen.getByRole("alert")).toHaveTextContent("Cancel editing, then reload the session");
    const preview = screen.getByRole("button", { name: "Preview changes" });
    expect(preview).toBeDisabled();
    fireEvent.submit(preview.closest("form") as HTMLFormElement);
    expect(onPreview).not.toHaveBeenCalled();
    const cancel = screen.getByRole("button", { name: "Cancel" });
    cancel.focus();
    expect(cancel).toHaveFocus();
    fireEvent.click(cancel);
    expect(onClose).toHaveBeenCalledOnce();
  });

  it("keeps unique labels plain while disambiguating duplicates, empty labels, and display collisions", () => {
    const onPreview = vi.fn();
    const duplicateColumns = [
      { ...metadata.schema[0], id: "c:0", name: "value", position: 0 },
      { ...metadata.schema[1], id: "c:1", name: "value", position: 1 },
      { ...metadata.schema[0], id: "c:2", name: "", position: 2 },
      { ...metadata.schema[0], id: "c:3", name: "(empty name)", position: 3 },
      { ...metadata.schema[0], id: "c:4", name: "value, column 1", position: 4 }
    ];
    render(
      <OperationBuilder
        metadata={{
          ...metadata,
          schema: duplicateColumns,
          latestStepInputSchema: duplicateColumns,
          steps: [
            {
              id: "rename-second",
              kind: "renameColumn",
              params: { column: { id: "c:1", name: "value" }, newName: "second_value" }
            }
          ]
        }}
        filterModel={{ filters: [], sort: [] }}
        initialStep={{
          id: "rename-second",
          kind: "renameColumn",
          params: { column: { id: "c:1", name: "value" }, newName: "second_value" }
        }}
        onClose={() => undefined}
        onPreview={onPreview}
      />
    );

    const first = screen.getByRole("option", { name: "value, source column 1" }) as HTMLOptionElement;
    const second = screen.getByRole("option", { name: "value, column 2" }) as HTMLOptionElement;
    expect(first).toHaveValue("c:0");
    expect(second).toHaveValue("c:1");
    expect(first.selected).toBe(false);
    expect(second.selected).toBe(true);
    expect(screen.getByRole("option", { name: "(empty name), column 3" })).toHaveValue("c:2");
    expect(screen.getByRole("option", { name: "(empty name)" })).toHaveValue("c:3");
    expect(screen.getByRole("option", { name: "value, column 1" })).toHaveValue("c:4");

    fireEvent.click(screen.getByRole("button", { name: "Preview changes" }));
    expect(onPreview).toHaveBeenCalledOnce();
  });

  it("keeps every visible label unique when source names imitate positional fallbacks", () => {
    const columns = [
      { ...metadata.schema[0], id: "c:0", name: "value", position: 0 },
      { ...metadata.schema[1], id: "c:1", name: "value", position: 1 },
      { ...metadata.schema[0], id: "c:2", name: "other_a", position: 2 },
      { ...metadata.schema[0], id: "c:3", name: "other_b", position: 3 },
      { ...metadata.schema[0], id: "c:4", name: "value, column 1", position: 4 },
      { ...metadata.schema[0], id: "c:5", name: "value, column 1, column 5", position: 5 },
      { ...metadata.schema[0], id: "c:6", name: "value, source column 1", position: 6 },
      { ...metadata.schema[0], id: "c:7", name: "value, source column 1 (2)", position: 7 }
    ];
    render(
      <OperationBuilder
        metadata={{
          ...metadata,
          schema: columns,
          shape: { rows: 2, columns: columns.length },
          filteredShape: { rows: 2, columns: columns.length }
        }}
        filterModel={{ filters: [], sort: [] }}
        initialKind="renameColumn"
        onClose={() => undefined}
        onPreview={() => undefined}
      />
    );

    const options = screen.getAllByRole("option");
    const visibleLabels = options.map((option) => option.textContent);
    expect(new Set(visibleLabels).size).toBe(visibleLabels.length);
    expect(screen.getByRole("option", { name: "value, source column 1 (3)" })).toHaveValue("c:0");
    expect(screen.getByRole("option", { name: "value, column 1" })).toHaveValue("c:4");
    expect(screen.getByRole("option", { name: "value, column 1, column 5" })).toHaveValue("c:5");
    expect(screen.getByRole("option", { name: "value, source column 1" })).toHaveValue("c:6");
    expect(screen.getByRole("option", { name: "value, source column 1 (2)" })).toHaveValue("c:7");
  });

  it("switches Formula between scalar and column operand controls", () => {
    const onPreview = vi.fn();
    const numericMetadata = {
      ...metadata,
      schema: [{ ...metadata.schema[0], name: "units", rawType: "Int64", type: "integer" as const }, metadata.schema[1]]
    };
    render(
      <OperationBuilder
        metadata={numericMetadata}
        filterModel={{ filters: [], sort: [] }}
        initialKind="formula"
        onClose={() => undefined}
        onPreview={onPreview}
      />
    );

    const numericValue = screen.getByLabelText("Numeric value");
    expect(numericValue).toHaveAttribute("step", "any");
    fireEvent.change(screen.getByLabelText("Left column"), { target: { value: "c:1" } });
    fireEvent.change(numericValue, { target: { value: "1.1" } });
    fireEvent.change(screen.getByLabelText("New column"), { target: { value: "projected_sales" } });
    expect(numericValue).toBeValid();
    fireEvent.click(screen.getByRole("button", { name: "Preview changes" }));
    expect(onPreview).toHaveBeenCalledOnce();

    onPreview.mockClear();
    fireEvent.change(screen.getByLabelText("Right operand"), { target: { value: "column" } });
    expect(screen.queryByLabelText("Numeric value")).not.toBeInTheDocument();
    fireEvent.change(screen.getByLabelText("Right column"), { target: { value: "c:0" } });
    fireEvent.change(screen.getByLabelText("New column"), { target: { value: "ratio" } });
    fireEvent.click(screen.getByRole("button", { name: "Preview changes" }));
    expect(onPreview).toHaveBeenCalledOnce();
  });

  it("rejects an empty or non-finite Formula scalar before preview", () => {
    const onPreview = vi.fn();
    render(
      <OperationBuilder
        metadata={metadata}
        filterModel={{ filters: [], sort: [] }}
        initialKind="formula"
        onClose={() => undefined}
        onPreview={onPreview}
      />
    );

    const value = screen.getByLabelText("Numeric value");
    expect(value).toBeRequired();
    fireEvent.change(screen.getByLabelText("New column"), { target: { value: "formula_result" } });
    fireEvent.change(value, { target: { value: "" } });
    fireEvent.click(screen.getByRole("button", { name: "Preview changes" }));
    expect(onPreview).not.toHaveBeenCalled();

    fireEvent.change(value, { target: { value: "1e309" } });
    fireEvent.submit(screen.getByRole("button", { name: "Preview changes" }).closest("form") as HTMLFormElement);
    expect(onPreview).not.toHaveBeenCalled();
    expect(screen.getByRole("alert")).toBeInTheDocument();
  });

  it("shows and enforces the native R datetime-format limit before preview", () => {
    const onPreview = vi.fn();
    const dateColumn = {
      ...metadata.schema[0],
      id: "c:date",
      name: "event_date",
      type: "date" as const,
      rawType: "Date"
    };
    render(
      <OperationBuilder
        metadata={{
          ...metadata,
          backend: "r",
          rDataframeFlavor: "r.data.frame",
          schema: [dateColumn]
        }}
        filterModel={{ filters: [], sort: [] }}
        initialKind="formatDatetime"
        onClose={() => undefined}
        onPreview={onPreview}
      />
    );

    const format = screen.getByLabelText("strftime format");
    expect(format).toHaveAccessibleDescription("Native R datetime formats can use up to 8,192 UTF-8 bytes.");
    fireEvent.input(format, { target: { value: "🙂".repeat(3_000) } });
    expect(format).toBeInvalid();
    fireEvent.click(screen.getByRole("button", { name: "Preview changes" }));
    expect(onPreview).not.toHaveBeenCalled();

    fireEvent.input(format, { target: { value: "%Y-%m-%d" } });
    expect(format).toBeValid();
    fireEvent.click(screen.getByRole("button", { name: "Preview changes" }));
    expect(onPreview).toHaveBeenCalledOnce();
  });

  it.each([
    ["selectColumns", "Columns to keep"],
    ["dropColumns", "Columns to drop"]
  ] as const)("emits reference lists for %s", (kind, label) => {
    const structuralPreview = vi.fn();
    render(
      <OperationBuilder
        metadata={metadata}
        filterModel={{ filters: [], sort: [] }}
        initialKind={kind}
        onClose={() => undefined}
        onPreview={structuralPreview}
      />
    );

    const structuralSelection = screen.getByRole("group", { name: label });
    fireEvent.click(within(structuralSelection).getByRole("checkbox", { name: "city" }));
    fireEvent.click(within(structuralSelection).getByRole("checkbox", { name: "sales" }));
    expect(within(structuralSelection).getByRole("checkbox", { name: "city" })).toBeChecked();
    expect(within(structuralSelection).getByRole("checkbox", { name: "sales" })).toBeChecked();
    fireEvent.click(screen.getByRole("button", { name: "Preview changes" }));
    expect(structuralPreview).toHaveBeenCalledOnce();
  });

  it("preserves an existing select-columns order when previewed unchanged", () => {
    const onPreview = vi.fn();
    render(
      <OperationBuilder
        metadata={{
          ...metadata,
          latestStepInputSchema: metadata.schema,
          steps: [
            {
              id: "reverse-columns",
              kind: "selectColumns",
              params: {
                columns: [
                  { id: "c:1", name: "sales" },
                  { id: "c:0", name: "city" }
                ]
              }
            }
          ]
        }}
        filterModel={{ filters: [], sort: [] }}
        initialStep={{
          id: "reverse-columns",
          kind: "selectColumns",
          params: {
            columns: [
              { id: "c:1", name: "sales" },
              { id: "c:0", name: "city" }
            ]
          }
        }}
        onClose={() => undefined}
        onPreview={onPreview}
      />
    );

    expect(screen.getByText("Selected order: sales → city")).toBeInTheDocument();
    expect(screen.getByRole("group", { name: "Columns to keep" })).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Preview changes" }));
    expect(onPreview).toHaveBeenCalledOnce();
  });

  it("records select-columns choices in interaction order", () => {
    const onPreview = vi.fn();
    render(
      <OperationBuilder
        metadata={metadata}
        filterModel={{ filters: [], sort: [] }}
        initialKind="selectColumns"
        onClose={() => undefined}
        onPreview={onPreview}
      />
    );

    const selection = screen.getByRole("group", { name: "Columns to keep" });
    fireEvent.click(within(selection).getByRole("checkbox", { name: "sales" }));
    fireEvent.click(within(selection).getByRole("checkbox", { name: "city" }));
    expect(screen.getByText("Selected order: sales → city")).toBeInTheDocument();
    expect(selection).toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: "Preview changes" }));
    expect(onPreview).toHaveBeenCalledOnce();
  });

  it("edits a categorical reference list by stable ID when labels are duplicated", () => {
    const categoricalPreview = vi.fn();
    const duplicateColumns = [
      { ...metadata.schema[0], id: "c:0", name: "value", position: 0 },
      { ...metadata.schema[1], id: "c:1", name: "value", position: 1 }
    ];
    const initialStep: TransformStep = {
      id: "encode-second-value",
      kind: "oneHotEncode",
      params: {
        columns: [{ id: "c:1", name: "value" }],
        prefixSeparator: "",
        dropOriginal: true
      }
    };
    render(
      <OperationBuilder
        metadata={{
          ...metadata,
          schema: duplicateColumns,
          latestStepInputSchema: duplicateColumns,
          steps: [initialStep]
        }}
        filterModel={{ filters: [], sort: [] }}
        initialStep={initialStep}
        onClose={() => undefined}
        onPreview={categoricalPreview}
      />
    );
    const categoricalSelection = screen.getByRole("group", { name: "Categorical columns" });
    expect(within(categoricalSelection).getByRole("checkbox", { name: "value, column 1" })).not.toBeChecked();
    expect(within(categoricalSelection).getByRole("checkbox", { name: "value, column 2" })).toBeChecked();
    fireEvent.click(screen.getByRole("button", { name: "Preview changes" }));
    expect(categoricalPreview).toHaveBeenCalledOnce();
  });

  it("authors one-hot encoding with an intentionally empty prefix separator", () => {
    const onPreview = vi.fn();
    render(
      <OperationBuilder
        metadata={metadata}
        filterModel={{ filters: [], sort: [] }}
        initialKind="oneHotEncode"
        onClose={() => undefined}
        onPreview={onPreview}
      />
    );

    fireEvent.click(screen.getByRole("checkbox", { name: "city" }));
    fireEvent.change(screen.getByLabelText("Prefix separator"), { target: { value: "" } });
    fireEvent.click(screen.getByRole("button", { name: "Preview changes" }));

    expect(onPreview).toHaveBeenCalledOnce();
  });

  it("round-trips an intentionally empty multi-label output prefix", () => {
    const onPreview = vi.fn();
    const initialStep: TransformStep = {
      id: "labels-without-prefix",
      kind: "multiLabelBinarize",
      params: {
        column: { id: "c:0", name: "city" },
        delimiter: ",",
        prefix: "",
        dropOriginal: false
      }
    };
    render(
      <OperationBuilder
        metadata={{ ...metadata, latestStepInputSchema: metadata.schema, steps: [initialStep] }}
        filterModel={{ filters: [], sort: [] }}
        initialStep={initialStep}
        onClose={() => undefined}
        onPreview={onPreview}
      />
    );

    expect(screen.getByLabelText("Output prefix mode")).toHaveValue("custom");
    expect(screen.getByLabelText("Custom output prefix")).toHaveValue("");
    fireEvent.click(screen.getByRole("button", { name: "Preview changes" }));
    expect(onPreview).toHaveBeenCalledOnce();
  });

  it("authors and edits a find/replace step with an empty find pattern", () => {
    const onPreview = vi.fn();
    const initialStep: TransformStep = {
      id: "replace-empty-boundaries",
      kind: "findReplace",
      params: {
        column: { id: "c:0", name: "city" },
        find: "",
        replacement: "-",
        regex: false
      }
    };
    render(
      <OperationBuilder
        metadata={{ ...metadata, latestStepInputSchema: metadata.schema, steps: [initialStep] }}
        filterModel={{ filters: [], sort: [] }}
        initialStep={initialStep}
        onClose={() => undefined}
        onPreview={onPreview}
      />
    );

    expect(screen.getByLabelText("Find (blank matches empty boundaries)")).toHaveValue("");
    fireEvent.click(screen.getByRole("button", { name: "Preview changes" }));
    expect(onPreview).toHaveBeenCalledOnce();
  });

  it.each([
    ["omitted", undefined],
    ["null", null]
  ] as const)("preserves default whitespace stripping when characters is %s", (_caseName, characters) => {
    const onPreview = vi.fn();
    const initialStep: TransformStep = {
      id: `strip-${_caseName}`,
      kind: "stripText",
      params: {
        column: { id: "c:0", name: "city" },
        ...(characters === null ? { characters } : {})
      }
    };
    render(
      <OperationBuilder
        metadata={{ ...metadata, latestStepInputSchema: metadata.schema, steps: [initialStep] }}
        filterModel={{ filters: [], sort: [] }}
        initialStep={initialStep}
        onClose={() => undefined}
        onPreview={onPreview}
      />
    );

    expect(screen.getByLabelText("Characters (blank means whitespace)")).toHaveValue("");
    fireEvent.click(screen.getByRole("button", { name: "Preview changes" }));
    expect(onPreview).toHaveBeenCalledOnce();
  });

  it.each([
    {
      label: "Labels column",
      step: {
        id: "labels",
        kind: "multiLabelBinarize",
        params: { column: { id: "c:1", name: "value" }, delimiter: ",", dropOriginal: false }
      }
    },
    {
      label: "Text column",
      step: {
        id: "replace",
        kind: "findReplace",
        params: {
          column: { id: "c:1", name: "value" },
          find: "before",
          replacement: "after",
          regex: false
        }
      }
    },
    {
      label: "Text column",
      step: {
        id: "strip",
        kind: "stripText",
        params: { column: { id: "c:1", name: "value" } }
      }
    },
    {
      label: "Text column",
      step: {
        id: "split",
        kind: "splitText",
        params: { column: { id: "c:1", name: "value" }, delimiter: ",", index: 0, newColumn: "part" }
      }
    },
    ...(["capitalizeText", "lowerText", "upperText"] as const).map((kind) => ({
      label: "Text column",
      step: {
        id: kind,
        kind,
        params: { column: { id: "c:1", name: "value" }, newColumn: `${kind}_result` }
      }
    })),
    ...(["minMaxScale", "floorNumber", "ceilNumber"] as const).map((kind) => ({
      label: "Numeric column",
      step: {
        id: kind,
        kind,
        params: { column: { id: "c:1", name: "value" }, newColumn: `${kind}_result` }
      }
    })),
    {
      label: "Numeric column",
      step: {
        id: "round",
        kind: "roundNumber",
        params: { column: { id: "c:1", name: "value" }, decimals: 2, newColumn: "rounded" }
      }
    },
    {
      label: "Date or datetime column",
      step: {
        id: "format",
        kind: "formatDatetime",
        params: { column: { id: "c:1", name: "value" }, format: "%Y-%m-%d", newColumn: "formatted" }
      }
    }
  ] satisfies { label: string; step: TransformStep }[])(
    "edits $step.kind by saved column ID instead of a duplicate label",
    ({ label, step }) => {
      const onPreview = vi.fn();
      const columnType =
        step.kind === "formatDatetime"
          ? ("datetime" as const)
          : [
                "multiLabelBinarize",
                "findReplace",
                "stripText",
                "splitText",
                "capitalizeText",
                "lowerText",
                "upperText"
              ].includes(step.kind)
            ? ("string" as const)
            : ("float" as const);
      const duplicateColumns = [
        { ...metadata.schema[0], id: "c:0", name: "value", position: 0, type: columnType },
        { ...metadata.schema[1], id: "c:1", name: "value", position: 1, type: columnType }
      ];
      render(
        <OperationBuilder
          metadata={{
            ...metadata,
            schema: duplicateColumns,
            latestStepInputSchema: duplicateColumns,
            steps: [step]
          }}
          filterModel={{ filters: [], sort: [] }}
          initialStep={step}
          onClose={() => undefined}
          onPreview={onPreview}
        />
      );

      const columnSelect = screen.getByLabelText(label) as HTMLSelectElement;
      expect(columnSelect.value).toBe("c:1");
      expect(Array.from(columnSelect.options, (option) => option.text)).toEqual(["value, column 1", "value, column 2"]);
      fireEvent.click(screen.getByRole("button", { name: "Preview changes" }));
      expect(onPreview).toHaveBeenCalledOnce();
    }
  );

  it("shows by-example defaults and surfaces malformed JSON before preview", () => {
    const onPreview = vi.fn();
    render(
      <OperationBuilder
        metadata={metadata}
        filterModel={{ filters: [], sort: [] }}
        initialKind="byExample"
        onClose={() => undefined}
        onPreview={onPreview}
      />
    );

    expect(screen.getByLabelText(/Examples \(JSON\)/)).toHaveValue(
      JSON.stringify(
        [
          { inputs: ["DACH-DE-00482"], output: "DE" },
          { inputs: ["NORDICS-SE-01940"], output: "SE" }
        ],
        null,
        2
      )
    );
    fireEvent.change(screen.getByLabelText(/Examples \(JSON\)/), { target: { value: "not json" } });
    fireEvent.click(screen.getByRole("button", { name: "Preview changes" }));
    expect(screen.getByRole("alert")).toBeInTheDocument();
    expect(onPreview).not.toHaveBeenCalled();

    const valid = [
      { inputs: ["Milan"], output: "MILAN" },
      { inputs: ["Paris"], output: "PARIS" }
    ];
    fireEvent.change(screen.getByLabelText(/Examples \(JSON\)/), { target: { value: JSON.stringify(valid) } });
    fireEvent.click(screen.getByRole("button", { name: "Preview changes" }));
    expect(onPreview).toHaveBeenCalledOnce();
  });

  it("builds group keys and repeated aggregation values from stable duplicate-safe identities", () => {
    const onPreview = vi.fn();
    const columns = [
      { ...metadata.schema[0], id: "c:0", name: "value", position: 0 },
      { ...metadata.schema[1], id: "c:1", name: "value", position: 1 },
      { ...metadata.schema[0], id: "c:2", name: "", position: 2 },
      { ...metadata.schema[1], id: "c:3", name: "7", position: 3 }
    ];
    render(
      <OperationBuilder
        metadata={{ ...metadata, schema: columns }}
        filterModel={{ filters: [], sort: [] }}
        initialKind="groupBy"
        onClose={() => undefined}
        onPreview={onPreview}
      />
    );

    const keys = screen.getByRole("group", { name: "Group keys" });
    for (const label of ["value, column 1", "value, column 2", "(empty name), column 3", "7"]) {
      expect(within(keys).getByRole("checkbox", { name: label })).toBeInTheDocument();
    }
    fireEvent.click(within(keys).getByRole("checkbox", { name: "value, column 2" }));
    const value = screen.getByLabelText("Value 1") as HTMLSelectElement;
    fireEvent.change(value, { target: { value: "c:3" } });
    fireEvent.change(screen.getByLabelText("Output name"), { target: { value: "total" } });
    fireEvent.click(screen.getByRole("button", { name: "Add aggregation" }));
    fireEvent.change(screen.getByLabelText("Value 2"), { target: { value: "c:3" } });
    const aliases = screen.getAllByLabelText("Output name") as HTMLInputElement[];
    fireEvent.change(aliases[1], { target: { value: "average" } });
    fireEvent.change(screen.getByLabelText("Calculation 2"), { target: { value: "mean" } });
    expect(screen.getByLabelText("Value 1")).toHaveValue("c:3");
    expect(screen.getByLabelText("Value 2")).toHaveValue("c:3");
    expect(screen.getByLabelText("Calculation 1")).toHaveValue("sum");
    expect(screen.getByLabelText("Calculation 2")).toHaveValue("mean");
    fireEvent.click(screen.getByRole("button", { name: "Preview changes" }));
    expect(onPreview).toHaveBeenCalledOnce();
  });

  it("filters group inputs by portable type and keeps aggregation rows removable and reorderable", () => {
    const onPreview = vi.fn();
    const columns = [
      metadata.schema[0],
      metadata.schema[1],
      {
        id: "c:2",
        name: "when",
        position: 2,
        rawType: "Datetime",
        type: "datetime" as const,
        nullable: false
      },
      {
        id: "c:3",
        name: "items",
        position: 3,
        rawType: "List(String)",
        type: "list" as const,
        nullable: true
      }
    ];
    render(
      <OperationBuilder
        metadata={{ ...metadata, schema: columns, shape: { rows: 2, columns: columns.length } }}
        filterModel={{ filters: [], sort: [] }}
        initialKind="groupBy"
        onClose={() => undefined}
        onPreview={onPreview}
      />
    );

    const keys = screen.getByRole("group", { name: "Group keys" });
    expect(within(keys).getByRole("checkbox", { name: "city" })).toBeInTheDocument();
    expect(within(keys).queryByRole("checkbox", { name: "items" })).not.toBeInTheDocument();
    fireEvent.click(within(keys).getByRole("checkbox", { name: "city" }));

    expect(
      Array.from((screen.getByLabelText("Value 1") as HTMLSelectElement).options, (option) => option.value)
    ).toEqual(["c:1"]);
    fireEvent.change(screen.getByLabelText("Calculation 1"), { target: { value: "count" } });
    expect(
      Array.from((screen.getByLabelText("Value 1") as HTMLSelectElement).options, (option) => option.value)
    ).toEqual(["c:0", "c:1", "c:2"]);
    fireEvent.change(screen.getByLabelText("Value 1"), { target: { value: "c:0" } });
    fireEvent.change(screen.getByLabelText("Output name"), { target: { value: "city_count" } });

    fireEvent.click(screen.getByRole("button", { name: "Add aggregation" }));
    fireEvent.change(screen.getAllByLabelText("Output name")[1], { target: { value: "sales_sum" } });
    fireEvent.click(screen.getByRole("button", { name: "Move aggregation 2 up" }));
    fireEvent.click(screen.getByRole("button", { name: "Remove aggregation 2" }));
    expect(screen.getByLabelText("Value 1")).toHaveValue("c:1");
    expect(screen.getByLabelText("Calculation 1")).toHaveValue("sum");
    expect(screen.getByLabelText("Output name")).toHaveValue("sales_sum");
    expect(screen.getByRole("button", { name: "Remove aggregation 1" })).toBeDisabled();
    fireEvent.click(screen.getByRole("button", { name: "Preview changes" }));
    expect(onPreview).toHaveBeenCalledOnce();
  });

  it.each([
    ["formula", "Left column", ["c:1"]],
    ["textLength", "Text column", ["c:0"]],
    ["upperText", "Text column", ["c:0"]],
    ["roundNumber", "Numeric column", ["c:1"]],
    ["formatDatetime", "Date or datetime column", ["c:2"]]
  ] as const)("shows only compatible columns for %s", (kind, label, expectedIds) => {
    const columns = [
      metadata.schema[0],
      metadata.schema[1],
      {
        id: "c:2",
        name: "when",
        position: 2,
        rawType: "Datetime",
        type: "datetime" as const,
        nullable: false
      },
      {
        id: "c:3",
        name: "items",
        position: 3,
        rawType: "List(String)",
        type: "list" as const,
        nullable: true
      }
    ];
    render(
      <OperationBuilder
        metadata={{ ...metadata, schema: columns, shape: { rows: 2, columns: columns.length } }}
        filterModel={{ filters: [], sort: [] }}
        initialKind={kind}
        onClose={() => undefined}
        onPreview={() => undefined}
      />
    );

    const select = screen.getByLabelText(label) as HTMLSelectElement;
    expect(Array.from(select.options, (option) => option.value)).toEqual(expectedIds);
  });

  it("preserves by-example source interaction order and aligned scalar arrays", () => {
    const onPreview = vi.fn();
    const columns = [
      { ...metadata.schema[0], id: "c:0", name: "value", position: 0 },
      { ...metadata.schema[1], id: "c:1", name: "value", position: 1 },
      { ...metadata.schema[0], id: "c:2", name: "", position: 2 },
      { ...metadata.schema[1], id: "c:3", name: "7", position: 3 }
    ];
    render(
      <OperationBuilder
        metadata={{ ...metadata, schema: columns }}
        filterModel={{ filters: [], sort: [] }}
        initialKind="byExample"
        onClose={() => undefined}
        onPreview={onPreview}
      />
    );

    const sources = screen.getByRole("group", { name: "Source columns" });
    fireEvent.click(within(sources).getByRole("checkbox", { name: "value, column 1" }));
    fireEvent.click(within(sources).getByRole("checkbox", { name: "value, column 2" }));
    fireEvent.click(within(sources).getByRole("checkbox", { name: "7" }));
    expect(screen.getByText("Selected order: value, column 2 → 7")).toBeInTheDocument();
    const examples = [
      { inputs: ["a", 1], output: "a1" },
      { inputs: ["b", 2], output: "b2" }
    ];
    fireEvent.change(screen.getByLabelText(/Examples \(JSON\)/), { target: { value: JSON.stringify(examples) } });
    fireEvent.click(screen.getByRole("button", { name: "Preview changes" }));
    expect(onPreview).toHaveBeenCalledOnce();
  });
});
