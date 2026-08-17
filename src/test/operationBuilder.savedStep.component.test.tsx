import "@testing-library/jest-dom/vitest";
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
  it("blocks an incompatible saved reference before a filtered field can silently retarget it", () => {
    const onPreview = vi.fn();
    const savedStep = {
      id: "saved-incompatible-formula",
      kind: "formula",
      params: {
        leftColumn: { id: "c:1", name: "value" },
        operator: "add",
        value: 1,
        newColumn: "total"
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

    expect(screen.getByRole("alert")).toHaveTextContent("saved left formula column uses a recorded string column");
    expect(screen.queryByLabelText("Left column")).toBeNull();
    const preview = screen.getByRole("button", { name: "Preview changes" });
    expect(preview).toBeDisabled();
    fireEvent.submit(preview.closest("form") as HTMLFormElement);
    expect(onPreview).not.toHaveBeenCalled();
  });

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
