import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import type { SessionMetadata, TransformStep } from "../shared/protocol";
import { OperationBuilder } from "../webviews/operations/OperationBuilder";

const columns = [
  { id: "c:0", name: "value", position: 0, rawType: "String", type: "string", nullable: false },
  { id: "c:1", name: "value", position: 1, rawType: "String", type: "string", nullable: true },
  { id: "c:2", name: "7", position: 2, rawType: "Float64", type: "float", nullable: true }
] satisfies SessionMetadata["schema"];

const metadata: SessionMetadata = {
  protocolVersion: 4,
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
  shape: { rows: 2, columns: columns.length },
  filteredShape: { rows: 2, columns: columns.length },
  filterModel: { filters: [], sort: [] },
  steps: [],
  schema: columns,
  latestStepInputSchema: columns
};

const dateColumn = {
  id: "c:3",
  name: "created_at",
  position: 3,
  rawType: "Datetime",
  type: "datetime",
  nullable: true
} as const;

const compatibleSavedSteps = [
  {
    id: "saved-formula",
    kind: "formula",
    params: {
      leftColumn: { id: "c:2", name: "7" },
      rightColumn: { id: "c:2", name: "7" },
      operator: "add",
      newColumn: "total"
    }
  },
  {
    id: "saved-text-length",
    kind: "textLength",
    params: { column: { id: "c:1", name: "value" }, newColumn: "length" }
  },
  {
    id: "saved-multi-label",
    kind: "multiLabelBinarize",
    params: { column: { id: "c:1", name: "value" }, delimiter: ",", dropOriginal: false }
  },
  {
    id: "saved-find-replace",
    kind: "findReplace",
    params: { column: { id: "c:1", name: "value" }, find: "a", replacement: "b", regex: false }
  },
  { id: "saved-strip", kind: "stripText", params: { column: { id: "c:1", name: "value" } } },
  {
    id: "saved-split",
    kind: "splitText",
    params: { column: { id: "c:1", name: "value" }, delimiter: ",", index: 1, newColumn: "part" }
  },
  { id: "saved-capitalize", kind: "capitalizeText", params: { column: { id: "c:1", name: "value" } } },
  { id: "saved-lower", kind: "lowerText", params: { column: { id: "c:1", name: "value" } } },
  { id: "saved-upper", kind: "upperText", params: { column: { id: "c:1", name: "value" } } },
  {
    id: "saved-rank",
    kind: "denseRank",
    params: { column: { id: "c:2", name: "7" }, direction: "desc", newColumn: "value_rank" }
  },
  { id: "saved-scale", kind: "minMaxScale", params: { column: { id: "c:2", name: "7" } } },
  { id: "saved-round", kind: "roundNumber", params: { column: { id: "c:2", name: "7" }, decimals: 2 } },
  { id: "saved-floor", kind: "floorNumber", params: { column: { id: "c:2", name: "7" } } },
  { id: "saved-ceil", kind: "ceilNumber", params: { column: { id: "c:2", name: "7" } } },
  {
    id: "saved-datetime",
    kind: "formatDatetime",
    params: { column: { id: "c:3", name: "created_at" }, format: "%Y-%m-%d" }
  },
  {
    id: "saved-one-hot",
    kind: "oneHotEncode",
    params: { columns: [{ id: "c:1", name: "value" }], prefixSeparator: "_", dropOriginal: true }
  },
  {
    id: "saved-fill",
    kind: "fillMissingValues",
    params: { column: { id: "c:2", name: "7" }, replacement: { kind: "median" } }
  },
  {
    id: "saved-group-preserved",
    kind: "groupBy",
    params: {
      keys: [{ id: "c:1", name: "value" }],
      aggregations: [{ column: { id: "c:2", name: "7" }, operation: "sum", alias: "total" }]
    }
  }
] satisfies TransformStep[];

describe("OperationBuilder saved-step forms", () => {
  it("selects only List columns and round-trips the exact saved expansion reference", () => {
    const first = {
      id: "c:first-list",
      name: "other",
      position: 3,
      rawType: "List(Int64)",
      type: "list",
      nullable: true
    } as const;
    const selected = { ...first, id: "c:second-list", name: " ^a.*$ 城市 ", position: 4 };
    const inputSchema = [...columns, first, selected];
    const initialStep: TransformStep = {
      id: "saved-explode",
      kind: "explodeList",
      params: { column: { id: selected.id, name: selected.name } }
    };
    const source: SessionMetadata = {
      ...metadata,
      capabilities: { ...metadata.capabilities, supportedOperations: ["explodeList"] }
    };
    const onPreview = vi.fn();
    render(
      <OperationBuilder
        metadata={source}
        filterModel={source.filterModel}
        initialStep={initialStep}
        editInputSchema={inputSchema}
        onClose={() => undefined}
        onPreview={onPreview}
      />
    );
    const selector = screen.getByRole("combobox", { name: "List column" }) as HTMLSelectElement;
    expect(Array.from(selector.options, (option) => option.value)).toEqual([first.id, selected.id]);
    expect(selector).toHaveValue(selected.id);
    expect(screen.getByText(/Empty or null lists keep one row with a missing value/)).toBeVisible();
    expect(screen.getByText(/Fixed-size Array columns are unsupported/)).toBeVisible();
    expect(screen.getByText(/For lazy dataframes, preview first reads the entire input into memory/)).toBeVisible();
    fireEvent.click(screen.getByRole("button", { name: "Preview changes" }));
    expect(onPreview).toHaveBeenCalledExactlyOnceWith(initialStep, initialStep.id);
  });

  it("round-trips exact Struct field rows and refuses unrepresentable saved names", () => {
    const struct = {
      id: "c:struct",
      name: " address ",
      position: 0,
      rawType: "Struct",
      type: "struct",
      nullable: true
    } as const;
    const initialStep: TransformStep = {
      id: "saved-fields",
      kind: "extractStructFields",
      params: {
        column: { id: struct.id, name: struct.name },
        fields: [
          { field: " ^a.*$ ", newColumn: " 城市 " },
          { field: "*", newColumn: "literal.name" }
        ]
      }
    };
    const source = {
      ...metadata,
      capabilities: {
        ...metadata.capabilities,
        supportedOperations: ["extractStructFields"] as ["extractStructFields"]
      }
    };
    const onPreview = vi.fn();
    const view = render(
      <OperationBuilder
        metadata={source}
        filterModel={source.filterModel}
        initialStep={initialStep}
        editInputSchema={[struct]}
        onClose={() => undefined}
        onPreview={onPreview}
      />
    );
    expect(screen.getByRole("textbox", { name: "Field 1" })).toHaveValue(" ^a.*$ ");
    expect(screen.getByRole("textbox", { name: "New column 1" })).toHaveValue(" 城市 ");
    fireEvent.click(screen.getByRole("button", { name: "Preview changes" }));
    expect(onPreview).toHaveBeenCalledWith(initialStep, initialStep.id);
    onPreview.mockClear();
    view.rerender(
      <OperationBuilder
        metadata={source}
        filterModel={source.filterModel}
        initialStep={{
          ...initialStep,
          params: { ...initialStep.params, fields: [{ field: "a\nb", newColumn: "out" }] }
        }}
        editInputSchema={[struct]}
        onClose={() => undefined}
        onPreview={onPreview}
      />
    );
    expect(screen.getByText(/cannot preserve the saved field and output names/)).toBeVisible();
    expect(screen.getByRole("button", { name: "Preview changes" })).toBeDisabled();
    expect(onPreview).not.toHaveBeenCalled();
  });

  it.each([
    {
      savedStep: {
        id: "saved-incompatible-formula",
        kind: "formula",
        params: {
          leftColumn: { id: "c:1", name: "value" },
          operator: "add",
          value: 1,
          newColumn: "total"
        }
      },
      label: "Left column",
      message: "saved left formula column uses a recorded string column"
    },
    {
      savedStep: {
        id: "saved-incompatible-rank",
        kind: "denseRank",
        params: { column: { id: "c:1", name: "value" }, direction: "desc", newColumn: "value_rank" }
      },
      label: "Numeric column",
      message: "this numeric operation requires an integer, float, or decimal column"
    }
  ] satisfies { savedStep: TransformStep; label: string; message: string }[])(
    "blocks an incompatible saved $savedStep.kind reference before a filtered field can silently retarget it",
    ({ savedStep, label, message }) => {
      const onPreview = vi.fn();
      render(
        <OperationBuilder
          metadata={{ ...metadata, steps: [savedStep] }}
          filterModel={{ filters: [], sort: [] }}
          initialStep={savedStep}
          onClose={() => undefined}
          onPreview={onPreview}
        />
      );

      expect(screen.getByRole("alert")).toHaveTextContent(message);
      expect(screen.queryByLabelText(label)).toBeNull();
      const preview = screen.getByRole("button", { name: "Preview changes" });
      expect(preview).toBeDisabled();
      fireEvent.submit(preview.closest("form") as HTMLFormElement);
      expect(onPreview).not.toHaveBeenCalled();
    }
  );

  it.each(compatibleSavedSteps)("preserves an unchanged compatible $kind edit", (savedStep) => {
    const schema = [...columns, dateColumn];
    const onPreview = vi.fn();
    render(
      <OperationBuilder
        metadata={{
          ...metadata,
          shape: { rows: 2, columns: schema.length },
          filteredShape: { rows: 2, columns: schema.length },
          schema,
          latestStepInputSchema: schema,
          steps: [savedStep]
        }}
        filterModel={{ filters: [], sort: [] }}
        initialStep={savedStep}
        onClose={() => undefined}
        onPreview={onPreview}
      />
    );

    fireEvent.click(screen.getByRole("button", { name: "Preview changes" }));
    expect(onPreview).toHaveBeenCalledWith(savedStep, savedStep.id);
  });

  it("edits duplicate marking against the saved input without selecting its derived flag", () => {
    const onPreview = vi.fn();
    const savedStep = {
      id: "saved-mark",
      kind: "markDuplicates",
      params: { columns: [{ id: "c:1", name: "value" }], newColumn: "is_duplicate" }
    } satisfies TransformStep;
    const outputSchema = [
      ...columns,
      {
        id: "c:step:saved-mark:0",
        name: "is_duplicate",
        position: 3,
        rawType: "Boolean",
        type: "boolean",
        nullable: false
      }
    ] satisfies SessionMetadata["schema"];
    render(
      <OperationBuilder
        metadata={{
          ...metadata,
          schema: outputSchema,
          shape: { rows: 2, columns: 4 },
          filteredShape: { rows: 2, columns: 4 },
          latestStepInputSchema: columns,
          steps: [savedStep]
        }}
        filterModel={{ filters: [], sort: [] }}
        initialStep={savedStep}
        onClose={() => undefined}
        onPreview={onPreview}
      />
    );
    expect(screen.getByRole("checkbox", { name: "value, column 2" })).toBeChecked();
    expect(screen.getByRole("checkbox", { name: "value, column 1" })).not.toBeChecked();
    expect(screen.queryByRole("checkbox", { name: "is_duplicate" })).not.toBeInTheDocument();
    expect(screen.getByRole("textbox", { name: "New column" })).toHaveValue("is_duplicate");
    fireEvent.change(screen.getByRole("textbox", { name: "New column" }), { target: { value: "conflict" } });
    fireEvent.click(screen.getByRole("button", { name: "Preview changes" }));
    expect(onPreview).toHaveBeenCalledExactlyOnceWith(
      { ...savedStep, params: { ...savedStep.params, newColumn: "conflict" } },
      savedStep.id
    );
  });

  it("restores saved group references from the recorded input schema", () => {
    const onPreview = vi.fn();
    const savedStep = {
      id: "saved-group",
      kind: "groupBy",
      params: {
        keys: [{ id: "c:1", name: "value" }],
        aggregations: [{ column: { id: "c:2", name: "7" }, operation: "sum", alias: "total" }]
      }
    } satisfies TransformStep;

    render(
      <OperationBuilder
        metadata={{ ...metadata, steps: [savedStep] }}
        filterModel={{ filters: [], sort: [] }}
        initialStep={savedStep}
        onClose={() => undefined}
        onPreview={onPreview}
      />
    );

    expect(screen.getByText("Selected order: value, column 2")).toBeInTheDocument();
    expect(screen.getByLabelText("Value 1")).toHaveValue("c:2");
    fireEvent.click(screen.getByRole("button", { name: "Preview changes" }));
    expect(onPreview).toHaveBeenCalledOnce();
  });

  it("restores saved by-example source IDs without retaining synthesis-only fields", () => {
    const onPreview = vi.fn();
    const savedStep = {
      id: "saved-example",
      kind: "byExample",
      params: {
        sourceColumns: [{ id: "c:1", name: "value" }],
        newColumn: "upper",
        examples: [
          { inputs: ["a"], output: "A" },
          { inputs: ["b"], output: "B" }
        ],
        program: { kind: "case", style: "upper", input: { kind: "column", column: { id: "c:1", name: "value" } } },
        warnings: ["Ambiguous examples: preview carefully."],
        candidateCount: 2
      }
    } satisfies TransformStep;

    render(
      <OperationBuilder
        metadata={{ ...metadata, steps: [savedStep] }}
        filterModel={{ filters: [], sort: [] }}
        initialStep={savedStep}
        onClose={() => undefined}
        onPreview={onPreview}
      />
    );

    expect(screen.getByText("Selected order: value, column 2")).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Preview changes" }));
    expect(onPreview).toHaveBeenCalledWith(
      {
        id: savedStep.id,
        kind: savedStep.kind,
        params: {
          sourceColumns: savedStep.params.sourceColumns,
          newColumn: savedStep.params.newColumn,
          examples: savedStep.params.examples
        }
      },
      savedStep.id
    );
  });
});
